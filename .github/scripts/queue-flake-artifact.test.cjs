'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { readList, parseNames, isTestPath, MAX_LIST_BYTES } = require('./queue-flake-artifact.cjs');
const { zip } = require('./fixtures/queue-flake-zip.cjs');

const malformed = (fn) => assert.throws(fn, (error) => error.code === 'malformed');

test('reads the one list file of an upload-artifact archive, stored or deflated', () => {
  const text = 'packages/web/src/a.test.ts\npackages/cezar/src/b.test.ts\n';
  assert.equal(readList(zip([{ name: 'failed-test-files.txt', data: text }])), text);
  assert.equal(readList(zip([{ name: 'failed-test-files.txt', data: text, method: 0 }])), text);
  assert.equal(readList(zip([{ name: 'failed-test-files.txt', data: '' }])), '');
});

test('refuses an archive that is not exactly the one list file', () => {
  malformed(() => readList(Buffer.from('not a zip')));
  malformed(() => readList(Buffer.alloc(0)));
  malformed(() => readList(zip([])));
  malformed(() => readList(zip([{ name: 'other.txt', data: 'a.test.ts\n' }])));
  malformed(() => readList(zip([{ name: 'dir/failed-test-files.txt', data: 'a.test.ts\n' }])));
  malformed(() => readList(zip([{ name: 'failed-test-files.txt', data: 'a\n' }, { name: 'failed-test-files.txt', data: 'b\n' }])));
  malformed(() => readList(zip([{ name: 'failed-test-files.txt', data: 'a\n', flags: 1 }])), 'encrypted');
  malformed(() => readList(zip([{ name: 'failed-test-files.txt', data: 'a\n', method: 12 }])), 'bzip2');
  malformed(() => readList(zip([{ name: 'failed-test-files.txt', data: 'a\n', size: 99 }])), 'declared size differs');
  malformed(() => readList(zip([{ name: 'failed-test-files.txt', data: 'a\n', crc: 1 }])), 'CRC differs');
  malformed(() => readList(zip([{ name: 'failed-test-files.txt', data: Buffer.from([0xff, 0xfe, 0x0a]) }])), 'not UTF-8');
  const archive = zip([{ name: 'failed-test-files.txt', data: 'a\n' }]);
  malformed(() => readList(archive.subarray(0, archive.length - 30)), 'truncated');
});

test('refuses a list that inflates past its limit before it holds the whole output', () => {
  const big = 'x'.repeat(MAX_LIST_BYTES + 1);
  const archive = zip([{ name: 'failed-test-files.txt', data: big }]);
  assert.ok(archive.length < 2048, 'a small archive that inflates large');
  malformed(() => readList(archive));
  malformed(() => readList(zip([{ name: 'failed-test-files.txt', data: big, size: 10 }])), 'a small declared size');
  assert.ok(zlib.deflateRawSync(big).length < MAX_LIST_BYTES);
});

test('keeps only repository-relative test file paths, sorted and once', () => {
  const text = [
    'packages/web/src/b.test.tsx', 'packages/cezar/src/a.test.ts', 'packages/cezar/src/a.test.ts', '',
    'packages/web/e2e/activity.e2e.ts\r', '../etc/passwd.test.ts', '/abs/x.test.ts', 'a/./b.test.ts',
    'src/not-a-test.ts', 'src/`tick`.test.ts', 'src/<b>.test.ts', 'src/@owner.test.ts', 'src/x.test.ts -->',
    `src/${'a'.repeat(400)}.test.ts`, 'scripts/tool.test.mjs', '.github/scripts/x.test.cjs',
  ].join('\n');
  assert.deepEqual(parseNames(text), {
    names: ['.github/scripts/x.test.cjs', 'packages/cezar/src/a.test.ts', 'packages/web/e2e/activity.e2e.ts', 'packages/web/src/b.test.tsx', 'scripts/tool.test.mjs'],
    dropped: 9,
  });
  assert.deepEqual(parseNames(''), { names: [], dropped: 0 });
});

test('a test path has safe characters, no dot segment and a test suffix', () => {
  for (const name of ['a.test.ts', 'packages/web/e2e/activity.e2e.ts', 'x/y-z_1.spec.tsx', 'p/q.test.cjs', 'p/q.test.mts', 'p/.hidden/q.test.js']) assert.ok(isTestPath(name), name);
  for (const name of ['a.ts', 'a.test.ts/b', '..', 'a/../b.test.ts', './a.test.ts', 'a//b.test.ts', 'a b.test.ts', 'a.test.ts\n', '-a.test.ts', 'a@b.test.ts']) assert.ok(!isTestPath(name), name);
});
