import { tsImport } from 'tsx/esm/api';
const { benchmarkHome } = await tsImport('../packages/cezar/scripts/benchmark-home.ts', import.meta.url);
const { homePaths, kindHomePaths } = await tsImport('../packages/cezar/src/home/home.ts', import.meta.url);
const { nativePathPlatform, oneRootKinds } = await tsImport('../packages/cezar/src/home/kind-roots.ts', import.meta.url);
const { readInstallMarker } = await tsImport('../packages/cezar/src/home/install-marker.ts', import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('the shared test server pins both controls after scrubbing conflicting inherited values', () => {
  const root = mkdtempSync(join(tmpdir(), 'raw-env-'));
  const source = read('.ai/scripts/test-env-up.sh');
  const controls = source.slice(source.indexOf('for name in $(node -e'), source.indexOf('\nFORCE=0'));
  try {
    const result = execFileSync('sh', ['-c', controls + '\nnode -e \'process.stdout.write(JSON.stringify([process.env.CEZ_DRY_RUN, process.env.HSQ_DRY_RUN, process.env.CEZ_HOME, process.env.HSQ_HOME]))\''], {
      env: {...process.env, QA_DIR: root, REPO_ROOT: process.cwd(), CEZ_DRY_RUN: '0', HSQ_DRY_RUN: '0', CEZ_HOME: '/wrong', HSQ_HOME: '/wrong'}, encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(result), ['1', '1', join(root, 'cez-home'), join(root, 'cez-home')]);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('the live question probe clears dry-run under both names and pins naming off', () => {
  const source = read('.ai/scripts/probe-questions.ts');
  const controls = source.match(/delete process.env.CEZ_DRY_RUN;[^\n]*\nprocess.env.HSQ_AUTONAME = process.env.CEZ_AUTONAME = '0';/)?.[0];
  assert.ok(controls);
  const result = execFileSync(process.execPath, ['-e', controls + '\nprocess.stdout.write(JSON.stringify([process.env.CEZ_DRY_RUN, process.env.HSQ_DRY_RUN, process.env.CEZ_AUTONAME, process.env.HSQ_AUTONAME]));'], {
    env: {...process.env, HSQ_DRY_RUN: '1', CEZ_DRY_RUN: '1', HSQ_AUTONAME: '1'}, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(result), [null, null, '0', '0']);
});


test('project-probe benchmark isolates its child home despite an inherited preferred home', {skip: process.platform !== 'linux'}, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = mkdtempSync(join(tmpdir(), 'project-probe-env-'));
  try {
    // bound: one repeat includes nine real five-second cache expirations plus fixture setup.
    await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../packages/cezar/scripts/benchmark-project-probes.mjs', import.meta.url)), '--repeats', '1', '--out', join(root, 'results.json')], {
      timeout: 120_000, env: {...process.env, HSQ_HOME: join(root, 'wrong-inherited-home')},
    });
    const results = JSON.parse(readFileSync(join(root, 'results.json'), 'utf8'));
    assert.equal(results.rows.length, 36);
    assert.ok(results.rows.every(row => row.requests === row.concurrency));
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(root, 'wrong-inherited-home')), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('health measurement pins its isolated home and dry-run under both names', () => {
  const source = read('packages/cezar/scripts/measure-transcript-facts-health.mjs');
  const controls = source.split('\n').filter(line => /^process.env.(?:HSQ_HOME|HSQ_DRY_RUN) =/.test(line)).join('\n');
  const result = execFileSync(process.execPath, ['-e', "const {join} = require('node:path'); const root = '/sandbox';\n" + controls + '\nprocess.stdout.write(JSON.stringify([process.env.CEZ_HOME, process.env.HSQ_HOME, process.env.CEZ_DRY_RUN, process.env.HSQ_DRY_RUN]));'], {
    env: {...process.env, HSQ_HOME: '/live', HSQ_DRY_RUN: '0'}, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(result), ['/sandbox/home', '/sandbox/home', '1', '1']);
});

for (const layout of ['legacy', 'split']) {
  test(`benchmark home prepares the selected config root in ${layout} layout`, () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-base-'));
    const home = layout === 'split'
      ? kindHomePaths(oneRootKinds(root, nativePathPlatform), layout, nativePathPlatform, root)
      : homePaths(root, join(root, '.cache'), root);
    try {
      assert.equal(benchmarkHome(home), home);
      assert.equal(readInstallMarker(home.config)?.kind, 'test');
      assert.equal(readInstallMarker(join(home.config, 'config')), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}


test('run-store benchmark child opens its isolated home in the selected layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-store-home-'));
  const result = join(root, 'result.json');
  try {
    execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../packages/cezar/scripts/benchmark-run-store.ts', import.meta.url)),
      '--child', '--size', '1', '--profile', 'legacy', '--samples', '1', '--budget-seconds', '1',
      '--duration', '1', '--metrics', 'open', '--result', result], {
      timeout: 30_000, // bound: one store-open sample plus fixture startup and teardown.
      env: { ...process.env }, stdio: 'pipe',
    });
    const sample = JSON.parse(readFileSync(result, 'utf8'));
    assert.equal(sample.size, 1);
    assert.equal(sample.sync.open.length, 1);
    assert.ok(sample.sync.open[0] >= 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
