import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkCoverage, typecheckProjects } from './check-typecheck-coverage.mjs';

const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cez-typecheck-coverage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  execFileSync('git', ['init', '-q', root]);
  put('package.json', { type: 'module', workspaces: ['packages/app'], scripts: {
    typecheck: 'npm run typecheck:app && node scripts/check-typecheck-coverage.mjs',
    'typecheck:app': 'npm run typecheck -w app',
    'typecheck:package': 'npm run typecheck:package -w app',
  } });
  put('packages/app/package.json', { name: 'app', type: 'module', scripts: {
    typecheck: 'tsc --noEmit -p tsconfig.json',
    'typecheck:package': 'tsc --noEmit -p tsconfig.package.json',
  } });
  const options = { noEmit: true, target: 'ES2022', types: [], strict: true };
  put('packages/app/tsconfig.json', { compilerOptions: options, files: ['src.ts'] });
  put('packages/app/tsconfig.package.json', { compilerOptions: options, files: ['package.test.ts'] });
  put('packages/app/src.ts', "import './helper.ts';\nexport const x = 1;\n");
  put('packages/app/helper.ts', 'export {};');
  put('packages/app/package.test.ts', 'export {};');
  return { root, put };
}

test('uses invoked configs and transitive imports, including the post-build package phase', t => {
  const { root } = fixture(t);
  assert.deepEqual(typecheckProjects(root).map(entry => entry.config), [
    'packages/app/tsconfig.json', 'packages/app/tsconfig.package.json',
  ]);
  assert.deepEqual(checkCoverage(root, compiler), []);
});

test('rejects new untracked TypeScript outside all invoked checks', t => {
  const { root, put } = fixture(t);
  put('packages/app/scripts/new-probe.ts', "const value: number = 'broken';");
  // Merely creating an unused tsconfig must not make a file count as checked.
  put('packages/app/tsconfig.unused.json', { files: ['scripts/new-probe.ts'] });
  assert.deepEqual(checkCoverage(root, compiler), ['packages/app/scripts/new-probe.ts']);
});

test('sees a tracked file removed from the invoked config', t => {
  const { root, put } = fixture(t);
  execFileSync('git', ['add', '.'], { cwd: root });
  put('packages/app/src.ts', 'export {};');
  assert.deepEqual(checkCoverage(root, compiler), ['packages/app/helper.ts']);
});

test('does not treat ignored build output or declaration files as executable inputs', t => {
  const { root, put } = fixture(t);
  put('.gitignore', 'dist/\n');
  put('dist/generated.ts', 'invalid code');
  put('shim.d.mts', 'export declare const value: string;');
  assert.deepEqual(checkCoverage(root, compiler), []);
});

test('fails closed when command wiring can no longer be understood', t => {
  const { root, put } = fixture(t);
  put('package.json', { scripts: { typecheck: 'node custom-compiler.mjs' } });
  assert.throws(() => typecheckProjects(root), /Unsupported typecheck command/);
});
