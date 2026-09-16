'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isReleaseBumpFile,
  isManifestOnlyFiles,
  isBotReleaseBumpPr,
  onlyVersionValueChanges,
  classifyFromEnv,
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

test('onlyVersionValueChanges allows one old→new version pair and rejects structure/script changes', () => {
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
