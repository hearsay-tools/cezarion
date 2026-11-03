import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildInputs, main, needsBuild, selectTests } from './test-package.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'package-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, time = 1000) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
    utimesSync(file, time, time);
  };
  put('packages/cezar/test/e2e/a.test.ts');
  put('packages/cezar/test/e2e/b.test.ts');
  return { root, put };
}

test('maps repo-root selections and preserves the no-argument inventory', t => {
  const { root } = fixture(t);
  assert.deepEqual(selectTests(root, ['packages/cezar/test/e2e/b.test.ts']), ['test/e2e/b.test.ts']);
  assert.deepEqual(selectTests(root, []), ['test/e2e/a.test.ts', 'test/e2e/b.test.ts']);
  for (const path of ['package.json', '../outside.test.ts', 'packages/cezar/test/e2e/missing.test.ts']) {
    assert.throws(() => selectTests(root, [path]), /inside packages\/cezar\/test\/e2e/);
  }
  symlinkSync(join(root, 'packages/cezar/test/e2e/a.test.ts'), join(root, 'outside.test.ts'));
  assert.throws(() => selectTests(root, ['outside.test.ts']), /inside/);
});

test('builds missing outputs and skips a completed CI build', t => {
  const { root, put } = fixture(t);
  assert.equal(needsBuild(root), true);
  for (const file of ['dist/index.js', 'dist/contract/index.js', 'web/dist/index.html', 'README.md']) put(`packages/cezar/${file}`, 2000);
  put('packages/cezar/src/index.ts');
  put('packages/web/src/main.tsx');
  assert.equal(needsBuild(root), false);
  put('packages/cezar/web/dist/index.html', 500);
  assert.equal(needsBuild(root), true);
});

test('all build input families invalidate fresh output', t => {
  const { root, put } = fixture(t);
  for (const file of ['dist/index.js', 'dist/contract/index.js', 'web/dist/index.html', 'README.md']) put(`packages/cezar/${file}`, 2000);
  for (const input of [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md',
    ...['cezar', 'contract', 'api-client', 'web'].flatMap(name => [
      `packages/${name}/package.json`, `packages/${name}/tsconfig.json`,
      `packages/${name}/src/index.ts`, `packages/${name}/scripts/build.mjs`,
    ]),
    'packages/web/vite.config.ts', 'packages/web/index.html', 'packages/web/public/icon.svg',
  ]) {
    put(input, 3000);
    assert.ok(buildInputs(root).includes(join(root, input)), input);
    assert.equal(needsBuild(root), true, input);
    put(input, 1000);
    assert.equal(needsBuild(root), false, input);
  }
});


test('Windows builds through the command shell and runs Node without it', t => {
  const { root } = fixture(t);
  const calls = [];
  main(['packages/cezar/test/e2e/a.test.ts'], {
    repo: root, platform: 'win32', log() {},
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'npm.cmd');
  assert.deepEqual(calls[0].args, ['run', 'build']);
  assert.equal(calls[0].options.shell, true);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[1].command, process.execPath);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].args.at(-1), 'test/e2e/a.test.ts');
  assert.equal(calls[1].options.cwd, join(root, 'packages/cezar'));
});
