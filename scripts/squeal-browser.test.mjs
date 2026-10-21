import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createVitest, parseCLI } from 'vitest/node';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));

async function list(options = {}) {
  const vitest = await createVitest('test', { root, watch: false, reporters: [], ...options });
  try {
    await vitest.standalone();
    return await vitest.globTestSpecifications();
  } finally {
    await vitest.close();
  }
}

test('Squeal can discover browser E2E through the root Vitest configuration', async () => {
  const specs = await list();
  assert.ok(specs.some(spec => spec.project.name === 'e2e' && spec.moduleId.endsWith('/smoke.e2e.ts')),
    'the root configuration must expose browser E2E to Squeal');
});

test('npm test selects only the four unit projects without starting a browser', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { options } = parseCLI(manifest.scripts.test);
  const specs = await list(options);
  assert.deepEqual([...new Set(specs.map(spec => spec.project.name))].sort(),
    ['api-client', 'contract', 'server', 'web']);
  assert.ok(specs.every(spec => !spec.moduleId.endsWith('.e2e.ts')));
});

function bootstrap(t, { installed = true, bootExit = 0, tmp, registryFailure, borrowed = false } = {}) {
  const source = new URL('../packages/web/e2e/environment.ts', import.meta.url);
  assert.ok(existsSync(source), 'browser E2E needs an environment globalSetup');
  const fixture = mkdtempSync(join(tmpdir(), 'cez-squeal-browser-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, 'packages/web/e2e'), { recursive: true });
  mkdirSync(join(fixture, '.ai/scripts'), { recursive: true });
  const modulePath = join(fixture, 'packages/web/e2e/environment.ts');
  copyFileSync(source, modulePath);
  copyFileSync(new URL('../.ai/scripts/test-env-lease.mjs', import.meta.url),
    join(fixture, '.ai/scripts/test-env-lease.mjs'));
  // Replace only the server-dependent registry pin. Check committed ownership at
  // its restoration boundary, where releasing the lease too early would race.
  writeFileSync(join(fixture, 'packages/web/e2e/workspace-registry.ts'), `
    import { DatabaseSync } from 'node:sqlite';
    import { writeFileSync } from 'node:fs';
    export async function setup() {
      ${registryFailure === 'setup' ? "throw new Error('registry setup failed');" : ''}
      return () => {
        const db = new DatabaseSync('.ai/qa/test-env-lease.sqlite', { readOnly: true });
        const n = db.prepare('SELECT count(*) AS n FROM holders').get().n;
        db.close();
        if (!n) throw new Error('registry restored after lease release');
        writeFileSync('registry-restored', 'restored');
        ${registryFailure === 'restore' ? "throw new Error('registry restore failed');" : ''}
      };
    }
  `);
  copyFileSync(new URL('../.ai/scripts/resolve-browser-launch.mjs', import.meta.url),
    join(fixture, '.ai/scripts/resolve-browser-launch.mjs'));
  const runtimeTmp = join(fixture, 'browser-tmp');
  mkdirSync(runtimeTmp);
  const descriptor = JSON.stringify({ browser: {
    installed, notes: 'Chrome fixture unavailable', runtimeEnv: { TMPDIR: runtimeTmp },
  } }).replace(/'/g, "'\\''");
  writeFileSync(join(fixture, '.ai/scripts/test-env-up.sh'), `#!/bin/sh
printf 'booted\\n' > booted
mkdir -p .ai/qa
printf '%s\\n' '${descriptor}' > .ai/qa/test-env.json
exit ${bootExit}
`);
  const callerTmp = tmp ?? '/tmp';
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import { acquireTestEnvLease } from ${JSON.stringify(pathToFileURL(join(fixture, '.ai/scripts/test-env-lease.mjs')).href)};
    import { setup } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    let outer;
    if (${borrowed}) {
      outer = await acquireTestEnvLease(process.cwd());
      process.env.TEST_ENV_LEASE_TOKEN = outer.token;
      process.env.TEST_ENV_LEASE_BOOTSTRAPPED = '1';
      writeFileSync('.ai/qa/test-env.json', JSON.stringify({ browser: { installed: true } }));
    }
    const teardown = await setup();
    const tmp = process.env.TMPDIR;
    const existed = existsSync(tmp);
    teardown();
    outer?.release();
    console.log(JSON.stringify({ tmp, existed, removed: !existsSync(tmp), restored: process.env.TMPDIR }));
  `], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, TEST_ENV_LEASE_TOKEN: '', TEST_ENV_LEASE_ENTRY: '', TEST_ENV_LEASE_BOOTSTRAPPED: '', TEST_ENV_LEASE_JOB: '', TEST_ENV_LEASE_BROKER: '', TMPDIR: callerTmp, TMP: callerTmp, TEMP: callerTmp },
  });
  return { ...result, fixture, runtimeTmp, callerTmp };
}

function report(result) {
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

// hearsay-tools/cezarion#1090: the descriptor's runtimeEnv is the answer for whoever booted
// the shared env; globalSetup decides the socket-safe TMPDIR from its own caller's env.
test('browser globalSetup runs the project bootstrap and keeps its caller’s short TMPDIR', t => {
  const result = bootstrap(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(result.fixture, 'booted'), 'utf8'), 'booted\n');
  assert.equal(report(result).tmp, result.callerTmp);
  assert.notEqual(report(result).tmp, result.runtimeTmp);
  assert.equal(readFileSync(join(result.fixture, 'registry-restored'), 'utf8'), 'restored');
});

test('browser globalSetup gives an over-budget caller a short TMPDIR and removes it at teardown', t => {
  const result = bootstrap(t, { tmp: `/${'x'.repeat(120)}` });
  assert.equal(result.status, 0, result.stderr);
  const { tmp, existed, removed, restored } = report(result);
  assert.ok(tmp.startsWith('/tmp/cez-e2e-'), tmp);
  assert.equal(existed, true);
  assert.equal(removed, true);
  assert.equal(restored, result.callerTmp);
});

test('a browser unavailable after bootstrap cannot become a passing Squeal result', t => {
  const result = bootstrap(t, { installed: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Chrome fixture unavailable/);
});

test('failed browser environment bootstrap prevents test execution', t => {
  const result = bootstrap(t, { bootExit: 9 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bootstrap failed/);
});

test('wrapper-owned globalSetup joins the live lease without bootstrapping a second time', t => {
  const result = bootstrap(t, { borrowed: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(result.fixture, 'booted')), false);
  assert.equal(existsSync(join(result.fixture, 'registry-restored')), true);
});

for (const failure of [{ installed: false }, { bootExit: 9 }, { registryFailure: 'setup' }, { registryFailure: 'restore' }]) {
  test(`globalSetup releases its committed lease after failure ${JSON.stringify(failure)}`, t => {
    const result = bootstrap(t, failure);
    assert.notEqual(result.status, 0, result.stderr);
    const db = new DatabaseSync(join(result.fixture, '.ai/qa/test-env-lease.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM holders').get().n, 0); }
    finally { db.close(); }
  });
}
