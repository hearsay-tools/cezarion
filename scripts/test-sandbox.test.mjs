import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { OWNER_FILE, createTestSandbox, hideHostCommands, linkSharedOmpNatives, reapTestSandboxes, removeTestSandboxes, sharedOmpNativesCache, stopSandboxProcesses } from './test-sandbox.mjs'

const preload = fileURLToPath(new URL('./test-git-env.mjs', import.meta.url))
const helper = new URL('./test-sandbox.mjs', import.meta.url).href

const scratch = (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-sandbox-test-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** A process with the node:test preload that prints its sandbox, then holds or exits. */
const PRINT_SANDBOX = 'process.stdout.write(require("node:path").dirname(process.env.GIT_CONFIG_GLOBAL) + "\\n")'

const runPreload = () => {
  const run = spawnSync(process.execPath, ['--import', preload, '-e', PRINT_SANDBOX], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.trim()
}

const startHolder = async () => {
  const child = spawn(process.execPath, ['--import', preload, '-e', `${PRINT_SANDBOX}; setInterval(() => {}, 1000)`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  while (!out.includes('\n')) out += (await once(child.stdout, 'data'))[0]
  return { child, sandbox: out.trim() }
}

const exitOf = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode }
  const [code, signal] = await once(child, 'exit')
  return { code, signal }
}

test('reaps only the sandboxes whose owner process on this host has exited', (t) => {
  const root = scratch(t)
  const sandbox = (name, marker) => {
    const dir = join(root, name)
    mkdirSync(dir)
    if (marker !== undefined) writeFileSync(join(dir, OWNER_FILE), typeof marker === 'string' ? marker : JSON.stringify(marker))
    return dir
  }
  const host = hostname()
  const dead = sandbox('cez-x-dead', { pid: 101, host })
  const kept = [
    sandbox('cez-x-live', { pid: 102, host }),
    sandbox('cez-x-elsewhere', { pid: 101, host: 'another-host' }),
    sandbox('cez-x-markerless'),
    sandbox('cez-x-torn', '{"pid":'),
    sandbox('cez-y-dead', { pid: 101, host }),
    sandbox('target', { pid: 101, host }),
  ]
  symlinkSync(join(root, 'target'), join(root, 'cez-x-link'))

  assert.deepEqual(reapTestSandboxes('cez-x-', root, { alive: (pid) => pid !== 101 }), [dead])
  assert.equal(existsSync(dead), false)
  for (const dir of kept) assert.ok(existsSync(dir), dir)
  assert.ok(lstatSync(join(root, 'cez-x-link')).isSymbolicLink())
})

test('without a uid (Windows), reaps nothing: no marker proves the account there', (t) => {
  const root = scratch(t)
  // Two Windows accounts can share one name, so a marker that names this account proves nothing.
  const dirs = [{ user: 'me' }, {}].map((marker, i) => {
    const dir = join(root, `cez-w-${i}`)
    mkdirSync(dir)
    writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: 101, host: hostname(), ...marker }))
    return dir
  })

  assert.deepEqual(reapTestSandboxes('cez-w-', root, { alive: () => false, account: { user: 'me' } }), [])
  for (const dir of dirs) assert.ok(existsSync(dir), dir)
})

test('createTestSandbox marks the sandbox with this process and reaps the dead ones first', (t) => {
  const root = scratch(t)
  const stale = join(root, 'cez-x-stale')
  mkdirSync(stale)
  // A child that has exited and been waited for: its process ID names no live process.
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  writeFileSync(join(stale, OWNER_FILE), JSON.stringify({ pid, host: hostname() }))

  const dir = createTestSandbox('cez-x-', root)
  t.after(() => removeTestSandboxes([dir]))
  assert.equal(existsSync(stale), false)
  assert.ok(dir.startsWith(join(root, 'cez-x-')))
  assert.deepEqual(JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8')), { pid: process.pid, host: hostname() })
})

test('removeTestSandboxes tries every path, then throws the first failure (hearsay-tools/cezarion#1395)', () => {
  const tried = []
  const first = new Error('ENOTEMPTY: the user home')
  assert.throws(() => removeTestSandboxes(['home', 'user-home', 'temp'], (path) => {
    tried.push(path)
    if (path === 'home') throw first
    if (path === 'user-home') throw new Error('EBUSY')
  }), first)
  assert.deepEqual(tried, ['home', 'user-home', 'temp'])
})

const linux = process.platform === 'linux' ? false : 'reads /proc'

/** A child that holds until killed. `ready` prints once it runs. */
const startChild = async (t, options) => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'inherit'], ...options,
  })
  t.after(() => child.kill('SIGKILL'))
  await once(child.stdout, 'data')
  return child
}

