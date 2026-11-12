import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { delimiter, isAbsolute, join, sep } from 'node:path'

// The temp sandboxes of the test entry points: scripts/test-git-env.mjs (node:test and the
// browser e2e workers), packages/cezar/vitest.setup.ts and packages/web/vitest.setup.ts.
// A sandbox used to leave only in an `exit` hook or an `afterAll`, and neither runs when the
// process ends on a signal: Vitest 4 stops every fork worker with SIGTERM, and a cancelled
// or timed-out run kills its workers. Hosts collected thousands of sandboxes
// (hearsay-tools/cezarion#1394, hearsay-tools/cezarion#1395). Now each sandbox names its owner
// process, the next sandbox of the same kind removes those whose owner is gone, and a signal
// removes the process's own sandboxes before the process ends.

/** Inside every sandbox: `{ pid, host }` of the process that owns it. */
export const OWNER_FILE = '.cez-test-owner'

/** The fixed OS temp root, not the inherited TMPDIR: a Squawk task pins TMPDIR inside its
 *  worktree, where Git resolves every "non-repo" fixture to the host checkout. */
export function osTempRoot() {
  return process.platform === 'win32'
    ? (process.env.SystemRoot ? join(process.env.SystemRoot, 'Temp') : 'C:\\Temp')
    : '/tmp'
}

// bound: three retries with a 50 ms backoff for one-shot child-process writes during removal
// (hearsay-tools/cezarion#1432).
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }

/** A live process, including one another user owns (EPERM). */
export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function readOwner(dir) {
  try {
    const owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8'))
    return Number.isSafeInteger(owner?.pid) && owner.pid > 0 && typeof owner.host === 'string' ? owner : undefined
  } catch {
    return undefined
  }
}

/** How long a sandbox without a readable marker may stay. A live sandbox has no marker only
 *  between `mkdtemp` and the marker write; a directory a late writer rebuilt after removal never
 *  gets one (hearsay-tools/cezarion#2453). */
export const UNMARKED_MAX_AGE_MS = 60 * 60 * 1000
/** Unmarked sandboxes removed per call, so the first run on a host full of them stalls no worker. */
export const UNMARKED_LIMIT = 64

/** Why a directory of the account `uid` may go: its marker names an exited process on `host`
 *  (`owner-gone`), or it has no readable marker and is older than `maxAgeMs` (`unmarked`). */
function reapReason(dir, { alive, host, uid, now, maxAgeMs }) {
  let stat
  try {
    stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.uid !== uid) return undefined
  } catch {
    return undefined
  }
  const owner = readOwner(dir)
  if (owner === undefined) return now - stat.mtimeMs > maxAgeMs ? 'unmarked' : undefined
  return owner.host === host && owner.pid !== process.pid && !alive(owner.pid) ? 'owner-gone' : undefined
}

/**
 * Remove the `<root>/<prefix>*` sandboxes whose owner process on this host has exited, and the
 * ones without a readable marker that are older than `unmarkedMaxAgeMs` (at most
 * `unmarkedLimit` of those per call). Return the removed paths. Everything else stays: a live
 * owner, an owner on another host (a container sharing this temp root), a recent directory
 * without a marker (a sandbox still being created), a symlink, and another account's directory.
 * A recycled process ID keeps a dead sandbox until that process exits too.
 *
 * Without a uid (Windows) nothing is reaped: the temp root there is shared by every account and
 * an account name is not unique, so no marker proves whose sandbox it is. A killed process then
 * leaves its sandbox, as before this reaper existed.
 */
export function reapTestSandboxes(prefix, root = osTempRoot(), {
  alive = processAlive,
  host = hostname(),
  account = { uid: process.getuid?.() },
  now = Date.now,
  unmarkedMaxAgeMs = UNMARKED_MAX_AGE_MS,
  unmarkedLimit = UNMARKED_LIMIT,
} = {}) {
  if (account.uid === undefined) return []
  let names
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const context = { alive, host, uid: account.uid, now: now(), maxAgeMs: unmarkedMaxAgeMs }
  const reaped = []
  let unmarked = 0
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const dir = join(root, name)
    const reason = reapReason(dir, context)
    if (reason === undefined || (reason === 'unmarked' && unmarked >= unmarkedLimit)) continue
    try {
      rmSync(dir, REMOVE_OPTIONS)
      reaped.push(dir)
      if (reason === 'unmarked') unmarked += 1
    } catch {
      // best-effort: a later sandbox retries it.
    }
  }
  return reaped
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** This process's sandboxes, shared by every copy of this module that a test runner loads. */
const owned = globalThis[Symbol.for('cez.testSandboxes')] ??= installCleanup()

