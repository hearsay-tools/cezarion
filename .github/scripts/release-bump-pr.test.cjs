'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isReleaseBumpFile,
  isManifestOnlyFiles,
  isBotReleaseBumpPr,
} = require('./release-bump-pr.cjs');

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
