import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  TEST_ENV_INPUTS, agentBrowserVersion, readTestEnvDescriptor, readTestEnvInputs, testEnvInputsMismatch,
} from '../.ai/scripts/test-env-inputs.mjs';

// hearsay-tools/cezarion#1977: the browser test environment's settings live in a tracked inputs
// file, and its runtime state in a descriptor Squeal ignores for browser specs.
const repoRoot = resolve(import.meta.dirname, '..');
const module = join(repoRoot, '.ai/scripts/test-env-inputs.mjs');
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function checkout(inputs, descriptor) {
  const root = mkdtempSync(join(tmpdir(), 'cez-test-env-inputs-'));
  roots.push(root);
  mkdirSync(join(root, '.ai/scripts'), { recursive: true });
  mkdirSync(join(root, '.ai/qa'), { recursive: true });
  writeFileSync(join(root, TEST_ENV_INPUTS), typeof inputs === 'string' ? inputs : JSON.stringify(inputs));
  if (descriptor !== undefined) writeFileSync(join(root, '.ai/qa/test-env.json'), JSON.stringify(descriptor));
  return root;
}

const valid = { version: 1, server: { env: [] }, browser: { agentBrowserVersion: '1.2.3' } };

test('the repository inputs file is valid and pins an agent-browser release', () => {
  const { inputs, sha256 } = readTestEnvInputs(repoRoot);
  assert.match(inputs.browser.agentBrowserVersion, /^\d+\.\d+\.\d+$/);
  assert.match(sha256, /^[0-9a-f]{64}$/);
});

test('the digest is of the bytes, so any edit to the inputs changes it', () => {
  const root = checkout(valid);
  const before = readTestEnvInputs(root).sha256;
  writeFileSync(join(root, TEST_ENV_INPUTS), JSON.stringify({ ...valid, server: { env: ['CEZ_X=1'] } }));
  assert.notEqual(readTestEnvInputs(root).sha256, before);
});

for (const [name, inputs, message] of [
  ['an unknown version', { ...valid, version: 2 }, /version must be 1/],
  ['a pinned server variable', { ...valid, server: { env: ['CEZ_HOME=/elsewhere'] } }, /CEZ_DRY_RUN and CEZ_HOME are pinned/],
  ['a non-CEZ variable', { ...valid, server: { env: ['PATH=/x'] } }, /is not CEZ_NAME=value/],
  ['a value with whitespace', { ...valid, server: { env: ['CEZ_X=a b'] } }, /is not CEZ_NAME=value/],
  ['a floating browser release', { ...valid, browser: { agentBrowserVersion: 'latest' } }, /must be a release version/],
  ['invalid JSON', '{', /test-env\.inputs\.json: /],
]) {
  test(`inputs with ${name} are refused`, () => {
    assert.throws(() => readTestEnvInputs(checkout(inputs)), message);
  });
}

test('a descriptor matches only the inputs it was booted from', () => {
  const root = checkout(valid);
  const { sha256 } = readTestEnvInputs(root);
  assert.equal(testEnvInputsMismatch(root, { status: 'stopped', inputs: { sha256 } }), undefined);
  assert.match(testEnvInputsMismatch(root, { inputs: { sha256: 'other' } }) ?? '', /booted from other settings/);
  // A descriptor written before the inputs existed names no digest: never a match.
  assert.match(testEnvInputsMismatch(root, { status: 'running' }) ?? '', /records no .* digest/);
});

test('the browser seam reads the descriptor only when it matches the current inputs', () => {
  const root = checkout(valid);
  assert.throws(() => readTestEnvDescriptor(root), /cannot read .*test-env\.json\. Run `npm run test:e2e`/);
  const { sha256 } = readTestEnvInputs(root);
  writeFileSync(join(root, '.ai/qa/test-env.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:1', inputs: { sha256 } }));
  assert.equal(readTestEnvDescriptor(root).baseUrl, 'http://127.0.0.1:1');
  writeFileSync(join(root, TEST_ENV_INPUTS), JSON.stringify({ ...valid, browser: { agentBrowserVersion: '1.2.4' } }));
  assert.throws(() => readTestEnvDescriptor(root), /booted from other settings .* Run \.ai\/scripts\/test-env-up\.sh again/);
});

test('agent-browser --version output yields its release, or nothing', () => {
  assert.equal(agentBrowserVersion('agent-browser 0.39.4\n'), '0.39.4');
  assert.equal(agentBrowserVersion('v0.39.4'), '0.39.4');
  assert.equal(agentBrowserVersion('test-browser 1\n'), '');
  assert.equal(agentBrowserVersion(''), '');
});

test('the CLI describes the inputs for test-env-up.sh and refuses a malformed file', () => {
  const root = checkout({ ...valid, server: { env: ['CEZ_X=1'] } });
  const described = spawnSync(process.execPath, [module, 'describe', root], { encoding: 'utf8' });
  assert.equal(described.status, 0, described.stderr);
  assert.deepEqual(JSON.parse(described.stdout), { sha256: readTestEnvInputs(root).sha256, agentBrowserVersion: '1.2.3', serverEnv: ['CEZ_X=1'] });
  const version = spawnSync(process.execPath, [module, 'version-of'], { encoding: 'utf8', input: 'agent-browser 0.39.4\n' });
  assert.equal(version.stdout, '0.39.4');
  const bad = spawnSync(process.execPath, [module, 'describe', checkout('{')], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /test-env\.inputs\.json/);
  assert.equal(spawnSync(process.execPath, [module], { encoding: 'utf8' }).status, 2);
});

// Squeal's side of the split: the descriptor is a runtime file for browser specs, and the inputs
// are declared, so a restart re-keys nothing and an input change re-keys every browser spec.
test('squeal.config.json ignores the descriptor for browser specs and declares the inputs', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'squeal.config.json'), 'utf8'));
  assert.deepEqual(config.runtimeFiles, [{ project: 'e2e', tests: config.slow.include, paths: ['.ai/qa/test-env.json'] }]);
  const e2eInputs = config.inputs['packages/web/e2e/*.e2e.ts'] ?? [];
  for (const declared of [TEST_ENV_INPUTS, '.ai/scripts/test-env-inputs.mjs', '.ai/scripts/test-env-up.sh']) {
    assert.ok(e2eInputs.includes(declared), `${declared} must be a declared browser-spec input`);
  }
  // Squeal refuses a runtime file that is also a declared input.
  assert.ok(e2eInputs.every((glob) => !glob.startsWith('.ai/qa')), 'no declared input may cover .ai/qa');
});
