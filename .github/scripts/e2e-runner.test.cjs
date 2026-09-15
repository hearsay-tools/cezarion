const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Run the real dispatcher, replacing only the expensive server/browser boot and
// test process with executables that record the arguments they receive.
function run(t, args = [], { installed = true, exit = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-e2e-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.ai/scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, '.ai/qa'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(path.join(__dirname, '../../.ai/scripts/e2e.sh'), path.join(root, '.ai/scripts/e2e.sh'));
  fs.writeFileSync(path.join(root, '.ai/qa/test-env.json'), JSON.stringify({ browser: { installed } }));
  fs.writeFileSync(path.join(root, '.ai/scripts/test-env-up.sh'), '#!/bin/sh\nfor arg do\n case "$arg" in --force|--force-rebuild) ;; *) exit 2;; esac\ndone\nprintf "%s\\n" "$@" > boot-args\n');
  for (const name of ['npm', 'npx']) {
    fs.writeFileSync(path.join(root, 'bin', name), `#!/bin/sh\nprintf '%s\\n' "$@" > test-args\nexit ${exit}\n`, { mode: 0o755 });
  }
  const result = spawnSync('sh', ['.ai/scripts/e2e.sh', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
  });
  const read = (name) => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n').filter(Boolean) : [];
  return { ...result, boot: read('boot-args'), tests: read('test-args') };
}

test('shard reaches the test process and bootstrap flags reach only boot', (t) => {
  const r = run(t, ['--force', '--shard=2/4', '--force-rebuild']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.boot, ['--force', '--force-rebuild']);
  assert.ok(r.tests.includes('--shard=2/4'));
  assert.ok(!r.tests.includes('--force'));
  assert.ok(!r.tests.includes('--force-rebuild'));
  assert.match(r.stdout, /TEST_E2E_STATUS=passed/);
});

test('default local run selects the full suite', (t) => {
  const r = run(t);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.tests.includes('packages/web/e2e/vitest.config.ts'));
  assert.ok(!r.tests.some((arg) => arg.startsWith('--shard')));
});

test('unavailable browser remains a local skip even with a shard', (t) => {
  const r = run(t, ['--shard=1/4'], { installed: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /TEST_E2E_STATUS=skipped/);
  assert.deepEqual(r.tests, []);
});

test('a failing shard emits failure and exits nonzero', (t) => {
  const r = run(t, ['--shard=3/4'], { exit: 1 });
  assert.notEqual(r.status, 0);
  assert.ok(r.tests.includes('--shard=3/4'));
  assert.match(r.stderr, /TEST_E2E_STATUS=failed/);
});
