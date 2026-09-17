import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const manifest = (path: string) => JSON.parse(readFileSync(join(repo, path), 'utf8'));
const rootManifest = manifest('package.json');
const webManifest = manifest('packages/web/package.json');
const serverManifest = manifest('packages/cezar/package.json');
const commands = [
  ['run', 'typecheck:web'],
  ['run', 'typecheck', '-w', '@open-mercato/cezar-web'],
];

// Copy the actual command wiring into a tiny workspace. Compilation and package
// resolution stay real, without rebuilding the whole application in every case.
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'cezar-typecheck-'));
  const root = join(parent, '.ai/cezar/worktrees/task');
  function write(path: string, value: string | object) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  }
  write('package.json', { ...rootManifest, dependencies: {}, devDependencies: {} });
  const options = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [], strict: true };
  for (const [dir, name] of [['contract', '@open-mercato/cezar-contract'], ['api-client', '@open-mercato/cezar-api-client']]) {
    write(`packages/${dir}/package.json`, { name, scripts: { typecheck: 'tsc --noEmit' } });
    write(`packages/${dir}/tsconfig.json`, { compilerOptions: options, include: ['src.ts'] });
    write(`packages/${dir}/src.ts`, 'export {};');
  }
  write('packages/cezar/package.json', {
    name: serverManifest.name, version: serverManifest.version, type: 'module', exports: serverManifest.exports,
    scripts: { build: serverManifest.scripts.build, typecheck: 'tsc --noEmit', postbuild: 'node count-build.mjs' },
  });
  write('packages/cezar/count-build.mjs', "import { appendFileSync } from 'node:fs'; appendFileSync('builds.log', 'built\\n');");
  write('packages/cezar/tsconfig.json', {
    compilerOptions: { ...options, declaration: true, rootDir: 'src', outDir: 'dist' }, include: ['src/**/*.ts'],
  });
  write('packages/cezar/src/server/app-type.ts', "export type AppType = 'current';");
  write('packages/web/package.json', { name: webManifest.name, type: 'module', scripts: webManifest.scripts });
  write('packages/web/tsconfig.json', { compilerOptions: options, include: ['src.ts'] });
  write('packages/web/src.ts', "import type { AppType } from '@wjarka/cezarion/app-type'; const value: AppType = 'current';");
  const bin = join(root, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(repo, 'node_modules/typescript/bin/tsc'), join(bin, 'tsc'));
  for (const base of [parent, root]) {
    mkdirSync(join(base, 'node_modules/@wjarka'), { recursive: true });
    symlinkSync(join(base, 'packages/cezar'), join(base, 'node_modules/@wjarka/cezarion'), 'dir');
  }
  mkdirSync(join(parent, 'packages/cezar/dist/server'), { recursive: true });
  writeFileSync(join(parent, 'packages/cezar/package.json'), JSON.stringify({
    name: serverManifest.name, version: serverManifest.version, type: 'module', exports: serverManifest.exports,
  }));
  writeFileSync(join(parent, 'packages/cezar/dist/server/app-type.d.ts'), "export type AppType = 'parent-stale';");
  function run(args: string[]) {
    const result = spawnSync('npm', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  }
  return { root, write, run, clean: () => rmSync(parent, { recursive: true, force: true }) };
}

for (const command of commands) {
  for (const local of ['missing', 'stale']) {
    test(`${command.join(' ')} refreshes ${local} declarations in a nested worktree`, () => {
      const f = fixture();
      try {
        if (local === 'stale') f.write('packages/cezar/dist/server/app-type.d.ts', "export type AppType = 'local-stale';");
        // Prove the fixture exposes the original defect through real TS resolution.
        const before = spawnSync(join(repo, 'node_modules/.bin/tsc'), ['--noEmit'], {
          cwd: join(f.root, 'packages/web'), encoding: 'utf8',
        });
        assert.notEqual(before.status, 0);
        assert.match(before.stdout + before.stderr, new RegExp(local === 'missing' ? 'parent-stale' : 'local-stale'));
        const result = f.run(command);
        assert.equal(result.status, 0, result.output);
        assert.match(readFileSync(join(f.root, 'packages/cezar/dist/server/app-type.d.ts'), 'utf8'), /current/);
        // Existing output must be refreshed after a source contract changes, too.
        f.write('packages/cezar/src/server/app-type.ts', "export type AppType = 'updated';");
        f.write('packages/web/src.ts', "import type { AppType } from '@wjarka/cezarion/app-type'; const value: AppType = 'updated';");
        const updated = f.run(command);
        assert.equal(updated.status, 0, updated.output);
        assert.match(readFileSync(join(f.root, 'packages/cezar/dist/server/app-type.d.ts'), 'utf8'), /updated/);
        f.write('packages/web/src.ts', "const broken: number = 'not a number';");
        const broken = f.run(command);
        assert.notEqual(broken.status, 0, broken.output);
        assert.match(broken.output, /TS2322/);
      } finally { f.clean(); }
    });
  }
}

test('root typecheck prepares declarations once and checks every workspace', () => {
  const f = fixture();
  try {
    const result = f.run(['run', 'typecheck']);
    assert.equal(result.status, 0, result.output);
    assert.equal(readFileSync(join(f.root, 'packages/cezar/builds.log'), 'utf8'), 'built\n');
    for (const path of [
      'packages/web/src.ts', 'packages/contract/src.ts',
      'packages/api-client/src.ts', 'packages/cezar/src/server/app-type.ts',
    ]) {
      const source = readFileSync(join(f.root, path), 'utf8');
      f.write(path, source + "\nconst broken: number = 'not a number';");
      const broken = f.run(['run', 'typecheck']);
      assert.notEqual(broken.status, 0, `${path} must fail verification\n${broken.output}`);
      assert.match(broken.output, /TS2322/);
      f.write(path, source);
    }
  } finally { f.clean(); }
});