/** Wait for a child's exit, failing after `ms`. */
const exitWithin = (child, ms) => Promise.race([
  exitOf(child),
  // bound: a child the cleanup missed holds forever; fail instead of hanging the file.
  new Promise((_, reject) => setTimeout(() => reject(new Error(`child ${child.pid} still runs after ${ms} ms`)), ms).unref()),
])

test('removeTestSandboxes stops a late writer first, so it cannot rebuild the sandbox (hearsay-tools/cezarion#2453)', { skip: linux }, async (t) => {
  const root = scratch(t)
  const dir = createTestSandbox('cez-late-', root)
  // Like gh or tsx after a test ends: it keeps creating its folder under TMPDIR, which rebuilt
  // the removed sandbox without its owner marker, out of the reaper's reach.
  const writer = spawn(process.execPath, ['-e', `
    const { mkdirSync } = require('node:fs')
    const write = () => mkdirSync(require('node:path').join(process.env.TMPDIR, 'late'), { recursive: true })
    write(); process.stdout.write('ready\\n'); setInterval(write, 5)`], {
    cwd: root, env: { ...process.env, TMPDIR: dir }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => writer.kill('SIGKILL'))
  await once(writer.stdout, 'data')

  removeTestSandboxes([dir])
  assert.deepEqual(await exitWithin(writer, 5_000), { code: null, signal: 'SIGTERM' })
  assert.equal(existsSync(dir), false)
})

test('stopSandboxProcesses stops what runs in or points into a sandbox, and nothing else', { skip: linux }, async (t) => {
  const root = scratch(t)
  const sandbox = join(root, 'cez-stop-sandbox')
  const elsewhere = join(root, 'cez-stop-sandbox-other')
  for (const dir of [sandbox, join(sandbox, 'cwd'), elsewhere]) mkdirSync(dir)
  const byEnv = await startChild(t, { cwd: root, env: { ...process.env, HOME: join(sandbox, 'home') } })
  const byCwd = await startChild(t, { cwd: join(sandbox, 'cwd') })
  // A name that only shares the sandbox's prefix is not inside it.
  const unrelated = await startChild(t, { cwd: elsewhere, env: { ...process.env, TMPDIR: elsewhere } })

  assert.deepEqual(stopSandboxProcesses([sandbox]).sort(), [byEnv.pid, byCwd.pid].sort())
  for (const child of [byEnv, byCwd]) assert.deepEqual(await exitWithin(child, 5_000), { code: null, signal: 'SIGTERM' })
  assert.equal(unrelated.exitCode, null)
  assert.equal(unrelated.signalCode, null)
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0))
})

test('stopSandboxProcesses kills what ignores SIGTERM once the grace ends', { skip: linux }, async (t) => {
  const root = scratch(t)
  const sandbox = join(root, 'cez-stop-stubborn')
  mkdirSync(sandbox)
  // A handler replaces SIGTERM's default action: this child outlives it.
  const ignoring = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
    cwd: sandbox, stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => ignoring.kill('SIGKILL'))
  await once(ignoring.stdout, 'data')

  assert.deepEqual(stopSandboxProcesses([sandbox], { graceMs: 100 }), [ignoring.pid])
  assert.deepEqual(await exitWithin(ignoring, 5_000), { code: null, signal: 'SIGKILL' })
})

