'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isReleaseBumpFile,
  isManifestOnlyFiles,
  isBotReleaseBumpPr,
  onlyVersionValueChanges,
  classifyFromEnv,
  isAppUpstreamScanPr,
  classifyUpstreamScanFromEnv,
} = require('./release-bump-pr.cjs');

const HEAD = 'a'.repeat(40);

const MANIFEST = [
  'packages/cezar/package.json',
  'packages/contract/package.json',
  'packages/api-client/package.json',
  'packages/web/package.json',
  'alias-cezarion/package.json',
  'package-lock.json',
];

test('allowlist matches release-finalization staged paths only', () => {
  for (const file of MANIFEST) assert.equal(isReleaseBumpFile(file), true, file);
  assert.equal(isReleaseBumpFile('package.json'), false);
  assert.equal(isReleaseBumpFile('packages/cezar/src/index.ts'), false);
  assert.equal(isReleaseBumpFile('.github/workflows/ci.yml'), false);
  assert.equal(isReleaseBumpFile('packages/cezar/package.json.bak'), false);
  assert.equal(isReleaseBumpFile('packages/nested/extra/package.json'), false);
});

test('manifest-only requires a non-empty allowlisted file set', () => {
  assert.equal(isManifestOnlyFiles(MANIFEST), true);
  assert.equal(isManifestOnlyFiles(['package-lock.json']), true);
  assert.equal(isManifestOnlyFiles([]), false);
  assert.equal(isManifestOnlyFiles(undefined), false);
  assert.equal(isManifestOnlyFiles([...MANIFEST, 'README.md']), false);
});

test('bot release bump needs release/v* head, bot author, and manifest-only files', () => {
  assert.equal(
    isBotReleaseBumpPr({
      headRef: 'release/v0.13.5',
      prAuthor: 'github-actions[bot]',
      files: MANIFEST,
    }),
    true,
  );
  assert.equal(
    isBotReleaseBumpPr({
      headRef: 'release/v0.13.5',
      prAuthor: 'github-actions[bot]',
      files: [...MANIFEST, 'src/hack.ts'],
    }),
    false,
  );
  assert.equal(
    isBotReleaseBumpPr({
      headRef: 'release/v0.13.5',
      prAuthor: 'human',
      files: MANIFEST,
    }),
    false,
  );
  assert.equal(
    isBotReleaseBumpPr({
      headRef: 'fix/task',
      prAuthor: 'github-actions[bot]',
      files: MANIFEST,
    }),
    false,
  );
  assert.equal(
    isBotReleaseBumpPr({
      headRef: 'release/v0.13.5',
      prAuthor: 'github-actions[bot]',
      files: [],
    }),
    false,
  );
});

test('onlyVersionValueChanges allows release fields only and one shared old→new pair', () => {
  assert.equal(
    onlyVersionValueChanges(
      { name: 'x', version: '1.0.0', dependencies: { y: '^1.0.0' } },
      { name: 'x', version: '1.0.1', dependencies: { y: '^1.0.1' } },
    ),
    true,
  );
  assert.equal(
    onlyVersionValueChanges(
      { name: 'x', version: '1.0.0', dependencies: { y: '^1.0.0' } },
      { name: 'x', version: '1.0.1', dependencies: { y: '^9.9.9' } },
    ),
    false,
  );
  // engines is not a release-stamp field
  assert.equal(
    onlyVersionValueChanges(
      { name: 'x', version: '1.0.0', engines: { node: '20.0.0' } },
      { name: 'x', version: '1.0.1', engines: { node: '20.0.1' } },
    ),
    false,
  );
  assert.equal(
    onlyVersionValueChanges(
      { name: 'x', version: '1.0.0', scripts: { test: 'vitest' } },
      { name: 'x', version: '1.0.0', scripts: { test: 'vitest', postinstall: 'curl evil' } },
    ),
    false,
  );
  assert.equal(
    onlyVersionValueChanges(
      { name: 'x', version: '1.0.0' },
      { name: 'x', version: '1.0.0', dependencies: { evil: '1.0.0' } },
    ),
    false,
  );
  assert.equal(onlyVersionValueChanges({ version: '1.0.0' }, { version: 'not-a-version' }), false);
  // Shared pair across multiple roots
  assert.equal(
    onlyVersionValueChanges(
      [{ version: '1.0.0' }, { version: '1.0.0' }],
      [{ version: '1.0.1' }, { version: '1.0.1' }],
    ),
    true,
  );
  assert.equal(
    onlyVersionValueChanges(
      [{ version: '1.0.0' }, { version: '2.0.0' }],
      [{ version: '1.0.1' }, { version: '2.0.1' }],
    ),
    false,
  );
});

