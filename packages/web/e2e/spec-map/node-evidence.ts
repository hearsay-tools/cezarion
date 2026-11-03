import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eachMapping, originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'

export interface FunctionEvidence {
  source: string
  start: number
  end: number
  executed: boolean
}
interface CoverageFunction {
  ranges: Array<{ startOffset: number; endOffset: number; count: number }>
}
interface CoverageScript { url: string; functions: CoverageFunction[] }

function lineStarts(code: string): number[] {
  return [0, ...Array.from(code.matchAll(/\n/g), (match) => match.index + 1)]
}

function lineAt(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (starts[middle]! <= offset) low = middle + 1
    else high = middle
  }
  return low
}

/** Translate generated server lines through the source map emitted by the harness build. */
function position(file: string, starts: number[], offset: number, root: string, map: TraceMap | null) {
  const line = lineAt(starts, offset)
  if (!map) return { source: relative(root, file), line }
  const column = offset - (starts[line - 1] ?? 0)
  const original = originalPositionFor(map, { line, column })
  return repositoryPosition(file, root, original.source, original.line)
}

function repositoryPosition(file: string, root: string, originalSource: string | null, line: number | null) {
  if (!originalSource || !line) return null
  const source = relative(root, resolve(dirname(file), originalSource))
  if (!source.startsWith('packages/') || source.includes('/node_modules/')) return null
  return { source, line }
}

function mappingPositions(map: TraceMap | null, starts: number[], file: string, root: string) {
  const positions: Array<{ offset: number; position: ReturnType<typeof repositoryPosition> }> = []
  if (map) eachMapping(map, (mapping) => {
    positions.push({ offset: (starts[mapping.generatedLine - 1] ?? 0) + mapping.generatedColumn,
      position: repositoryPosition(file, root, mapping.source, mapping.originalLine) })
  })
  return positions
}

/** Function ranges use original-source line numbers at the map commit. */
export function scriptFunctions(script: CoverageScript, root: string): FunctionEvidence[] {
  if (!script.url.startsWith('file:')) return []
  const file = fileURLToPath(script.url)
  const mock = /\/packages\/cezar\/scripts\/mock-[^/]+\.mjs$/.test(file)
  const server = file.startsWith(join(root, '.ai/qa/build/cezar/dist/')) && existsSync(`${file}.map`)
  if ((!mock && !server) || !existsSync(file)) return []
  const map = server ? new TraceMap(readFileSync(`${file}.map`, 'utf8'), `${file}.map`) : null
  const starts = lineStarts(readFileSync(file, 'utf8'))
  const points = mappingPositions(map, starts, file, root)
  const offsets = points.map(point => point.offset)
  const result: FunctionEvidence[] = []
  for (const fn of script.functions) {
    const range = fn.ranges[0]
    if (!range) continue
    const start = position(file, starts, range.startOffset, root, map)
    const end = position(file, starts, Math.max(range.startOffset, range.endOffset - 1), root, map)
    const positions = [start, end, ...points.slice(lineAt(offsets, range.startOffset - 1),
      lineAt(offsets, range.endOffset - 1)).map(point => point.position)]
    const spans = new Map<string, { start: number; end: number }>()
    for (const point of positions) {
      if (!point) continue
      const span = spans.get(point.source)
      spans.set(point.source, { start: Math.min(span?.start ?? point.line, point.line),
        end: Math.max(span?.end ?? point.line, point.line) })
    }
    for (const [source, span] of spans) result.push({ source, ...span, executed: range.count > 0 })
  }
  return result
}

/** Read both per-spec server snapshots and task-owned mock-process coverage. */
export function nodeEvidence(logs: string, spec: string, root: string): FunctionEvidence[] {
  const dir = join(logs, basename(spec, '.e2e.ts'), 'node')
  const local = existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.json')).map((name) => join(dir, name)) : []
  const shared = existsSync(logs) ? readdirSync(logs)
    .filter((name) => /^shared-startup-\d+\.json$/.test(name)).map((name) => join(logs, name)) : []
  const result: FunctionEvidence[] = []
  for (const file of [...local, ...shared]) {
    const report = JSON.parse(readFileSync(file, 'utf8')) as { result?: CoverageScript[] }
    for (const script of report.result ?? []) result.push(...scriptFunctions(script, root))
  }
  return result
}

/** A missing process report leaves its owner's evidence incomplete, including abrupt SIGKILL. */
export function nodeCaptureComplete(logs: string, spec: string): boolean {
  if (!existsSync(logs)) return false
  const shared = readdirSync(logs)
  if (!shared.some((name) => /^shared-startup-\d+\.json$/.test(name))) return false
  if (shared.some((name) => name.startsWith('ambiguous-task-') && name.endsWith('.json'))) return false
  const dir = join(logs, basename(spec, '.e2e.ts'), 'node')
  if (!existsSync(dir)) return false
  const names = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  if (!names.some((name) => /^server-.*\.json$/.test(name))) return false
  if (!names.filter((name) => /^expected-server-\d+\.json$/.test(name)).every((name) => {
    const pid = name.slice('expected-server-'.length, -'.json'.length)
    return names.some((candidate) => candidate.startsWith(`server-${pid}-`) && candidate.endsWith('.json'))
  })) return false
  return names.filter((name) => name.endsWith('/expected.json')).every((name) => {
    const directory = dirname(name)
    return names.some((candidate) => dirname(candidate) === directory && basename(candidate).startsWith('coverage-'))
  })
}