test('reaps unmarked sandboxes older than the age limit, only of this prefix and account, at most the limit per call (hearsay-tools/cezarion#2453)', (t) => {
  const root = scratch(t)
  const now = Date.now()
  const hour = 60 * 60 * 1000
  const dir = (name, { ageMs, marker } = {}) => {
    const path = join(root, name)
    mkdirSync(path)
    // What a late writer rebuilds: its own folder, no owner marker.
    mkdirSync(join(path, 'tsx-1001'))
    if (marker !== undefined) writeFileSync(join(path, OWNER_FILE), marker)
    const at = new Date(now - ageMs)
    utimesSync(path, at, at)
    return path
  }
  const old = [dir('cez-u-old-1', { ageMs: 2 * hour }), dir('cez-u-old-2', { ageMs: hour + 1 }), dir('cez-u-torn', { ageMs: 2 * hour, marker: '{"pid":' })]
  const kept = [
    dir('cez-u-new', { ageMs: hour - 1_000 }),
    dir('cez-v-old', { ageMs: 2 * hour }),
    dir('target', { ageMs: 2 * hour }),
  ]
  symlinkSync(join(root, 'target'), join(root, 'cez-u-link'))
  const options = { alive: () => true, now: () => now }

  assert.deepEqual(reapTestSandboxes('cez-u-', root, { ...options, account: { uid: process.getuid?.() + 1 } }), [])
  if (process.getuid === undefined) return
  const first = reapTestSandboxes('cez-u-', root, { ...options, unmarkedLimit: 2 })
  assert.equal(first.length, 2)
  assert.deepEqual([...first, ...reapTestSandboxes('cez-u-', root, options)].sort(), old.sort())
  for (const path of old) assert.equal(existsSync(path), false, path)
  for (const path of kept) assert.ok(existsSync(path), path)
  assert.ok(lstatSync(join(root, 'cez-u-link')).isSymbolicLink())
})

test('a removal that fails partway keeps the owner marker, so the reaper can still find it', { skip: process.getuid?.() === 0 || process.platform === 'win32' ? 'needs a non-root POSIX account' : false }, (t) => {
  const root = scratch(t)
  const dir = createTestSandbox('cez-partial-', root)
  const locked = join(dir, 'a-locked')
  mkdirSync(locked)
  writeFileSync(join(locked, 'file'), '')
  chmodSync(locked, 0o500)
  t.after(() => existsSync(locked) && chmodSync(locked, 0o700))

  assert.throws(() => removeTestSandboxes([dir]))
  assert.ok(existsSync(join(dir, OWNER_FILE)))
  chmodSync(locked, 0o700)
  removeTestSandboxes([dir])
  assert.equal(existsSync(dir), false)
})

test('hideHostCommands mirrors every PATH directory that holds a hidden command, without it (hearsay-tools/cezarion#1916)', { skip: process.platform === 'win32' ? 'POSIX PATH' : false }, (t) => {
  const root = scratch(t)
  const withRunner = join(root, 'with-runner')
  const without = join(root, 'without')
  for (const path of [withRunner, without]) mkdirSync(path)
  for (const name of ['omp', 'node-tool']) writeFileSync(join(withRunner, name), '')
  writeFileSync(join(without, 'git-tool'), '')
  symlinkSync('node-tool', join(withRunner, 'relative-link'))
  const missing = join(root, 'missing')

  const path = hideHostCommands(['omp', 'pi'], join(root, 'mirror'), [withRunner, without, missing, 'relative'].join(delimiter))
  const [mirror, ...rest] = path.split(delimiter)
  assert.deepEqual(rest, [without, missing, 'relative'])
  assert.ok(mirror.startsWith(join(root, 'mirror')))
  assert.deepEqual(readdirSync(mirror).sort(), ['node-tool', 'relative-link'])
  assert.equal(realpathSync(join(mirror, 'relative-link')), join(withRunner, 'node-tool'))
  assert.equal(existsSync(join(mirror, 'omp')), false)
})

