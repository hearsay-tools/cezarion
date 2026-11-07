import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative, isAbsolute, win32 } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { configureTestHome } from './test-home-setup.mjs'
import { createTestSandbox } from './test-sandbox.mjs'

const paths = { XDG_CONFIG_HOME: '.config', XDG_DATA_HOME: '.local/share',
  XDG_STATE_HOME: '.local/state', XDG_CACHE_HOME: '.cache',
  HSQ_HOME: '.cezar', APPDATA: 'AppData/Roaming', LOCALAPPDATA: 'AppData/Local' }

test('one script-only setup removes inherited context and pins all home paths', () => {
  const userHome = createTestSandbox('cez-shared-home-proof-')
  const env = { HOME: '/host', USERPROFILE: '/host', CEZ_HOME: '/host/live', CEZ_TASK_ID: 'host-task',
    cez_remote: '1', hsq_remote: '1', HSQ_TASK_ID: 'host-task', CODEX_HOME: '/host/codex', XDG_RUNTIME_DIR: '/host/run',
    ...Object.fromEntries(Object.keys(paths).map(key => [key, '/host/' + key])) }
  const home = configureTestHome({ userHome }, env)
  assert.equal(env.HOME, userHome)
  assert.equal(env.USERPROFILE, userHome)
  assert.equal(env.CEZ_HOME, join(userHome, '.cezar'))
  assert.equal(JSON.parse(readFileSync(join(env.CEZ_HOME, 'install.json'), 'utf8')).kind, 'test')
  for (const key of ['CEZ_TASK_ID', 'cez_remote', 'hsq_remote', 'HSQ_TASK_ID', 'CODEX_HOME', 'XDG_RUNTIME_DIR']) assert.equal(env[key], undefined)
  for (const [key, suffix] of Object.entries(paths)) {
    assert.equal(env[key], join(userHome, suffix))
    assert.notEqual(env[key], '/host/' + key)
    assert.equal(relative(userHome, env[key]).startsWith('..'), false)
    assert.equal(isAbsolute(relative(userHome, env[key])), false)
  }
  // Per-test repair preserves beforeAll flags and the P1b explicit selector.
  env.CEZ_DRY_RUN = 'file-owned'
  home.select(join(userHome, 'explicit'))
  home.pinHome()
  assert.equal(env.CEZ_HOME, join(userHome, 'explicit'))
  assert.equal(env.HSQ_HOME, join(userHome, 'explicit'))
  home.select(undefined)
  home.pinHome()
  home.pinUserHome()
  assert.equal(env.CEZ_HOME, join(userHome, '.cezar'))
  assert.equal(env.CEZ_DRY_RUN, 'file-owned')
})

test('browser worker preload keeps host HOME and USERPROFILE but isolates other homes', () => {
  const preload = fileURLToPath(new URL('./test-browser-home-env.mjs', import.meta.url))
  const keys = ['HOME', 'USERPROFILE', 'CEZ_HOME', 'CEZ_TASK_ID', 'XDG_RUNTIME_DIR', ...Object.keys(paths)]
  const probe = `console.log(JSON.stringify({ env: Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]])),
    kind: JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.CEZ_HOME, 'install.json'), 'utf8')).kind }))`
  const result = spawnSync(process.execPath, ['--import', preload, '-e', probe], {
    encoding: 'utf8', env: { ...process.env, HOME: '/host-browser', USERPROFILE: 'C:\\host-browser',
      CEZ_HOME: '/host/live', CEZ_TASK_ID: 'host-task', XDG_RUNTIME_DIR: '/host/run',
      ...Object.fromEntries(Object.keys(paths).map(key => [key, '/host/' + key])) },
  })
  assert.equal(result.status, 0, result.stderr)
  const { env, kind } = JSON.parse(result.stdout)
  assert.equal(kind, 'test')
  assert.equal(env.HOME, '/host-browser')
  assert.equal(env.USERPROFILE, 'C:\\host-browser')
  const userHome = join(env.CEZ_HOME, '..')
  assert.notEqual(userHome, env.HOME)
  for (const [key, suffix] of Object.entries(paths)) {
    assert.equal(env[key], join(userHome, suffix))
    assert.notEqual(env[key], '/host/' + key)
  }
  assert.equal(env.XDG_RUNTIME_DIR, undefined)
  assert.equal(env.CEZ_TASK_ID, undefined)
  // Both POSIX and Windows roots stay recognizable in the exception.
  assert.equal(win32.isAbsolute(env.USERPROFILE), true)
})

