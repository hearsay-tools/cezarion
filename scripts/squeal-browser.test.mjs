import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createVitest, parseCLI } from 'vitest/node';

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

function bootstrap(t, { installed = true, bootExit = 0 } = {}) {
  const source = new URL('../packages/web/e2e/environment.ts', import.meta.url);
  assert.ok(existsSync(source), 'browser E2E needs an environment globalSetup');
  const fixture = mkdtempSync(join(tmpdir(), 'cez-squeal-browser-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, 'packages/web/e2e'), { recursive: true });
  mkdirSync(join(fixture, '.ai/scripts'), { recursive: true });
  const modulePath = join(fixture, 'packages/web/e2e/environment.ts');
  copyFileSync(source, modulePath);
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
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { setup } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    await setup();
    console.log(JSON.stringify({ tmp: process.env.TMPDIR }));
  `], { cwd: fixture, encoding: 'utf8', timeout: 10_000 });
  return { ...result, fixture, runtimeTmp };
}

test('browser globalSetup runs the project bootstrap and forwards its runtime environment', t => {
  const result = bootstrap(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(result.fixture, 'booted'), 'utf8'), 'booted\n');
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).tmp, result.runtimeTmp);
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