function installCleanup() {
  const dirs = new Set()
  const cleanup = () => {
    for (const dir of dirs) {
      try {
        removeSandbox(dir)
      } catch {
        // best-effort: the next sandbox of the same kind removes it once this process is gone.
      }
    }
    dirs.clear()
  }
  process.once('exit', cleanup)
  for (const signal of SIGNALS) {
    process.once(signal, () => {
      cleanup()
      // A listener turns off the signal's default action. Raise it again when nothing else
      // listens, so the process still ends the way it would have ended without this one.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    })
  }
  return dirs
}

/** Create a `<root>/<prefix>XXXXXX` sandbox owned by this process, after reaping the dead
 *  ones. It is removed on exit and on SIGINT, SIGTERM and SIGHUP. */
export function createTestSandbox(prefix, root = osTempRoot()) {
  const realRoot = realpathSync(root)
  reapTestSandboxes(prefix, realRoot)
  const dir = mkdtempSync(join(realRoot, prefix))
  owned.add(dir)
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, host: hostname() }))
  return dir
}

/** Remove a directory. In a sandbox the owner marker goes last: a removal that fails partway
 *  leaves the marker, so the reaper still knows whose directory it is. */
function removeSandbox(dir) {
  if (existsSync(join(dir, OWNER_FILE))) {
    for (const name of readdirSync(dir)) if (name !== OWNER_FILE) rmSync(join(dir, name), REMOVE_OPTIONS)
  }
  rmSync(dir, REMOVE_OPTIONS)
}

/** Stop the processes that run in or point into `paths`, then remove every path, even after one
 *  removal fails, and throw the first failure. A path that could not be removed stays on the
 *  exit and signal cleanup list. Stopping first keeps a late writer from rebuilding a removed
 *  sandbox without its marker (hearsay-tools/cezarion#2453). */
export function removeTestSandboxes(paths, remove = removeSandbox, stop = stopSandboxProcesses) {
  stop(paths)
  let failure
  for (const path of paths) {
    try {
      remove(path)
      owned.delete(path)
    } catch (error) {
      failure ??= error
    }
  }
  if (failure) throw failure
}

/** The process IDs of this account, other than this process, whose working directory is inside
 *  one of `paths` or whose environment holds a value equal to one of them or under it. Every child
 *  a test starts inherits the sandbox's TMPDIR, HOME or Git config. Only Linux exposes this, in
 *  /proc; elsewhere the list is empty. */
export function sandboxProcesses(paths, { procRoot = '/proc', uid = process.getuid?.() } = {}) {
  if (process.platform !== 'linux' || uid === undefined || paths.length === 0) return []
  let names
  try {
    names = readdirSync(procRoot)
  } catch {
    return []
  }
  return names.map(Number).filter((pid) => pointsIntoSandbox(pid, paths, { procRoot, uid }))
}

/** Whether process `pid` of account `uid`, not this process, runs in or points into `paths`. */
function pointsIntoSandbox(pid, paths, { procRoot = '/proc', uid = process.getuid?.() } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || uid === undefined) return false
  const dir = join(procRoot, String(pid))
  try {
    if (statSync(dir).uid !== uid) return false
  } catch {
    return false
  }
  const inside = (value) => paths.some((path) => value === path || value.startsWith(path + sep))
  return pointsInto(dir, inside)
}

function pointsInto(procDir, inside) {
  try {
    if (inside(readlinkSync(join(procDir, 'cwd')))) return true
  } catch {
    // gone, or a zombie: it has no working directory.
  }
  try {
    for (const entry of readFileSync(join(procDir, 'environ'), 'utf8').split('\0')) {
      const equals = entry.indexOf('=')
      if (equals > 0 && inside(entry.slice(equals + 1))) return true
    }
  } catch {
    // gone between the listing and this read.
  }
  return false
}

/** Running, not exited: a zombie waits only for its parent to collect its status. */
function running(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat[stat.lastIndexOf(')') + 2]
    return state !== 'Z' && state !== 'X'
  } catch {
    return false
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4))

/** Wait until none of `pids` runs, or `ms` passes. Synchronous: the exit cleanup cannot await. */
function waitStopped(pids, ms) {
  const until = Date.now() + ms
  while (pids.some(running) && Date.now() < until) Atomics.wait(pause, 0, 0, 10)
}

/** Signal each of `pids` that `verify` still accepts. A process ID read earlier can name another
 *  process by now; checking it again right before the signal keeps this from hitting a stranger. */
