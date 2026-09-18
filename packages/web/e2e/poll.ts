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
  /** How many probes before giving up. */
  tries?: number
  /** How long to wait between them, in milliseconds. */
  intervalMs?: number
}

/**
 * Probe until it answers, then return that answer.
 *
 * `undefined` is the "not yet" sentinel: a probe that has nothing to report returns it and the
 * loop sleeps. `fail` is called only on the last attempt, so a message that costs a fetch of its
 * own (the resource dump `settings-monitoring` prints) costs nothing while the poll is passing.
 */
export async function pollFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  fail: () => string | Promise<string>,
  { tries = 40, intervalMs = 250 }: PollOptions = {},
): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const answer = await probe()
    if (answer !== undefined) return answer
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(await fail())
}

/** A fixture server is listening and answering its own health route. */
export async function waitForHealth(baseUrl: string, what = 'the fixture server', options: PollOptions = {}): Promise<void> {
  await pollFor(
    async () => {
      try {
        return (await fetch(`${baseUrl}/api/v1/health`)).ok || undefined
      } catch {
        // Still starting: the socket is not up yet, which is not a failure until `tries` runs out.
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
  return pollFor(
    async () => {
      const record = (await (await fetch(`${baseUrl}/api/v1/runs/${id}`)).json()) as { status?: string }
      return record.status !== undefined && wanted.includes(record.status) ? record.status : undefined
    },
    () => `cezar e2e: run ${id} never reached status "${wanted.join('/')}"`,
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
  return pollFor(
    async () => {
      const config = (await (await fetch(`${baseUrl}/api/v1/config`)).json()) as T
      return check(config) ? config : undefined
    },
    () => `GET /api/v1/config never showed ${what}`,
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
  return pollFor(
    async () => {
      const state = (await (await fetch(`${baseUrl}/api/v1/workspace/ui-state`)).json()) as {
        appearance?: Record<string, unknown>
      }
      return state.appearance && check(state.appearance) ? state.appearance : undefined
    },
    () => 'ui-state.json never showed the expected appearance',
    options,
  )
}
