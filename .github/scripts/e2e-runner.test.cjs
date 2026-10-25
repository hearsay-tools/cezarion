const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Run the real dispatcher, replacing only the expensive server/browser boot and
// test process with executables that record the arguments they receive.
function run(t, args = [], { installed = true, exit = 0, bootExit = 0, inheritedEnv = process.env } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-e2e-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.ai/scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, '.ai/qa'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(path.join(__dirname, '../../.ai/scripts/e2e.sh'), path.join(root, '.ai/scripts/e2e.sh'));
  fs.copyFileSync(path.join(__dirname, '../../.ai/scripts/test-env-lease.mjs'), path.join(root, '.ai/scripts/test-env-lease.mjs'));
  // The lease imports the process-group helper from source; the marker makes it an ES module.
  fs.mkdirSync(path.join(root, 'packages/cezar/src'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../../packages/cezar/src/detached-process.ts'), path.join(root, 'packages/cezar/src/detached-process.ts'));
  fs.writeFileSync(path.join(root, 'packages/cezar/src/package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(root, '.ai/qa/test-env.json'), JSON.stringify({ browser: { installed } }));
  fs.writeFileSync(path.join(root, '.ai/scripts/test-env-up.sh'), `#!/bin/sh\nfor arg do\n case "$arg" in --force|--force-rebuild|--server-env=*) ;; *) exit 2;; esac\ndone\nprintf "%s\\n" "$@" > boot-args\nexit ${bootExit}\n`);
  for (const name of ['npm', 'npx']) {
    fs.writeFileSync(path.join(root, 'bin', name), `#!/bin/sh\nprintf '%s\\n' "$@" > test-args\nexit ${exit}\n`, { mode: 0o755 });
  }
  // A temporary checkout cannot join the caller checkout's lease.
  const env = { ...inheritedEnv, PATH: `${root}/bin:${process.env.PATH}` };
  for (const key of ['TEST_ENV_LEASE_TOKEN', 'TEST_ENV_LEASE_ENTRY', 'TEST_ENV_LEASE_BOOTSTRAPPED', 'TEST_ENV_LEASE_JOB', 'TEST_ENV_LEASE_BROKER']) delete env[key];
  const result = spawnSync('sh', ['.ai/scripts/e2e.sh', ...args], {
    cwd: root, encoding: 'utf8', env,
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

// hearsay-tools/cezarion#1045: shared-server opt-ins are bootstrap flags, never Vitest arguments.
test('--server-env opt-ins reach only boot, in order', (t) => {
  const r = run(t, ['--server-env=CEZ_FOLLOWUPS=1', 'smoke.e2e.ts', '--server-env=CEZ_AUTOMATIONS=1']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.boot, ['--server-env=CEZ_FOLLOWUPS=1', '--server-env=CEZ_AUTOMATIONS=1']);
  assert.ok(r.tests.includes('smoke.e2e.ts'));
  assert.ok(!r.tests.some((arg) => arg.startsWith('--server-env')));
});

// A whitespace-bearing opt-in must not split into two valid bootstrap flags when flattened.
test('--server-env carrying whitespace is refused before boot', (t) => {
  for (const arg of ['--server-env=CEZ_X=1 --force-rebuild', '--server-env=CEZ_X=1\n--force']) {
    const r = run(t, [arg, 'smoke.e2e.ts']);
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(r.boot, []);
    assert.deepEqual(r.tests, []);
    assert.match(r.stderr, /invalid --server-env/);
    assert.match(r.stderr, /TEST_E2E_STATUS=failed/);
  }
});

test('spec paths and a quoted test-name filter reach Vitest intact', (t) => {
  const filters = ['smoke.e2e.ts', 'path with spaces.e2e.ts', '-t', String.raw`opens (drawer|dialog) \[safely\]`];
  const r = run(t, ['--force', ...filters, '--force-rebuild']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.boot, ['--force', '--force-rebuild']);
  assert.deepEqual(r.tests, ['exec', '--', 'vitest', 'run', '--config', 'packages/web/e2e/vitest.config.ts', ...filters]);
  assert.match(r.stdout, /TEST_E2E_STATUS=passed/);
});

test('long-form test filters and split shard arguments are forwarded in order', (t) => {
  const args = ['--testNamePattern=loads .*', '--shard', '1/4', 'smoke.e2e.ts'];
  const r = run(t, args);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.boot, []);
  assert.deepEqual(r.tests, ['exec', '--', 'vitest', 'run', '--config', 'packages/web/e2e/vitest.config.ts', ...args]);
});

test('an explicit separator ends wrapper flag parsing', (t) => {
  const r = run(t, ['--force', '--', '--force-rebuild']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.boot, ['--force']);
  assert.deepEqual(r.tests, ['exec', '--', 'vitest', 'run', '--config', 'packages/web/e2e/vitest.config.ts', '--', '--force-rebuild']);
});

test('a filtered test failure still reports failed rather than passed', (t) => {
  const r = run(t, ['smoke.e2e.ts', '-t', 'missing test'], { exit: 1 });
  assert.equal(r.status, 1);
  assert.ok(r.tests.includes('missing test'));
  assert.match(r.stderr, /TEST_E2E_STATUS=failed/);
  assert.doesNotMatch(r.stdout, /TEST_E2E_STATUS=passed/);
});

test('bootstrap failure prevents filtered test execution and reports failure', (t) => {
  const r = run(t, ['--force-rebuild', 'smoke.e2e.ts'], { bootExit: 1 });
  assert.equal(r.status, 1);
  assert.deepEqual(r.boot, ['--force-rebuild']);
  assert.deepEqual(r.tests, []);
  assert.match(r.stderr, /TEST_E2E_STATUS=failed/);
});

test('unavailable browser skips filtered runs without executing tests', (t) => {
  const r = run(t, ['smoke.e2e.ts', '-t', 'opens drawer'], { installed: false });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.tests, []);
  assert.match(r.stdout, /TEST_E2E_STATUS=skipped/);
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

test('a temporary checkout does not inherit another checkout lease', (t) => {
  const r = run(t, [], { inheritedEnv: { ...process.env, TEST_ENV_LEASE_TOKEN: 'other-checkout', TEST_ENV_LEASE_ENTRY: 'other-entry', TEST_ENV_LEASE_BOOTSTRAPPED: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /TEST_E2E_STATUS=passed/);
});
