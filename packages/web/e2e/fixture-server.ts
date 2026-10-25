import { defined } from '@open-mercato/cezar-api-client/contract/defined'
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import { pollFor, type PollOptions } from './poll'

/**
 * Stop a spec-owned server before removing the directory it may still be writing.
 *
 * A server from `spawnFixtureServer` leads its own process group, and the stop waits for the
 * whole group, not only the server. The server's git children outlive its exit: with a git
 * wrapper that adds 400 ms per call, 22 and 24 of them were still running in the fixture root
 * after the server exited (`.ai/qa/1765/probe.mjs`). A `git status` among them can write
 * `.git/index.lock` while the spec's teardown `rmSync` walks the tree, which threw `ENOTEMPTY`
 * in git-sidebar (hearsay-tools/cezarion#1764), variants-compare (hearsay-tools/cezarion#1731)
 * and new-task. Any other child keeps the old leader-only stop.
 */
export async function stopFixtureServer(child: ChildProcess | undefined, timeoutMs = 5_000): Promise<void> {
  if (child?.pid !== undefined && ownedGroups.has(child)) return stopFixtureGroup(child, child.pid, timeoutMs)
  if (!child || exited(child)) return

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

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

/** Servers that lead their own process group, still live or not yet stopped. */
const ownedGroups = new Set<ChildProcess>()

/** SIGTERM to the group, then SIGKILL for whatever outlives the grace, the server or any child. */
async function stopFixtureGroup(child: ChildProcess, pgid: number, timeoutMs: number): Promise<void> {
  try {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!groupRunning(child, pgid)) return
      signalGroup(pgid, signal)
      const deadline = performance.now() + timeoutMs
      while (groupRunning(child, pgid) && performance.now() < deadline) await delay(50)
    }
    if (groupRunning(child, pgid)) throw new Error('Fixture server group did not exit after SIGKILL')
  } finally {
    if (!groupRunning(child, pgid)) ownedGroups.delete(child)
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try { process.kill(-pgid, signal) } catch { /* the group already ended */ }
}

/**
 * True while the server runs, or while its group still holds a process that is not a zombie.
 * Node reaps the server before its `exit` event, and the kernel never hands out a pid that
 * still names a group. So once the server has exited, a live process with its pid means the
 * group ended and the pid was reused. Zombies do not count: one whose new parent never reaps
 * it would keep the group forever.
 */
function groupRunning(child: ChildProcess, pgid: number): boolean {
  if (!exited(child)) return true
  if (processExists(pgid)) return false
  if (!processExists(-pgid)) return false
  return liveMember(pgid)
}

/** True when signal 0 reaches `target` (a pid, or a group as `-pgid`); EPERM means it exists. */
function processExists(target: number): boolean {
  try { process.kill(target, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** True when the process table holds a member of group `pgid` that is not a zombie, or cannot
 *  be read. Linux reads /proc, macOS asks ps (as `.ai/scripts/qa-fixture.mjs` does). */
function liveMember(pgid: number): boolean {
  if (process.platform === 'darwin') {
    const ps = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2_000 })
    if (ps.status !== 0) return true
    return ps.stdout.split('\n').some((line) => {
      const [group, state] = line.trim().split(/\s+/)
      return Number(group) === pgid && !state?.startsWith('Z')
    })
  }
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
      if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return true
    } catch (error) {
      // A process that exited after the listing is no member; one it cannot read may be.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ESRCH') return true
    }
  }
  return false
}

/**
 * A detached server no longer receives the terminal's Ctrl-C with the test run. When this
 * process ends by a signal or exits, SIGKILL every group it still owns. A signal is then
 * raised again only when no other listener (Vitest's own, for one) handles it.
 */
let interruptHandlersInstalled = false
function installInterruptHandlers() {
  if (interruptHandlersInstalled) return
  interruptHandlersInstalled = true
  const killOwned = () => {
    // groupRunning first: a group that ended long ago may have handed its pid to another group.
    for (const child of ownedGroups) if (child.pid !== undefined && groupRunning(child, child.pid)) signalGroup(child.pid, 'SIGKILL')
    ownedGroups.clear()
  }
  process.once('exit', killOwned)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = () => {
      killOwned()
      process.off(signal, onSignal)
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    }
    process.on(signal, onSignal)
  }
}


/** Drain piped output immediately and retain a bounded tail even before browser setup exists. */
export function captureFixtureServer(child: ChildProcess, outputLimit = 16_384) {
  const startedAt = Date.now()
  const lifecycle: Array<{ kind: string; elapsedMs: number; detail?: string }> = []
  const event = (kind: string, detail?: string) => {
    lifecycle.push({ kind, elapsedMs: Date.now() - startedAt, ...defined({ detail }) })
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
  failure?: Error | undefined
}
const ownedFixtures = new WeakMap<ChildProcess, OwnedFixture>()

/**
 * Wall-clock budget from spawn to a healthy owned listener (hearsay-tools/cezarion#986).
 *
 * The budget used to be `tries: 60` × 250 ms ≈ 15 s, inherited from the old health poll of an
 * already-booted server. A cockpit boot announces only after detectEnvironment, store open,
 * worktree reconcile and recovery, and that path is CPU-bound: measured 1.7 s idle, 6–10 s with
 * four concurrent boots at load ~80 on the 24-core host (`.ai/qa/986/trace-4.log`, 2026-10-15).
 * Four-lane run `1791923143645-2565641` (load ~30) failed four specs at 14.7–14.8 s with the
 * child alive and stdout empty; Squeal's slow tier in the main checkout (revision 79) failed
 * task-github-items and task-handoff the same way. The banner is written synchronously to the
 * pipe as one burst, so empty stdout means the child had not reached it — not lost output.
 * Reproduction: an env-gated 20 s delay before the banner in the built dist, red at 14.8 s
 * before this change, green after. 45 s stays inside the default 60 s hook timeout with room
 * for fixture setup, so a genuinely hung boot still fails here with the child's diagnostics.
 * A dead child fails at once (exit is checked every probe), so the budget only bounds a live one.
 */
export const FIXTURE_BOOT_BUDGET_MS = 45_000

/** Spawn immediately so callers can attach their existing log hooks before readiness. */
export function spawnFixtureServer(args: readonly string[], options: SpawnOptions, readiness: PollOptions = {}): ChildProcess {
  // The budget is wall-clock only. An attempt cap silently shortened every explicit
  // `timeoutMs`: waiting for the announcement costs no time per attempt, so 60 tries ended a
  // 20 s budget at 15 s (touch-targets in run `1791923143645-2565641`, hearsay-tools/cezarion#986).
  const budget = readiness.timeoutMs ?? FIXTURE_BOOT_BUDGET_MS
  const poll: PollOptions = { ...readiness, tries: readiness.tries ?? Number.POSITIVE_INFINITY, timeoutMs: budget }
  const deadline = Math.min(Date.now() + budget, poll.deadline ?? Infinity)
  // Its own process group, so the stop can wait for the git children it leaves behind.
  const group = process.platform !== 'win32'
  const child = spawn(process.execPath, [...args], { ...options, detached: group, stdio: ['ignore', 'pipe', 'pipe'] })
  if (group && child.pid !== undefined) {
    installInterruptHandlers()
    ownedGroups.add(child)
  }
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
  { expectedOrigin, deadline = Infinity, healthHeaders }: { expectedOrigin?: string; deadline?: number | undefined; healthHeaders?: Record<string, string> } = {},
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
        const response = await fetch(`${origin}/api/v1/health`, { signal, ...defined({ headers: healthHeaders }) })
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
