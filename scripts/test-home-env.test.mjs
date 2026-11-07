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
      assert.notEqual(process.env.HSQ_HOME, '/home/developer/squawk');
      assert.equal(process.env.HSQ_HOME, process.env.CEZ_HOME);
      assert.notEqual(process.env.HOME, userInfo().homedir);
      assert.equal(process.env.HOME, process.env.USERPROFILE);
      assert.equal(homedir(), process.env.HOME);
      assert.equal(process.env.CEZ_HOME, require('node:path').join(process.env.HOME, '.cezar'));
      for (const key of ['CEZ_REMOTE', 'CEZ_TASK_ID', 'HSQ_REMOTE', 'HSQ_TASK_ID', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
        'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE',
        'CURSOR_CONFIG_DIR']) assert.equal(process.env[key], undefined, key);
      for (const [key, suffix] of Object.entries({ XDG_CONFIG_HOME: '.config', XDG_DATA_HOME: '.local/share',
        XDG_STATE_HOME: '.local/state', XDG_CACHE_HOME: '.cache' })) {
        const expected = require('node:path').join(process.env.HOME, suffix);
        assert.equal(process.env[key], expected);
        assert.notEqual(process.env[key], '/real/' + key);
        assert.equal(require('node:path').relative(process.env.HOME, process.env[key]).startsWith('..'), false);
      }
      assert.equal(process.env.XDG_RUNTIME_DIR, undefined);
    });
  `
  const fixture = join(createTestSandbox('cez-home-preload-proof-'), 'fixture.cjs')
  writeFileSync(fixture, code)
  const result = spawnSync(process.execPath, ['--import', preload, '--test', '--test-reporter=tap', fixture], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, CEZ_HOME: '/home/developer/.cezar', HSQ_HOME: '/home/developer/squawk', HOME: '/home/developer',
      USERPROFILE: '/home/developer', CEZ_REMOTE: '1', CEZ_TASK_ID: 'live-task', HSQ_REMOTE: '1', HSQ_TASK_ID: 'live-task',
      CLAUDE_CONFIG_DIR: '/real/claude', CODEX_HOME: '/real/codex', PI_CODING_AGENT_DIR: '/real/pi',
      PI_CONFIG_DIR: '/real/omp', OMP_PROFILE: 'work', PI_PROFILE: 'work',
      XDG_CONFIG_HOME: '/real/XDG_CONFIG_HOME', XDG_DATA_HOME: '/real/XDG_DATA_HOME',
      XDG_STATE_HOME: '/real/XDG_STATE_HOME', XDG_CACHE_HOME: '/real/XDG_CACHE_HOME',
      XDG_RUNTIME_DIR: '/real/runtime', CURSOR_CONFIG_DIR: '/real/cursor' },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 1/)
})
