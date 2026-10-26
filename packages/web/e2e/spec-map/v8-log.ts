import { join } from 'node:path'

/**
 * Turns on and reads V8's function-event log, the evidence the spec map is built from
 * (hearsay-tools/cezarion#1816).
 *
 * Chrome writes one log per isolate when it starts with
 * `--js-flags=--log-function-events --logfile=<path>`. Two kinds of line matter:
 *
 *   script-details,<scriptId>,<url>,…           names a script
 *   function,<event>,<scriptId>,<start>,<end>,…  V8 compiled a function of that script
 *
 * V8 compiles a function the first time it runs, so a compile event stands for an execution.
 * `start` and `end` are character offsets into the script's source. Script ids are unique within
 * one isolate, which is why the log is read one file at a time.
 */

/** The launch arguments that make Chrome log V8 function events to `dir`. */
export function captureBrowserArgs(inherited: string, dir: string): string {
  if (/[,\n]/.test(dir)) throw new Error(`spec-map capture: the log directory cannot hold a comma or newline: ${dir}`)
  if (inherited.includes('--js-flags')) throw new Error('spec-map capture: AGENT_BROWSER_ARGS already sets --js-flags')
  const flags = `--js-flags=--log-function-events --logfile=${join(dir, 'v8.log')}`
  return [inherited, '--no-sandbox', flags].filter(Boolean).join(',')
}

export interface CompiledFunction {
  url: string
  start: number
  end: number
}

/** The events that compile a function: its bytecode, or its first run on newer V8 builds. */
const COMPILE_EVENTS = new Set(['interpreter', 'interpreter-lazy', 'first-execution'])

/** Every function of an `http(s)` script that the log shows was compiled. */
export function compiledFunctions(log: string): CompiledFunction[] {
  const urls = new Map<string, string>()
  const events: Array<{ script: string; start: number; end: number }> = []
  for (const line of log.split('\n')) {
    const fields = line.split(',')
    const [kind, event, script] = fields
    if (kind === 'script-details' && event) urls.set(event, script ?? '')
    if (kind !== 'function' || !COMPILE_EVENTS.has(event ?? '') || !script) continue
    const start = Number(fields[3])
    const end = Number(fields[4])
    if (Number.isInteger(start) && Number.isInteger(end)) events.push({ script, start, end })
  }
  const compiled: CompiledFunction[] = []
  for (const { script, start, end } of events) {
    const url = urls.get(script)
    if (url && /^https?:\/\//.test(url)) compiled.push({ url, start, end })
  }
  return compiled
}
