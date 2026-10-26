import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { Bundle, assertSameJavaScript } from './bundle.ts'
import { readModuleGraph } from './module-graph.ts'
import {
  SPEC_DIR, buildMap, joinPartials, mapProblems, partialMap, specStatuses,
  type Expectation, type PartialMap,
} from './spec-map.ts'

/**
 * Builds the spec map in the `E2E spec map` workflow (hearsay-tools/cezarion#1816).
 *
 *   node packages/web/e2e/spec-map/build-map.ts partial --logs <dir> --served <dir>
 *     --sourcemaps <dir> --results <vitest.json> --out <file>
 *   node packages/web/e2e/spec-map/build-map.ts merge --partials <dir> --commit <sha>
 *     --out <file> [--expect <source>=<spec>]...
 *
 * `partial` turns one shard's V8 logs into evidence, after it checks that the served bundle and
 * the source-map build hold the same JavaScript. `merge` joins the shards, applies the module
 * rules and refuses a map that fails `mapProblems`.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../../..')
/** The share of specs that must leave evidence; a lower share means the capture itself broke. */
const MIN_EVIDENCE = 0.9

function write(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value)}\n`)
}

/** One shard's evidence. `repoRoot` is where the Vitest report's spec paths start. */
export function partial(args: string[], repoRoot = REPO_ROOT): void {
  const { values } = parseArgs({
    args,
    options: {
      logs: { type: 'string' }, served: { type: 'string' }, sourcemaps: { type: 'string' },
      results: { type: 'string' }, out: { type: 'string' },
    },
  })
  const { logs, served, sourcemaps, results, out } = values
  if (!logs || !served || !sourcemaps || !results || !out) throw new Error('partial needs --logs, --served, --sourcemaps, --results and --out')
  assertSameJavaScript(served, sourcemaps)
  const statuses = specStatuses(JSON.parse(readFileSync(results, 'utf8')), repoRoot)
  const map = partialMap(logs, statuses, new Bundle(served, sourcemaps, repoRoot))
  write(out, map)
  const withEvidence = Object.values(map.specs).filter((spec) => spec.executed.length > 0).length
  console.log(`spec map: ${withEvidence} of ${statuses.size} specs left V8 evidence`)
}

function expectation(text: string): Expectation {
  const [source, spec, ...rest] = text.split('=')
  if (!source || !spec || rest.length > 0) throw new Error(`--expect takes <source>=<spec>, not ${text}`)
  return { source, spec }
}

/** The spec map for `repoRoot`, refused unless every spec there ran and `mapProblems` finds nothing. */
export function merge(args: string[], repoRoot = REPO_ROOT): void {
  const { values } = parseArgs({
    args,
    options: {
      partials: { type: 'string' }, commit: { type: 'string' }, out: { type: 'string' },
      expect: { type: 'string', multiple: true },
    },
  })
  const { partials, commit, out } = values
  if (!partials || !commit || !out) throw new Error('merge needs --partials, --commit and --out')
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`--commit must be a full commit id, not ${commit}`)
  const shards = readdirSync(partials, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(partials, file), 'utf8')) as PartialMap)
  const specFiles = readdirSync(join(repoRoot, SPEC_DIR))
    .filter((file) => file.endsWith('.e2e.ts'))
    .map((file) => `${SPEC_DIR}/${file}`)
  const evidence = joinPartials(shards, specFiles)
  const sources = new Set(Object.values(evidence).flatMap((spec) => spec.loaded))
  const map = buildMap(evidence, readModuleGraph(repoRoot, sources), commit, new Date().toISOString())
  const problems = mapProblems(map, (values.expect ?? []).map(expectation), MIN_EVIDENCE)
  if (problems.length > 0) throw new Error(`the spec map is not published:\n  ${problems.join('\n  ')}`)
  write(out, map)
  console.log(`spec map: ${Object.keys(map.sources).length} sources, ${map.specs.length} specs, ${map.incomplete.length} incomplete`)
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'partial') partial(rest)
  else if (command === 'merge') merge(rest)
  else {
    console.error('usage: build-map.ts partial|merge …')
    process.exit(2)
  }
}
