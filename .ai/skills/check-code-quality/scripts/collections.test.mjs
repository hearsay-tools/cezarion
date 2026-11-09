import { nodeModulesWith } from './test-support.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCollections } from './collections.mjs';
import { runCheck } from './check.mjs';

function fixture(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'quality-collections-')));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  mkdirSync(join(cwd, 'nested'));
  writeFileSync(join(cwd, 'one.test.mjs'), '');
  writeFileSync(join(cwd, 'nested/two.test.ts'), '');
  writeFileSync(join(cwd, 'nested/setup.mjs'), '');
  return cwd;
}

test('collections normalize inline and manifest groups from their explicit working directories', t => {
  const cwd = fixture(t);
  mkdirSync(join(cwd, 'manifests'));
  writeFileSync(join(cwd, 'manifests/group.json'), JSON.stringify({ runner: 'node', cwd: 'nested',
    tests: ['two.test.ts'], imports: ['./setup.mjs'] }));
  const groups = parseCollections([
    JSON.stringify({ runner: 'vitest', tests: ['one.test.mjs'], projects: ['unit'] }),
    'manifests/group.json',
  ], cwd);
  assert.deepEqual(groups, [
    { runner: 'vitest', cwd, tests: [join(cwd, 'one.test.mjs')], imports: [], projects: ['unit'] },
    { runner: 'node', cwd: join(cwd, 'nested'), tests: [join(cwd, 'nested/two.test.ts')],
      imports: [join(cwd, 'nested/setup.mjs')], projects: [] },
  ]);
});

test('Node collection imports resolve installed loaders such as tsx from the group directory', t => {
  const cwd = fixture(t);
  symlinkSync(nodeModulesWith('tsx'), join(cwd, 'node_modules'), 'dir');
  const [group] = parseCollections([JSON.stringify({ runner: 'node', cwd: 'nested', tests: ['two.test.ts'], imports: ['tsx'] })], cwd);
  assert.match(group.imports[0], /tsx\/dist\/loader\.mjs$/);
});

test('duplicate test assignments reject repeated paths, groups and symlink aliases', t => {
  const cwd = fixture(t);
  symlinkSync(join(cwd, 'one.test.mjs'), join(cwd, 'alias.test.mjs'));
  const group = tests => JSON.stringify({ runner: 'node', tests });
  for (const groups of [
    [group(['one.test.mjs', 'one.test.mjs'])],
    [group(['one.test.mjs']), group(['./one.test.mjs'])],
    [group(['one.test.mjs']), JSON.stringify({ runner: 'vitest', tests: ['alias.test.mjs'] })],
  ]) assert.throws(() => parseCollections(groups, cwd), /Duplicate test assignment/);
});

test('invalid collection shapes fail before test execution', t => {
  const cwd = fixture(t);
  const valid = { runner: 'node', tests: ['one.test.mjs'] };
  const invalid = [
    null, [], {}, { ...valid, runner: 'other' }, { ...valid, extra: true },
    { ...valid, tests: [] }, { ...valid, tests: 'one.test.mjs' },
    { ...valid, tests: [''] }, { ...valid, tests: [2] },
    { ...valid, tests: ['nested/setup.mjs'] }, { ...valid, cwd: 2 }, { ...valid, cwd: '' },
    { ...valid, cwd: 'one.test.mjs' }, { ...valid, imports: 'tsx' },
    { ...valid, imports: [''] }, { ...valid, projects: ['unit'] },
    { ...valid, runner: 'vitest', imports: [] }, { ...valid, runner: 'vitest', projects: [false] },
  ];
  for (const value of invalid) {
    // A manifest can contain any JSON value; inline arguments deliberately require an object.
    writeFileSync(join(cwd, 'group.json'), JSON.stringify(value));
    assert.throws(() => parseCollections(['group.json'], cwd), undefined, JSON.stringify(value));
  }
  assert.throws(() => parseCollections(['{'], cwd), SyntaxError);
});

test('check CLI rejects mixing explicit collections with legacy runner flags or external coverage', async t => {
  const cwd = fixture(t);
  const collection = JSON.stringify({ runner: 'node', tests: ['one.test.mjs'] });
  for (const args of [
    ['--test', 'one.test.mjs'], ['--runner', 'node'], ['--project', 'unit'],
    ['--node-import', 'nested/setup.mjs'], ['--coverage', 'coverage.json'],
  ]) {
    let output = '';
    const result = await runCheck(['--base', 'main', '--json', '--collection', collection, ...args], {
      cwd, stdout: { write: text => { output += text; } },
      collect: () => assert.fail('must reject arguments before collection'),
    });
    assert.equal(result, 2);
    assert.match(JSON.parse(output).errors.join(' '), /Use --collection separately/);
  }
});
