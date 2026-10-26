import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'

// The temp sandboxes of the test entry points: scripts/test-git-env.mjs (node:test and the
// browser e2e workers), packages/cezar/vitest.setup.ts and packages/web/vitest.setup.ts.
// A sandbox used to leave only in an `exit` hook or an `afterAll`, and neither runs when the
// process ends on a signal: Vitest 4 stops every fork worker with SIGTERM, and a cancelled
// or timed-out run kills its workers. Hosts collected thousands of sandboxes
// (hearsay-tools/cezarion#1394, hearsay-tools/cezarion#1395). Now each sandbox names its owner
// process, the next sandbox of the same kind removes those whose owner is gone, and a signal
// removes the process's own sandboxes before the process ends.

/** Inside every sandbox: `{ pid, host, user }` of the process that owns it. */
export const OWNER_FILE = '.cez-test-owner'

/** The fixed OS temp root, not the inherited TMPDIR: a cezar task pins TMPDIR inside its
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

/** The account name, or undefined when the account has none to read. */
function accountName() {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}

/** POSIX compares the directory's uid. Windows has no uid and a temp root that every account
 *  shares, so the marker's account name decides there, and an unknown account matches nothing. */
function sameAccount(stat, owner, { uid, user }) {
  return uid !== undefined ? stat.uid === uid : user !== undefined && owner.user === user
}

/** A directory of this account whose marker names an exited process on `host`. */
function ownerGone(dir, alive, host, account) {
  let stat
  try {
    stat = lstatSync(dir)
  } catch {
    return false
  }
  const owner = stat.isDirectory() ? readOwner(dir) : undefined
  return owner !== undefined && sameAccount(stat, owner, account) && owner.host === host &&
    owner.pid !== process.pid && !alive(owner.pid)
}

/**
 * Remove the `<root>/<prefix>*` sandboxes whose owner process on this host has exited, and
 * return their paths. Everything else stays: a live owner, an owner on another host (a
 * container sharing this temp root), a missing or unreadable marker (a sandbox still being
 * created, or one from before the marker existed), a symlink, and another account's directory.
 * A recycled process ID keeps a dead sandbox until that process exits too.
 */
export function reapTestSandboxes(prefix, root = osTempRoot(), {
  alive = processAlive,
  host = hostname(),
  account = { uid: process.getuid?.(), user: accountName() },
} = {}) {
  let names
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const reaped = []
  for (const name of names) {
    const dir = join(root, name)
    if (!name.startsWith(prefix) || !ownerGone(dir, alive, host, account)) continue
    try {
      rmSync(dir, REMOVE_OPTIONS)
      reaped.push(dir)
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
        rmSync(dir, REMOVE_OPTIONS)
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
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, host: hostname(), user: accountName() }))
  return dir
}

/** Remove every path, even after one removal fails, then throw the first failure. A path that
 *  could not be removed stays on the exit and signal cleanup list. */
export function removeTestSandboxes(paths, remove = (path) => rmSync(path, REMOVE_OPTIONS)) {
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
