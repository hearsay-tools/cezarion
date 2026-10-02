/**
 * Every spec-side poll, in one place (#416).
 *
 * A cockpit spec waits on the browser through the seam (`waitForFunction`, `waitForValue`) and on
 * the server through HTTP. The browser half has had one implementation since #409; the HTTP half
 * was copied into 21 specs — `waitForHealth` alone — differing only in the error message. The
 * copies are what forced `e2e-wait-discipline`'s sleep rule to exempt any looping function whose
 * name starts with `waitFor` or `poll`, and that exemption is a hole: a helper named `waitForX`
 * could sleep for any reason at all and the scan would nod it through.
 *
 * So the sleeps live here, this file is excluded from the scan, and the rule now flags EVERY
 * `setTimeout` in a spec. A spec that needs to wait on the server calls one of these, or builds
 * its own condition on `pollFor` — which is the only loop below that sleeps.
 */

export interface PollOptions {
  /** Additional attempt cap; timeoutMs is the wall-clock limit. */
  tries?: number
  /** Total wall-clock budget, including probes and backoff. */
  timeoutMs?: number
  /** Bound each probe; the signal also aborts fetch and body reads. */
  requestTimeoutMs?: number
  /** Absolute shared deadline for multiple waits in one test. */
  deadline?: number
  /** How long to wait between them, in milliseconds. */
  intervalMs?: number
}

/**
 * Probe until it answers, then return that answer.
 *
 * `undefined` is the "not yet" sentinel: a probe that has nothing to report returns it and the
 * loop sleeps. `fail` is called only on the last attempt, so a message that costs a fetch of its
 * own (the resource dump `settings-monitoring` prints) costs nothing while the poll is passing.
 *
 * **A probe that throws is "not yet" too.** A poll exists because the thing it watches is not
 * ready, and a server that is not ready answers with a connection reset, a 5xx or a body that is
 * not JSON as readily as it answers with the wrong status — so a probe rejection that aborted the
 * whole wait would be the poll giving up at exactly the moment it is for. `queued-stack`'s own
 * `getRun` retried five times for this reason before it was folded in here, and that guarantee
 * belongs to every caller rather than to one of them.
 *
 * The cause is not swallowed with it: the last rejection is reported alongside `fail()` and
 * carried as the thrown error's `cause`, so a poll that ran out because the server was broken
 * says so instead of only saying it timed out.
 */
export async function pollFor<T>(
  probe: (signal: AbortSignal) => T | undefined | Promise<T | undefined>,
  fail: (signal: AbortSignal) => string | Promise<string>,
  { tries = 40, intervalMs = 250, timeoutMs = tries * Math.max(intervalMs, 250), requestTimeoutMs = 2_000, deadline = Infinity }: PollOptions = {},
): Promise<T> {
  const end = Math.min(Date.now() + timeoutMs, deadline)
  const probeEnd = end - Math.min(250, timeoutMs / 10)
  let lastError: unknown
  for (let attempt = 0; attempt < tries && Date.now() < probeEnd; attempt += 1) {
    try {
      const answer = await boundedProbe(probe, Math.min(requestTimeoutMs, probeEnd - Date.now()))
      if (answer !== undefined && Date.now() <= probeEnd) return answer
    } catch (error) {
      lastError = error
    }
    if (attempt + 1 < tries && Date.now() < probeEnd) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, probeEnd - Date.now())))
    }
  }
  // Diagnostics must not hang after the poll exhausted its budget either.
  const reason = await boundedProbe(signal => fail(signal), Math.max(1, Math.min(requestTimeoutMs, end - Date.now()))).catch(error => `poll diagnostics failed: ${String(error)}`)
  if (lastError === undefined) throw new Error(reason)
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`${reason} (last probe error: ${detail})`, { cause: lastError })
}

async function boundedProbe<T>(probe: (signal: AbortSignal) => T | Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => probe(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`probe exceeded ${timeoutMs}ms`)
          controller.abort(error)
          reject(error)
        }, Math.max(1, timeoutMs))
      }),
    ])
  } finally { clearTimeout(timer) }
}

/** JSON and its body read share the poll's abort signal; non-2xx responses are retries. */
export async function pollJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  return await response.json() as T
}

/** A fixture server is listening and answering its own health route. */
export async function waitForHealth(baseUrl: string, what = 'the fixture server', options: PollOptions = {}): Promise<void> {
  // Still starting is the ordinary case here, so a rejected fetch is not even worth reporting as
  // the last probe error — `pollFor` would otherwise end every boot timeout with ECONNREFUSED.
  await pollFor(
    async (signal) => {
      try {
        return (await fetch(`${baseUrl}/api/v1/health`, { signal })).ok || undefined
      } catch {
        return undefined
      }
    },
    () => `cezar e2e: ${what} never answered at ${baseUrl}`,
    { tries: 60, ...options },
  )
}

/** A run reached one of `wanted`, read from the real `GET /api/v1/runs/:id`. */
export async function waitForStatus(
  baseUrl: string,
  id: string,
  wanted: readonly string[],
  options: PollOptions = {},
): Promise<string> {
  let lastState: string | undefined
  return pollFor(
    async (signal) => {
      // `pollFor` treats a throw as "not yet", so a reset connection or a 5xx keeps polling
      // rather than aborting the wait — what `queued-stack`'s five-attempt `getRun` gave this
      // one spec before the helpers were folded together.
      const response = await fetch(`${baseUrl}/api/v1/runs/${id}`, { signal })
      if (!response.ok) throw new Error(`GET run ${id} answered ${response.status}`)
      const record = (await response.json()) as { status?: string }
      lastState = record.status
      return record.status !== undefined && wanted.includes(record.status) ? record.status : undefined
    },
    () => `cezar e2e: run ${id} never reached status "${wanted.join('/')}"${lastState === undefined ? '' : ` at ${baseUrl}/api/v1/runs/${id} (last state: ${lastState})`}`,
    { tries: 120, intervalMs: 500, ...options },
  )
}

/** `GET /api/v1/config` shows what a settings click was supposed to write. */
export async function waitForConfig<T>(
  baseUrl: string,
  check: (config: T) => boolean,
  what: string,
  options: PollOptions = {},
): Promise<T> {
  let lastState: T | undefined
  return pollFor(
    async (signal) => {
      const config = await pollJson<T>(`${baseUrl}/api/v1/config`, signal)
      lastState = config
      return check(config) ? config : undefined
    },
    () => `GET ${baseUrl}/api/v1/config never showed ${what}; last state: ${JSON.stringify(lastState)}`,
    options,
  )
}

/**
 * The appearance a settings click wrote to `ui-state.json`. The PUT behind that click is
 * fire-and-forget from the UI's point of view, so the spec polls the API rather than assuming
 * the write beat its assertion.
 */
export async function waitForServerAppearance(
  baseUrl: string,
  check: (appearance: Record<string, unknown>) => boolean,
  options: PollOptions = {},
): Promise<Record<string, unknown>> {
  let lastState: unknown
  return pollFor(
    async (signal) => {
      const state = await pollJson<{
        appearance?: Record<string, unknown>
      }>(`${baseUrl}/api/v1/workspace/ui-state`, signal)
      lastState = state
      return state.appearance && check(state.appearance) ? state.appearance : undefined
    },
    () => `GET ${baseUrl}/api/v1/workspace/ui-state never showed the expected appearance; last state: ${JSON.stringify(lastState)}`,
    options,
  )
}