test('the node:test preload removes its sandbox when the process exits (hearsay-tools/cezarion#1394)', () => {
  const sandbox = runPreload()
  assert.match(sandbox, /cez-test-git-/)
  assert.equal(existsSync(sandbox), false)
})

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`the node:test preload removes its sandbox on ${signal} and still ends on it (hearsay-tools/cezarion#1394)`, async () => {
    const { child, sandbox } = await startHolder()
    assert.ok(existsSync(sandbox))
    child.kill(signal)
    assert.deepEqual(await exitOf(child), { code: null, signal })
    assert.equal(existsSync(sandbox), false)
  })
}

test('a sandbox left by SIGKILL goes when the next process starts, a live owner’s stays', async () => {
  const killed = await startHolder()
  const live = await startHolder()
  try {
    killed.child.kill('SIGKILL')
    await exitOf(killed.child)
    assert.ok(existsSync(killed.sandbox), 'SIGKILL runs no cleanup')

    runPreload()
    assert.equal(existsSync(killed.sandbox), false)
    assert.ok(existsSync(live.sandbox))
  } finally {
    live.child.kill('SIGTERM')
    await exitOf(live.child)
  }
  assert.equal(existsSync(live.sandbox), false)
})

test('every sandbox home links one shared omp natives cache, also when two link at once (hearsay-tools/cezarion#1911)', async (t) => {
  const root = scratch(t)
  const cache = join(root, 'cache', 'cez', 'test-omp-natives')
  const homes = ['home-a', 'home-b'].map((name) => join(root, name))
  for (const home of homes) mkdirSync(home)
  const link = `import { linkSharedOmpNatives } from ${JSON.stringify(helper)}
process.stdout.write(String(linkSharedOmpNatives(process.argv[1], process.argv[2])))`
  const runs = homes.map((home) => spawn(process.execPath, ['--input-type=module', '-e', link, home, cache], { stdio: ['ignore', 'pipe', 'inherit'] }))
  const printed = await Promise.all(runs.map(async (child) => {
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    assert.deepEqual(await exitOf(child), { code: 0, signal: null })
    return out
  }))

  assert.deepEqual(printed, [cache, cache])
  for (const home of homes) {
    const natives = join(home, '.omp', 'natives')
    assert.ok(lstatSync(natives).isSymbolicLink())
    assert.equal(readlinkSync(natives), cache)
  }
  assert.ok(statSync(cache).isDirectory())
  if (process.platform !== 'win32') assert.equal(statSync(cache).mode & 0o777, 0o700)

  // Removing a sandbox home removes the link, never the shared cache.
  rmSync(homes[0], { recursive: true, force: true })
  assert.ok(existsSync(cache))
})

test('the shared omp natives cache lives in the account home, or under an absolute XDG_CACHE_HOME', () => {
  const accountCache = join(userInfo().homedir, '.cache', 'cez', 'test-omp-natives')
  assert.equal(sharedOmpNativesCache({}), accountCache)
  // A sandbox HOME never moves it: the setup has replaced HOME by the time it links.
  assert.equal(sharedOmpNativesCache({ HOME: '/tmp/cez-vitest-tmp-x/home' }), accountCache)
  assert.equal(sharedOmpNativesCache({ XDG_CACHE_HOME: '/srv/cache' }), join('/srv/cache', 'cez', 'test-omp-natives'))
  assert.equal(sharedOmpNativesCache({ XDG_CACHE_HOME: 'relative/cache' }), accountCache)
})

test('a home keeps no link when the shared cache cannot be created', (t) => {
  const root = scratch(t)
  const home = join(root, 'home')
  const blocker = join(root, 'not-a-directory')
  mkdirSync(home)
  writeFileSync(blocker, '')
  assert.equal(linkSharedOmpNatives(home, join(blocker, 'test-omp-natives')), undefined)
  assert.equal(existsSync(join(home, '.omp', 'natives')), false)
})
