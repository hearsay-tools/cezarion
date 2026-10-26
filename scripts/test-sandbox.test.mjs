import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { OWNER_FILE, createTestSandbox, linkSharedOmpNatives, reapTestSandboxes, removeTestSandboxes, sharedOmpNativesCache } from './test-sandbox.mjs'

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
