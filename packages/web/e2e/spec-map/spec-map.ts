import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { Bundle } from './bundle.ts'
import type { ModuleFacts } from './module-graph.ts'
import { compiledFunctions } from './v8-log.ts'

/**
 * The spec map: each cockpit source file and the browser specs that run it
 * (hearsay-tools/cezarion#1816). `npm run test:e2e:affected` reads it to choose specs for a diff.
 *
 * A capture shard writes a partial map from its V8 logs; the merge job joins the shards, adds the
 * reach of exported values and top-level statements (module-graph.ts) and validates the result.
 */

export const SPEC_DIR = 'packages/web/e2e'

export type SpecStatus = 'passed' | 'failed'

export interface SpecEvidence {
  status: SpecStatus
  /** Repository files at least one of whose functions ran in this spec. */
  executed: string[]
  /** Repository files in every script this spec loaded. */
  loaded: string[]
}

export interface PartialMap {
  version: 1
  specs: Record<string, SpecEvidence>
}

export interface SpecMap {
  version: 1
  /** The commit the evidence describes. The selector diffs the working tree against it. */
  commit: string
  createdAt: string
  /** Every spec the refresh ran, as repository paths; `sources` holds indexes into it. */
  specs: string[]
  /** Specs that failed or left no browser log: their evidence is partial, so they always run. */
  incomplete: string[]
  /** Each repository file in the bundle and the specs that reach it; `[]` when none does. */
  sources: Record<string, number[]>
}

/** Spec statuses from a Vitest JSON report, keyed by repository path. */
export function specStatuses(report: unknown, repoRoot: string): Map<string, SpecStatus> {
  const results = (report as { testResults?: Array<{ name?: unknown; status?: unknown }> }).testResults
  if (!Array.isArray(results)) throw new Error('the Vitest JSON report has no testResults')
  const statuses = new Map<string, SpecStatus>()
  for (const { name, status } of results) {
    if (typeof name !== 'string' || !name.startsWith(`${repoRoot}/`)) continue
    statuses.set(name.slice(repoRoot.length + 1), status === 'passed' ? 'passed' : 'failed')
  }
  return statuses
}

/** What one spec's V8 logs show it ran. `logDir` holds one directory per spec, named by its basename. */
export function specEvidence(logDir: string, spec: string, bundle: Bundle): Omit<SpecEvidence, 'status'> {
  const dir = join(logDir, basename(spec, '.e2e.ts'))
  const executed = new Set<string>()
  const loaded = new Set<string>()
  for (const log of existsSync(dir) ? readdirSync(dir) : []) {
    for (const fn of compiledFunctions(readFileSync(join(dir, log), 'utf8'))) {
      const pathname = new URL(fn.url).pathname
      if (!bundle.has(pathname)) continue
      for (const source of bundle.sourcesOf(pathname)) loaded.add(source)
      // Offset 0 is the script itself, which V8 also compiles: it names no function.
      const source = fn.start > 0 ? bundle.sourceAt(pathname, fn.start) : null
      if (source) executed.add(source)
    }
  }
  return { executed: [...executed].sort(), loaded: [...loaded].sort() }
}

export function partialMap(logDir: string, statuses: Map<string, SpecStatus>, bundle: Bundle): PartialMap {
  if (statuses.size === 0) throw new Error('the Vitest report names no spec, so the shard captured nothing')
  const specs: Record<string, SpecEvidence> = {}
  for (const [spec, status] of [...statuses].sort(([a], [b]) => a.localeCompare(b))) {
    specs[spec] = { status, ...specEvidence(logDir, spec, bundle) }
  }
  return { version: 1, specs }
}

/** Joins shard maps; a spec in two shards or a spec no shard ran is an error. */
export function joinPartials(partials: PartialMap[], specFiles: string[]): Record<string, SpecEvidence> {
  const joined: Record<string, SpecEvidence> = {}
  for (const partial of partials) {
    for (const [spec, evidence] of Object.entries(partial.specs)) {
      if (joined[spec]) throw new Error(`${spec} appears in two capture shards`)
      joined[spec] = evidence
    }
  }
  const missing = specFiles.filter((spec) => !joined[spec])
  if (missing.length > 0) throw new Error(`no capture shard ran ${missing.join(', ')}`)
  return joined
}

function indexSets(specs: string[], evidence: Record<string, SpecEvidence>, key: 'executed' | 'loaded') {
  const sets = new Map<string, Set<number>>()
  specs.forEach((spec, index) => {
    for (const source of evidence[spec]?.[key] ?? []) {
      const set = sets.get(source) ?? new Set<number>()
      set.add(index)
      sets.set(source, set)
    }
  })
  return sets
}

/**
 * Each source's specs: those that ran one of its functions, plus every spec that loaded it when it
 * has a top-level statement, plus the specs of its importers when it exports a value. The last rule
 * repeats until nothing changes, so a value passed through a barrel or another value still counts.
 */
export function reach(
  specs: string[],
  evidence: Record<string, SpecEvidence>,
  graph: Map<string, ModuleFacts>,
): Map<string, Set<number>> {
  const executed = indexSets(specs, evidence, 'executed')
  const loaded = indexSets(specs, evidence, 'loaded')
  const result = new Map<string, Set<number>>()
  for (const source of new Set([...loaded.keys(), ...executed.keys()])) {
    const set = new Set(executed.get(source))
    if (graph.get(source)?.topLevelEffect) for (const index of loaded.get(source) ?? []) set.add(index)
    result.set(source, set)
  }
  const importers = new Map<string, string[]>()
  for (const [path, facts] of graph) {
    for (const imported of facts.imports) importers.set(imported, [...(importers.get(imported) ?? []), path])
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const [source, set] of result) {
      if (!graph.get(source)?.exportsValue) continue
      for (const importer of importers.get(source) ?? []) {
        for (const index of result.get(importer) ?? []) {
          if (set.has(index)) continue
          set.add(index)
          changed = true
        }
      }
    }
  }
  return result
}

export function buildMap(
  evidence: Record<string, SpecEvidence>,
  graph: Map<string, ModuleFacts>,
  commit: string,
  createdAt: string,
): SpecMap {
  const specs = Object.keys(evidence).sort()
  const sources: Record<string, number[]> = {}
  for (const [source, set] of [...reach(specs, evidence, graph)].sort(([a], [b]) => a.localeCompare(b))) {
    sources[source] = [...set].sort((a, b) => a - b)
  }
  const incomplete = specs.filter((spec) => evidence[spec]?.status !== 'passed' || evidence[spec]?.executed.length === 0)
  return { version: 1, commit, createdAt, specs, incomplete, sources }
}

export interface Expectation {
  source: string
  spec: string
}

/**
 * Why a map must not be published: too few specs left evidence (Chrome dropped the V8 flag, or
 * the logs stopped mapping), or a passing spec does not reach a source it is known to run.
 */
export function mapProblems(map: SpecMap, expectations: Expectation[], minEvidence: number): string[] {
  const problems: string[] = []
  const withEvidence = map.specs.length - map.incomplete.length
  if (map.specs.length === 0 || withEvidence / map.specs.length < minEvidence) {
    problems.push(
      `only ${withEvidence} of ${map.specs.length} specs left V8 evidence (need ${Math.round(minEvidence * 100)}%)`,
    )
  }
  for (const { source, spec } of expectations) {
    const index = map.specs.indexOf(spec)
    if (index === -1) problems.push(`expected spec ${spec} did not run`)
    else if (map.incomplete.includes(spec)) continue
    else if (!map.sources[source]?.includes(index)) problems.push(`${source} does not reach ${spec}`)
  }
  return problems
}