function signal(pids, name, verify) {
  for (const pid of pids) {
    if (!verify(pid)) continue
    try {
      process.kill(pid, name)
    } catch {
      // already gone.
    }
  }
}

/** Rescans after the first SIGKILL: each catches what a killed process started before it died. */
const KILL_ROUNDS = 5

/**
 * Stop every process `find` returns for `paths`: SIGTERM, then after `graceMs` SIGKILL for every
 * process a new scan finds, and again until a scan finds none (at most `KILL_ROUNDS` times), so a
 * child forked after one scan is caught by the next. Each signal goes only to a process that
 * `verify` shows still points into `paths`. Return the process IDs found first. Tests leave such
 * processes behind (gh, tsx, runner CLIs, Chrome), and they wrote into the sandbox after its
 * removal (hearsay-tools/cezarion#2453).
 */
// bound: two seconds is how long a well-behaved child gets to exit on SIGTERM; then SIGKILL.
export function stopSandboxProcesses(paths, {
  graceMs = 2_000,
  find = sandboxProcesses,
  verify = (pid) => pointsIntoSandbox(pid, paths),
} = {}) {
  const pids = find(paths)
  if (pids.length === 0) return pids
  signal(pids, 'SIGTERM', verify)
  waitStopped(pids, graceMs)
  let left = find(paths)
  for (let round = 0; left.length > 0 && round < KILL_ROUNDS; round += 1) {
    signal(left, 'SIGKILL', verify)
    // bound: SIGKILL cannot be refused; this only lets the kernel finish the exits.
    waitStopped(left, 500)
    left = find(paths)
  }
  return pids
}

/**
 * A PATH in which every absolute directory that holds one of `names` is replaced by a mirror
 * under `mirrorRoot`: a directory of symlinks to every other entry. Relative and empty entries
 * go: they resolve against each spawn's working directory, so no mirror can stand in for them.
 * The named commands then resolve as on a host without them. Server unit tests hide the runner
 * CLIs this way, so a test that starts one by its default name gets ENOENT on every host, as on
 * CI, and never runs the real one (hearsay-tools/cezarion#1916). Windows keeps its PATH: no
 * Windows job runs these tests, and its commands resolve through PATHEXT names.
 */
export function hideHostCommands(names, mirrorRoot, path = process.env.PATH ?? '') {
  if (process.platform === 'win32') return path
  const hidden = new Set(names)
  return path.split(delimiter).filter((dir) => isAbsolute(dir)).map((dir, index) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return dir
    }
    if (!entries.some((entry) => hidden.has(entry))) return dir
    const mirror = join(mirrorRoot, String(index))
    try {
      mkdirSync(mirror, { recursive: true })
    } catch {
      return dir
    }
    for (const entry of entries) {
      if (hidden.has(entry)) continue
      try {
        symlinkSync(join(dir, entry), join(mirror, entry))
      } catch {
        // best-effort: a command that cannot be linked is missing from this test run only.
      }
    }
    return mirror
  }).join(delimiter)
}

/** The one omp natives cache that every sandbox home shares: `<XDG_CACHE_HOME or ~/.cache>/cez/
 *  test-omp-natives`, in the account's real home, never a sandbox's. Undefined when the account
 *  has no home to read. */
export function sharedOmpNativesCache(env = process.env) {
  try {
    const cacheHome = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME)
      ? env.XDG_CACHE_HOME
      : join(userInfo().homedir, '.cache')
    return join(cacheHome, 'cez', 'test-omp-natives')
  } catch {
    return undefined
  }
}

/**
 * Point `<home>/.omp/natives` at the shared cache (hearsay-tools/cezarion#1911). The compiled
 * omp unpacks its 373 MB native addon into `~/.omp/natives/<version>` when that file is
 * missing, so every sandbox home that ran omp held its own copy. omp writes each file under a
 * private temporary name and renames it into place, so two workers that unpack at once each
 * publish a whole file. Removing a sandbox removes the link, not the cache. Returns the cache,
 * or undefined when the link could not be made: omp then unpacks into the sandbox as before.
 */
export function linkSharedOmpNatives(home, cache = sharedOmpNativesCache()) {
  if (!cache) return undefined
  try {
    mkdirSync(cache, { recursive: true, mode: 0o700 })
    mkdirSync(join(home, '.omp'), { recursive: true })
    // 'junction' needs no privilege on Windows; other platforms ignore the type.
    symlinkSync(cache, join(home, '.omp', 'natives'), 'junction')
    return cache
  } catch {
    return undefined
  }
}