test('classifyFromEnv requires matching event/live head SHAs, file list, and version stamps', () => {
  const base = {
    EVENT_NAME: 'pull_request',
    HEAD_REF: 'release/v0.13.5',
    PR_AUTHOR: 'github-actions[bot]',
    EXPECTED_HEAD_SHA: HEAD,
    LIVE_HEAD_SHA: HEAD,
    BASE_SHA: 'c'.repeat(40),
    GITHUB_REPOSITORY: 'owner/repo',
    PR_FILES_OK: '1',
    PR_FILES: MANIFEST.join('\n'),
  };
  const stampsOk = { filesAreVersionStampsOnly: () => true };
  const stampsBad = { filesAreVersionStampsOnly: () => false };
  assert.equal(classifyFromEnv(base, stampsOk), true);
  assert.equal(classifyFromEnv(base, stampsBad), false);
  assert.equal(classifyFromEnv({ ...base, LIVE_HEAD_SHA: 'b'.repeat(40) }, stampsOk), false);
  assert.equal(classifyFromEnv({ ...base, EXPECTED_HEAD_SHA: 'notasha' }, stampsOk), false);
  assert.equal(classifyFromEnv({ ...base, PR_FILES_OK: '0' }, stampsOk), false);
  assert.equal(classifyFromEnv({ ...base, PR_FILES_OK: undefined }, stampsOk), false);
  assert.equal(classifyFromEnv({ ...base, PR_FILES: '' }, stampsOk), false);
  assert.equal(classifyFromEnv({ ...base, BASE_SHA: 'short' }, stampsOk), false);
});


test('configured release App author is exact and keeps every version-stamp guard', () => {
  const env = { EVENT_NAME: 'pull_request_target', HEAD_REF: 'release/v1.2.3',
    PR_AUTHOR: 'cezar-release[bot]', RELEASE_APP_BOT_LOGIN: 'cezar-release[bot]',
    EXPECTED_HEAD_SHA: 'a'.repeat(40), LIVE_HEAD_SHA: 'a'.repeat(40), BASE_SHA: 'b'.repeat(40),
    GITHUB_REPOSITORY: 'example/project', PR_FILES_OK: '1', PR_FILES: 'packages/cezar/package.json' };
  const ok = { filesAreVersionStampsOnly: () => true };
  assert.equal(classifyFromEnv(env, ok), true);
  for (const change of [
    { RELEASE_APP_BOT_LOGIN: '' }, { RELEASE_APP_BOT_LOGIN: 'other[bot]' },
    { PR_AUTHOR: 'human', RELEASE_APP_BOT_LOGIN: 'human' },
    { PR_FILES: 'src/code.ts' }, { LIVE_HEAD_SHA: 'c'.repeat(40) }, { PR_FILES_OK: '0' },
  ]) assert.equal(classifyFromEnv({ ...env, ...change }, ok), false);
  assert.equal(classifyFromEnv(env, { filesAreVersionStampsOnly: () => false }), false);
});

test('only a ledger-only upstream-scan PR authored by the configured release App skips review', () => {
  const env = { EVENT_NAME: 'pull_request_target', HEAD_REF: 'upstream-scan/2026-09-21',
    PR_AUTHOR: 'cezarion-release[bot]', RELEASE_APP_BOT_LOGIN: 'cezarion-release[bot]',
    EXPECTED_HEAD_SHA: 'a'.repeat(40), LIVE_HEAD_SHA: 'A'.repeat(40),
    PR_FILES_OK: '1', PR_FILES: '.ai/upstream/ledger.yaml\n.ai/upstream/LEDGER.md\n' };
  assert.equal(classifyUpstreamScanFromEnv(env), true);
  for (const change of [
    { EVENT_NAME: 'workflow_dispatch' },
    { HEAD_REF: 'feature/upstream-scan' },
    { PR_AUTHOR: 'github-actions[bot]' },
    { PR_AUTHOR: 'octocat', RELEASE_APP_BOT_LOGIN: 'octocat' },
    { RELEASE_APP_BOT_LOGIN: '' },
    { RELEASE_APP_BOT_LOGIN: undefined },
    { PR_FILES: '.ai/upstream/ledger.yaml\npackages/cezar/src/index.ts' },
    { PR_FILES: '.ai/upstream/../../src/index.ts' },
    { PR_FILES: '.ai/upstreamish/ledger.yaml' },
    { PR_FILES: '' },
    { PR_FILES_OK: '0' },
    { PR_FILES_OK: undefined },
    { LIVE_HEAD_SHA: 'b'.repeat(40) },
    { EXPECTED_HEAD_SHA: '' },
  ]) assert.equal(classifyUpstreamScanFromEnv({ ...env, ...change }), false, JSON.stringify(change));
  assert.equal(isAppUpstreamScanPr({ headRef: 'upstream-scan/x', prAuthor: 'cezarion-release[bot]',
    files: [], releaseAppBotLogin: 'cezarion-release[bot]' }), false, 'an empty file list is not ledger-only');
  assert.equal(isAppUpstreamScanPr(), false);
});

test('an upstream-scan PR never passes as a release bump, nor a release bump as a scan', () => {
  const scan = { EVENT_NAME: 'pull_request_target', HEAD_REF: 'upstream-scan/2026-09-21',
    PR_AUTHOR: 'cezarion-release[bot]', RELEASE_APP_BOT_LOGIN: 'cezarion-release[bot]',
    EXPECTED_HEAD_SHA: 'a'.repeat(40), LIVE_HEAD_SHA: 'a'.repeat(40), BASE_SHA: 'b'.repeat(40),
    GITHUB_REPOSITORY: 'example/project', PR_FILES_OK: '1', PR_FILES: '.ai/upstream/ledger.yaml' };
  assert.equal(classifyFromEnv(scan, { filesAreVersionStampsOnly: () => true }), false);
  assert.equal(classifyUpstreamScanFromEnv({ ...scan, HEAD_REF: 'release/v1.2.3', PR_FILES: 'package-lock.json' }), false);
});
