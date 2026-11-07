import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'product-release-'));
  for (const [folder, name, extra] of [
    ['.', 'workspace', {private: true}], ['packages/contract', '@scope/contract', {private: true}],
    ['packages/api-client', '@scope/client', {}], ['packages/cezar', '@scope/server', {}],
    ['packages/web', '@scope/web', {private: true}], ['alias-cezarion', 'fake-alias', {dependencies: {'@scope/server': '^0.9.9'}}],
  ]) {
    mkdirSync(join(root, folder), {recursive: true});
    writeFileSync(join(root, folder, 'package.json'), JSON.stringify({name, version: '0.9.9', ...extra}));
  }
  // Prevent npm or network calls; these cases check selection and manifest stamping.
  writeFileSync(join(root, 'npm-cli.js'), 'process.exit(0);\n');
  return root;
}

function run(root, script, args, settings) {
  execFileSync(process.execPath, [new URL(`./${script}`, import.meta.url).pathname, ...args, '--dry-run'], {
    env: {...process.env, NODE_AUTH_TOKEN: '', GITHUB_ACTIONS: '', ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
      GITHUB_OUTPUT: join(root, 'output'), npm_execpath: join(root, 'npm-cli.js'), ...settings}, stdio: 'pipe',
  });
  return JSON.parse(readFileSync(join(root, 'packages/cezar/package.json'), 'utf8')).version;
}

test('preferred release root overrides the legacy root', () => {
  const root = fixture();
  try { assert.equal(run(root, 'release.mjs', ['patch'], {HSQ_RELEASE_ROOT: root, CEZ_RELEASE_ROOT: '/missing-legacy'}), '0.9.10'); }
  finally { rmSync(root, {recursive: true, force: true}); }
});

test('preferred snapshot root and channel override legacy settings', () => {
  const root = fixture();
  try {
    assert.equal(run(root, 'release-snapshot.mjs', [], {HSQ_SNAPSHOT_ROOT: root, CEZ_SNAPSHOT_ROOT: '/missing-legacy',
      HSQ_RELEASE_CHANNEL: 'nightly', CEZ_RELEASE_CHANNEL: 'unused', GITHUB_EVENT_NAME: 'schedule', GITHUB_REF_NAME: 'main',
      GITHUB_REPOSITORY: 'open-mercato/cezar', GITHUB_RUN_NUMBER: '12', GITHUB_RUN_ATTEMPT: '1', NIGHTLY_DATE: '20260813'}), '0.9.9-nightly.20260813.12');
  } finally { rmSync(root, {recursive: true, force: true}); }
});
