import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalTestHomeProblems } from './test-home-repository.ts';
import { testHomeWrite, unsafeHomeWrites } from './test-home-write.ts';

describe('test writes use explicit sandbox paths', () => {
  it.each([
    "writeFileSync(join(squawkHomeDir(), 'config.json'), '{}')",
    "const root = homedir(); const file = join(root, 'config.json'); writeFileSync(file, '{}')",
    "const file = join(home(), 'x'); import { homedir as home } from 'node:os'; fs.promises.writeFile(file, '{}')",
    "import { rename as move } from 'node:fs/promises'; move('/tmp/a', join(os.homedir(), 'b'))",
    "const { rmSync: remove } = fs; remove(join(os['homedir'](), 'x'))",
    "let root; root = squawkHomeDir(); mkdirSync(root)",
    "const root = homedir(); fs.renameSync(root, '/tmp/x')",
    "fs.promises.rename('/tmp/x', join(homedir(), 'x'))",
    "fs.rmdirSync(join(homedir(), 'x'))",
    "fs.unlink(join(homedir(), 'x'), callback)",
    "import { writeFileSync as write } from 'node:fs'; const save = write; save(homedir(), 'x')",
    "writeFileSync(join((0, os.homedir)(), 'x'), 'x')",
    "fs.rmSync(paths['squawkHomeDir']())",
  ])('rejects an ambient home reaching a write: %s', source => {
    expect(unsafeHomeWrites(source).length).toBeGreaterThan(0);
  });

  it.each([
    "writeFileSync(join(Home.sandbox(dir).root, 'config.json'), '{}')",
    "readFileSync(join(homedir(), 'config.json')); // test-home-read: inspect the selected home",
    "const home = resolveHome({purpose: 'cli'}); // test-home-read: pure resolution, result not written",
    "const file = join(tmp, 'x'); writeFileSync(file, 'homedir()')",
    "// writeFileSync(homedir(), 'x')\nconst sample = `mkdirSync(squawkHomeDir())`",
  ])('allows explicit sandbox writes and annotated reads: %s', source => {
    expect(unsafeHomeWrites(source)).toEqual([]);
  });

  it.each(['test', 'testkit'].flatMap(kind => ['js', 'jsx', 'ts', 'tsx', 'mjs', 'mjsx', 'mts', 'mtsx', 'cjs', 'cjsx', 'cts', 'ctsx']
    .map(extension => `a.${kind}.${extension}`)))('covers %s repository-wide', file => {
    expect(testHomeWrite.applies(`scripts/${file}`)).toBe(true);
    expect(testHomeWrite.check(`scripts/${file}`, "writeFileSync(join(squawkHomeDir(), 'config.json'), '{}')")).toHaveLength(1);
  });

  it('keeps operational tools outside test-source enforcement', () => {
    const source = 'mkdirSync(join(homedir(), ".cache/cez/mutants"))';
    expect(testHomeWrite.applies('.github/scripts/mutants-file.cjs')).toBe(false);
    expect(testHomeWrite.check('.github/scripts/mutants-file.test.cjs', source)).toHaveLength(1);
  });

  it('runs both rules on tests outside packages through the repository gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-external-home-rule-'));
    try {
      mkdirSync(join(root, '.github/scripts'), { recursive: true });
      writeFileSync(join(root, '.github/scripts/unsafe.test.cjs'), "writeFileSync(join(squawkHomeDir(), 'config.json'), '{}'); process.env.CEZ_HOME = '/host';");
      writeFileSync(join(root, '.github/scripts/mutants-file.cjs'), 'mkdirSync(homedir())');
      const problems = externalTestHomeProblems(root, ['.github/scripts/unsafe.test.cjs', '.github/scripts/mutants-file.cjs', 'deleted.test.mjs']);
      expect(problems).toEqual([expect.stringContaining('cez/home-boundary'), expect.stringContaining('cez/test-home-write')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['jsx', 'tsx', 'mjsx', 'mtsx', 'cjsx', 'ctsx'])('runs both repository rules on JSX in .testkit.%s', extension => {
    const root = mkdtempSync(join(tmpdir(), 'cez-jsx-home-rule-'));
    const file = `unsafe.testkit.${extension}`;
    try {
      writeFileSync(join(root, file), "const view = <div>{homedir()}</div>; process.env.CEZ_HOME = '/host';");
      expect(externalTestHomeProblems(root, [file])).toEqual([
        expect.stringContaining('cez/home-boundary'), expect.stringContaining('cez/test-home-write'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed source', () => {
    expect(() => unsafeHomeWrites('const x = ;')).toThrow();
  });

  it.each([
    ['object', "const {root} = {root: homedir()}; writeFileSync(root + '/config.json', '{}')"],
    ['nested object', "const {cfg: {root: dir}} = {cfg: {root: homedir()}}; fs.rmSync(dir)"],
    ['array', "const [root] = [homedir()]; fs.rmSync(root)"],
    ['nested array', "const [[root]] = [[homedir()]]; fs.rmSync(root)"],
    ['object default', "const {root = homedir()} = {}; fs.rmSync(root)"],
    ['array default', "const [root = homedir()] = []; fs.rmSync(root)"],
    ['parameter default', "function remove(root = homedir()) { fs.rmSync(root) }"],
    ['nested default', "const {cfg: {root} = {root: homedir()}} = {}; fs.rmSync(root)"],
    ['conditional default', "const {root = homedir()} = flag ? {root: '/tmp'} : {}; fs.rmSync(root)"],
    ['unknown default', "const {root = homedir()} = {root: flag ? '/tmp' : other()}; fs.rmSync(root)"],
    ['object rest', "const {safe, ...dirs} = {safe: '/tmp', root: homedir()}; fs.rmSync(dirs.root)"],
    ['array rest', "const [safe, ...dirs] = ['/tmp', homedir()]; fs.rmSync(dirs[0])"],
    ['object assignment', "let root; ({root} = {root: homedir()}); fs.rmSync(root)"],
    ['renamed object assignment', "let root; ({dir: root} = {dir: homedir()}); fs.rmSync(root)"],
    ['array assignment', "let root; [root] = [homedir()]; fs.rmSync(root)"],
    ['reassignment', "let root = '/tmp'; root = homedir(); fs.rmSync(root)"],
    ['asserted assignment', "let root: string; (root as string) = homedir(); fs.rmSync(root)"],
    ['bound object', "const dirs = {root: homedir()}; const alias = dirs; fs.rmSync(alias.root)"],
    ['object spread', "const dirs = {root: homedir()}; const copy = {...dirs}; fs.rmSync(copy.root)"],
    ['array spread', "const dirs = [homedir()]; const copy = [...dirs]; fs.rmSync(copy[0])"],
    ['path spread', "const dirs = [homedir(), 'config.json']; fs.rmSync(path.join(...dirs))"],
    ['template', "const dir = homedir(); fs.rmSync(`${dir}/config.json`)"],
    ['path alias', "import {resolve as pathFor} from 'node:path'; fs.rmSync(pathFor(homedir(), 'x'))"],
    ['promise destructuring', "const {promises: {writeFile: save}} = fs; save(homedir() + '/config.json', '{}')"],
    ['require', "const fs = require('node:fs'); const {mkdirSync: make} = fs; make(homedir())"],
    ['require promises', "const {writeFile: save} = require('fs/promises'); save(homedir(), '{}')"],
    ['namespace', "import * as files from 'node:fs'; files.rmSync(homedir())"],
    ['default', "import files from 'node:fs'; files.rmSync(homedir())"],
    ['promise import', "import {promises as files} from 'node:fs'; files.rm(homedir())"],
    ['namespace promises', "import * as files from 'node:fs/promises'; files.rm(homedir())"],
    ['dynamic import literal', "const {rm: remove} = await import('node:fs/promises'); remove(homedir())"],
    ['nested writer object', "const box = {writes: {save: fs.writeFileSync}}; const {writes: {save}} = box; save(homedir(), '{}')"],
    ['writer array', "const [save] = [fs.writeFileSync]; save(homedir(), '{}')"],
    ['writer default', "const {save = fs.writeFileSync} = {}; save(homedir(), '{}')"],
    ['writer parameter default', "function example(save = fs.writeFileSync) { save(homedir(), '{}') }"],
    ['writer object rest', "const {readFile, ...writes} = fs.promises; writes.rm(homedir())"],
    ['writer array rest', "const [safe, ...writes] = [readFileSync, fs.writeFileSync]; writes[0](homedir(), '{}')"],
    ['writer reassignment', "let save = other; save = fs.writeFileSync; save(homedir(), '{}')"],
    ['writer object assignment', "let save; ({writeFileSync: save} = fs); save(homedir(), '{}')"],
    ['writer array assignment', "let save; [save] = [fs.writeFileSync]; save(homedir(), '{}')"],
    ['cyclic binding', "let root = alias; let alias = root; root = homedir(); fs.rmSync(alias)"],
  ])('finds source syntax regardless of binding form: %s', (_form, source) => {
    expect(unsafeHomeWrites(source).length).toBeGreaterThan(0);
  });

  it.each([
    "const box = {}; box.root = homedir(); rmSync(box.root)",
    "for (const root of [homedir()]) rmSync(root)",
    "for (const {root} of [{root: homedir()}]) rmSync(root)",
    "openSync(join(homedir(), 'config.json'), 'w')",
    "mkdtempSync(join(homedir(), 'tmp-'))",
    "it('reads', () => { const root = homedir() }); it('writes', () => { const root = Home.sandbox(dir).root; writeFileSync(root, '{}') })",
    "const home = () => homedir(); rmSync(home())",
  ])('refuses ambient sources regardless of subsequent value flow: %s', source => {
    expect(unsafeHomeWrites(source).length).toBeGreaterThan(0);
  });

  it.each([
    "const {homedir: root = fallback} = require('node:os'); writeFileSync(root(), '{}')",
    "const {homedir = fallback} = require('node:os'); homedir()",
    "const {default: {homedir: read}} = await import('node:os'); read()",
    "const {default: {homedir: read = fallback} = fallback} = await import('node:os'); read()",
    "const {tmpdir, ...rest} = require('node:os'); rest.homedir()",
    "const {tmpdir, ...rest} = require('node:os'); const {homedir: read = fallback} = rest; read()",
    "let read; ({homedir: read = fallback} = require('node:os')); read()",
    "const {homedir: {call: read}} = require('node:os'); read(null)",
    "const {homedir: [read = fallback]} = source; read()",
    "const {default: {homedir: read}, ...rest} = source; read()",
    "writeFileSync(resolveHome({purpose: 'cli', env: {CEZ_HOME: '/host/live'}}).workspaceConfig, '{}')",
    "import {resolveHome as select} from '../home/resolve.ts'; select({purpose: 'cli'})",
    "const {resolveHome: select = fallback} = require('../home/resolve.cjs'); select({purpose: 'cli'})",
    "import {homedir} from 'node:os'; homedir()",
    "import {homedir as read} from 'os'; read()",
    "import os from 'node:os'; os.homedir()",
    "import * as os from 'os'; os.homedir()",
    "const os = require('node:os'); os.homedir()",
    "require('os').homedir()",
    "const {homedir: read} = require('node:os'); read()",
    "import {squawkHomeDir as read} from '../paths.ts'; read()",
    "import * as paths from '../paths.ts'; paths.squawkHomeDir()",
    "const {squawkHomeDir: read} = require('../paths.cjs'); read()",
    "os['homedir']()",
    "os.homedir?.()",
    "os.homedir.call(null)",
    "Reflect.apply(os.homedir, null, [])",
    "os.homedir.bind(null)()",
  ])('refuses direct and imported source aliases: %s', source => {
    expect(unsafeHomeWrites(source).length).toBeGreaterThan(0);
  });

  it.each([
    'homedir(); // test-home-read:',
    'homedir(); // test-home-read:   ',
    '// test-home-read: reason on the wrong line\nhomedir()',
    'homedir(); /* test-home-read: block comments cannot grant a line exception */',
    'homedir(); const fake = "// test-home-read: text is not a comment"',
  ])('requires a real line comment with a nonempty reason: %s', source => {
    expect(unsafeHomeWrites(source).length).toBeGreaterThan(0);
  });

  it.each([
    "function go({homedir: read = fallback} = require('node:os')) { read() }",
    "function go({default: {resolveHome: read} = fallback} = source) { read() }",
    "let read; ({homedir: (read as any)} = require('node:os'))",
    "let read; ({resolveHome: read} as any) = source",
    "let read; for ({resolveHome: read} of [await import('./resolve.ts')]) read()",
    "for (const {squawkHomeDir: read = fallback} of sources) read()",
    "let read; for ({homedir: read} in sources) read()",
    "try {} catch ({homedir: read = fallback}) { read() }",
    "const {outer: [{resolveHome: read}]} = source",
    "const {homedir: read, ...rest} = source",
    "const {homedir: read} = source satisfies unknown",
    "import {homedir as read} from 'node:os'",
    "export {homedir as read} from 'node:os'",
    "export {read as resolveHome} from './resolve.ts'",
    "export * as resolveHome from './resolve.ts'",
    "const read = os.homedir",
    "accept(module.resolveHome)",
    "const read = os?.homedir",
    "const read = os['homedir']",
    "(homedir satisfies any)()",
    "(resolveHome as any)()",
    "squawkHomeDir!()",
  ])('refuses guarded keys, specifiers and member values: %s', source => {
    expect(unsafeHomeWrites(source).length).toBeGreaterThan(0);
  });

  it.each([
    "function first() { const {homedir: read = fallback} = require('node:os') } // test-home-read: inspect sandbox path\nfunction second() { const read = () => Home.sandbox(dir).root; writeFileSync(read(), '{}') }",
    "const data = {homedir: '/tmp', resolveHome() { return '/tmp' }, squawkHomeDir: value}",
    "interface Data { homedir(): string; resolveHome: string }; type X = typeof os.homedir",
    "import type {homedir} from 'node:os'; export type {homedir}",
    "import {type homedir as read} from 'node:os'",
    "export {type resolveHome} from './resolve.ts'",
    "type T = {homedir: string}; const value: typeof os.homedir = safe",
    "os['home' + 'dir']()",
    "import {homedir as read} from 'node:os'; // test-home-read: compare the sandbox path\nread()",
  ])('ignores binding identity, data properties and type-only syntax: %s', source => {
    expect(unsafeHomeWrites(source)).toEqual([]);
  });

  it('reports the source syntax without flagging an unrelated function name', () => {
    const source = "function first() { const {homedir: read = fallback} = source }\nfunction second() { const read = () => dir; rmSync(read()) }";
    expect(testHomeWrite.check('sample.test.ts', source).map(site => site.line)).toEqual([1]);
  });

  it.each([
    "namespace Fixtures { const dir = homedir(); writeFileSync(dir, '{}') }",
    "enum Fixture { Path = homedir().length }",
    "export = resolveHome({purpose: 'cli'})",
    "namespace Outer.Inner { const home = resolveHome({purpose: 'cli'}) }",
    "class Fixture { constructor(public home = homedir()) {} }",
    "@decorate(os.homedir) class Fixture {}",
  ])('scans runtime TypeScript containers: %s', source => {
    expect(unsafeHomeWrites(source).length).toBeGreaterThan(0);
  });

  it.each([
    "const dir: typeof os.homedir = safe",
    "function read<T extends typeof os.homedir>() {}",
    "safe<typeof os.homedir>()",
    "interface Fixture extends os.homedir { resolveHome: string; homedir(): void }",
    "type Fixture = typeof os.homedir",
    "type Fixture = { [K in keyof typeof os.homedir]: string }",
    "declare namespace Fixture { const home: typeof os.homedir }",
    "declare class Fixture { homedir: typeof os.homedir }",
    "declare function fixture(home: typeof os.homedir): void",
    "declare enum Fixture { Path = 1 }",
    'module "fixture" { import {homedir} from "node:os"; }',
    "import type {homedir} from 'node:os'",
    "export type {resolveHome} from './resolve.ts'",
    "const home = safe as typeof os.homedir",
    "const home = safe satisfies typeof os.homedir",
    "type Fixture = import('node:os').homedir",
    "function read(home: unknown): home is typeof os.homedir { return false }",
  ])('skips explicit type-only syntax: %s', source => {
    expect(unsafeHomeWrites(source)).toEqual([]);
  });

  it.each(['writeFile', 'writeFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
    'rename', 'renameSync', 'unlink', 'unlinkSync'])('covers fs.%s and promise/callback forms', method => {
    expect(unsafeHomeWrites(`fs.${method}(join(homedir(), 'x'), '/tmp/b', callback)`)).toHaveLength(1);
    expect(unsafeHomeWrites(`fs.promises.${method}(join(squawkHomeDir(), 'x'), '/tmp/b')`)).toHaveLength(1);
  });
});
