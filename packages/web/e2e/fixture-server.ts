import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

import { pollFor, type PollOptions } from './poll'

/** Stop a spec-owned server before removing the directory it may still be writing. */
export async function stopFixtureServer(child: ChildProcess | undefined, timeoutMs = 5_000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  await new Promise<void>((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(graceTimer)
      if (forceTimer) clearTimeout(forceTimer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onExit = () => { cleanup(); resolve() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    child.once('exit', onExit)
    child.once('error', onError)
    const graceTimer = setTimeout(() => {
      child.kill('SIGKILL')
      forceTimer = setTimeout(() => {
        cleanup()
        reject(new Error('Fixture server did not exit after SIGKILL'))
      }, timeoutMs)
    }, timeoutMs)
    child.kill('SIGTERM')
  })
}


/** Drain piped output immediately and retain a bounded tail even before browser setup exists. */
export function captureFixtureServer(child: ChildProcess, outputLimit = 16_384) {
  const startedAt = Date.now()
  const lifecycle: Array<{ kind: string; elapsedMs: number; detail?: string }> = []
  const event = (kind: string, detail?: string) => {
    lifecycle.push({ kind, elapsedMs: Date.now() - startedAt, ...(detail === undefined ? {} : { detail }) })
    if (lifecycle.length > 16) lifecycle.shift()
  }
  let stdout = '', stderr = '', stdoutDropped = 0, stderrDropped = 0
  child.stdout?.on('data', chunk => {
    const next = stdout + String(chunk)
    stdoutDropped += Math.max(0, next.length - outputLimit)
    stdout = next.slice(-outputLimit)
  })
  child.stderr?.on('data', chunk => {
    const next = stderr + String(chunk)
    stderrDropped += Math.max(0, next.length - outputLimit)
    stderr = next.slice(-outputLimit)
  })
  child.once('spawn', () => event('spawn'))
  child.on('error', error => event('error', String(error).slice(0, outputLimit)))
  child.once('exit', (code, signal) => event('exit', `code=${code} signal=${signal}`))
  child.once('close', (code, signal) => event('close', `code=${code} signal=${signal}`))
  return () => ({
    pid: child.pid ?? null, spawnfile: child.spawnfile, spawnargs: child.spawnargs,
    elapsedMs: Date.now() - startedAt, exitCode: child.exitCode, signalCode: child.signalCode,
    lifecycle: [...lifecycle], stdout, stderr, stdoutDropped, stderrDropped,
  })
}


interface OwnedFixture {
  deadline: number
  poll: PollOptions
  sample: ReturnType<typeof captureFixtureServer>
  origin?: string
  failure?: Error
}
const ownedFixtures = new WeakMap<ChildProcess, OwnedFixture>()

/** Spawn immediately so callers can attach their existing log hooks before readiness. */
export function spawnFixtureServer(args: readonly string[], options: SpawnOptions, readiness: PollOptions = {}): ChildProcess {
  const poll = { tries: 60, ...readiness }
  // Preserve each site's original health budget, now shared from spawn through announcement.
  const budget = poll.timeoutMs ?? poll.tries * Math.max(poll.intervalMs ?? 250, 250)
  const deadline = Math.min(Date.now() + budget, poll.deadline ?? Infinity)
  const child = spawn(process.execPath, [...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.setEncoding('utf8')
  const fixture: OwnedFixture = { deadline, poll, sample: captureFixtureServer(child) }
  ownedFixtures.set(child, fixture)
  child.once('error', error => { fixture.failure = error })
  let pending = ''
  child.stdout?.on('data', chunk => {
    const lines = (pending + String(chunk)).split('\n')
    pending = (lines.pop() ?? '').slice(-512)
    for (const line of lines) {
      const match = /^\s*cockpit → (\S+)\s*$/.exec(line)
      if (!match || fixture.origin || fixture.failure) continue
      const raw = match[1]!
      const port = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(raw)?.[1]
      if (!port || Number(port) < 1 || Number(port) > 65_535) {
        fixture.failure = new Error('Invalid fixture listener announcement')
      } else fixture.origin = new URL(raw).origin
    }
  })
  return child
}

/** Child-owned listener + health share one original deadline; never probe a guessed port. */
export async function waitForFixtureServer(
  child: ChildProcess,
  { expectedOrigin, deadline = Infinity, healthHeaders }: { expectedOrigin?: string; deadline?: number; healthHeaders?: Record<string, string> } = {},
): Promise<string> {
  const fixture = ownedFixtures.get(child)
  if (!fixture) throw new Error('Fixture child was not constructed by spawnFixtureServer')
  let phase = 'awaiting listener announcement'
  let lastHealthResponse: string | undefined
  try {
    const answer = await pollFor<{ origin: string } | { failure: Error }>(
      async signal => {
        if (fixture.failure) return { failure: fixture.failure }
        if (child.exitCode !== null || child.signalCode !== null) {
          return { failure: new Error(`Fixture child exited: code=${child.exitCode} signal=${child.signalCode}`) }
        }
        const origin = fixture.origin
        if (!origin) return undefined
        if (expectedOrigin !== undefined && origin !== expectedOrigin) {
          return { failure: new Error(`Fixture restart listener changed: expected ${expectedOrigin}, announced ${origin}`) }
        }
        phase = 'awaiting owned listener health'
        const response = await fetch(`${origin}/api/v1/health`, { signal, headers: healthHeaders })
        // Keep received headers even if cancellation or a later probe times out.
        lastHealthResponse = `GET ${origin}/api/v1/health answered ${response.status}`
        await response.body?.cancel()
        if (child.exitCode !== null || child.signalCode !== null) {
          return { failure: new Error(`Fixture child exited: code=${child.exitCode} signal=${child.signalCode}`) }
        }
        if (!response.ok) throw new Error(`GET ${origin}/api/v1/health answered ${response.status}`)
        return { origin }
      },
      () => `cezar e2e: ${phase}`,
      { ...fixture.poll, deadline: Math.min(fixture.deadline, deadline) },
    )
    if ('failure' in answer) throw answer.failure
    return answer.origin
  } catch (error) {
    const healthDetail = lastHealthResponse === undefined ? '' : `; last received health response: ${lastHealthResponse}`
    const failure = new Error(`cezar e2e: ${phase}; ${error instanceof Error ? error.message : String(error)}${healthDetail}; child=${JSON.stringify(fixture.sample())}`, { cause: error })
    try { await stopFixtureServer(child) }
    catch (cleanupError) { throw new AggregateError([failure, cleanupError], 'Fixture startup and cleanup failed', { cause: failure }) }
    throw failure
  }
}
