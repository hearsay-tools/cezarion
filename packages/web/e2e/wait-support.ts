/**
 * The CLI's own default wait budget, read from the variable agent-browser reads
 * (`AGENT_BROWSER_DEFAULT_TIMEOUT`, milliseconds), so a seam-side poll gives up when a
 * `wait <selector>` would. 25 s bounds each polled command too, and stays inside the suite's 60 s test
 * timeout; a unit test shortens it through the same variable.
 */
export function defaultWaitTimeoutMs(): number {
  const fromEnv = Number(process.env.AGENT_BROWSER_DEFAULT_TIMEOUT)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 25_000
}

/** A blocking pause. The seam is synchronous end to end (`execFileSync`), so a poll interval
 *  cannot `await`; `Atomics.wait` sleeps the thread without spinning it. */
export function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** `JSON.stringify` bounded for an error message: a sample can be a whole layout snapshot. */
export function summarize(value: unknown, max = 400): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Identity for a hold window: two samples are the same state when they serialize the same. */
export function sameSample(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return left === right
  }
}
