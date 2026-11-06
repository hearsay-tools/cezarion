import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestSandbox } from './test-sandbox.mjs'
import { fileURLToPath } from 'node:url'

const preload = fileURLToPath(new URL('./test-home-env.mjs', import.meta.url))

test('node:test replaces inherited home and task context before a case runs', () => {
  const code = `
    const { test } = require('node:test');
    const assert = require('node:assert/strict');
    const { homedir, userInfo } = require('node:os');
    test('sandbox is already pinned', () => {
      assert.notEqual(process.env.CEZ_HOME, '/home/developer/.cezar');
      assert.notEqual(process.env.HOME, userInfo().homedir);
      assert.equal(process.env.HOME, process.env.USERPROFILE);
      assert.equal(homedir(), process.env.HOME);
      assert.equal(process.env.CEZ_HOME, require('node:path').join(process.env.HOME, '.cezar'));
      for (const key of ['CEZ_REMOTE', 'CEZ_TASK_ID', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
        'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE',
        'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CURSOR_CONFIG_DIR']) assert.equal(process.env[key], undefined, key);
    });
  `
  const fixture = join(createTestSandbox('cez-home-preload-proof-'), 'fixture.cjs')
  writeFileSync(fixture, code)
  const result = spawnSync(process.execPath, ['--import', preload, '--test', '--test-reporter=tap', fixture], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, CEZ_HOME: '/home/developer/.cezar', HOME: '/home/developer',
      USERPROFILE: '/home/developer', CEZ_REMOTE: '1', CEZ_TASK_ID: 'live-task',
      CLAUDE_CONFIG_DIR: '/real/claude', CODEX_HOME: '/real/codex', PI_CODING_AGENT_DIR: '/real/pi',
      PI_CONFIG_DIR: '/real/omp', OMP_PROFILE: 'work', PI_PROFILE: 'work',
      XDG_CONFIG_HOME: '/real/config', XDG_DATA_HOME: '/real/data', CURSOR_CONFIG_DIR: '/real/cursor' },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 1/)
})
