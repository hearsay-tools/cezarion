import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'

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

function lineAt(code: string, offset: number): number {
  return code.slice(0, offset).split('\n').length
}

/** Translate generated server lines through the source map emitted by the harness build. */
function position(file: string, code: string, offset: number, root: string, map: TraceMap | null) {
  const line = lineAt(code, offset)
  if (!map) return { source: relative(root, file), line }
  const column = offset - (code.lastIndexOf('\n', offset - 1) + 1)
  const original = originalPositionFor(map, { line, column })
  if (!original.source || !original.line) return null
  const source = relative(root, resolve(dirname(file), original.source))
  if (!source.startsWith('packages/') || source.includes('/node_modules/')) return null
  return { source, line: original.line }
}

/** Function ranges use original-source line numbers at the map commit. */
export function scriptFunctions(script: CoverageScript, root: string): FunctionEvidence[] {
  if (!script.url.startsWith('file:')) return []
  const file = fileURLToPath(script.url)
  const mock = /\/packages\/cezar\/scripts\/mock-[^/]+\.mjs$/.test(file)
  const server = file.startsWith(join(root, '.ai/qa/build/cezar/dist/')) && existsSync(`${file}.map`)
  if ((!mock && !server) || !existsSync(file)) return []
  const map = server ? new TraceMap(readFileSync(`${file}.map`, 'utf8'), `${file}.map`) : null
  const code = readFileSync(file, 'utf8')
  const result: FunctionEvidence[] = []
  for (const fn of script.functions) {
    const range = fn.ranges[0]
    if (!range) continue
    const start = position(file, code, range.startOffset, root, map)
    const end = position(file, code, Math.max(range.startOffset, range.endOffset - 1), root, map)
    if (!start || !end || start.source !== end.source) continue
    result.push({ source: start.source, start: start.line, end: end.line, executed: range.count > 0 })
  }
  return result
}

/** Read both per-spec server snapshots and task-owned mock-process coverage. */
export function nodeEvidence(logs: string, spec: string, root: string): FunctionEvidence[] {
  const dir = join(logs, basename(spec, '.e2e.ts'), 'node')
  if (!existsSync(dir)) return []
  const result: FunctionEvidence[] = []
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.json')) continue
    const report = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { result?: CoverageScript[] }
    for (const script of report.result ?? []) result.push(...scriptFunctions(script, root))
  }
  return result
}

/** A missing process report leaves its owner's evidence incomplete, including abrupt SIGKILL. */
export function nodeCaptureComplete(logs: string, spec: string): boolean {
  if (existsSync(logs) && readdirSync(logs).some((name) => name.startsWith('ambiguous-task-') && name.endsWith('.json'))) return false
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
