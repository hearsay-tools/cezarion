import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalTestHomeProblems } from './test-home-repository.ts';
import { testHomeWrite, unsafeHomeWrites } from './test-home-write.ts';

describe('test writes use explicit sandbox paths', () => {
  it.each([
    "writeFileSync(join(cezarHomeDir(), 'config.json'), '{}')",
    "const root = homedir(); const file = join(root, 'config.json'); writeFileSync(file, '{}')",
    "const file = join(home(), 'x'); import { homedir as home } from 'node:os'; fs.promises.writeFile(file, '{}')",
    "import { rename as move } from 'node:fs/promises'; move('/tmp/a', join(os.homedir(), 'b'))",
    "const { rmSync: remove } = fs; remove(join(os['homedir'](), 'x'))",
    "let root; root = cezarHomeDir(); mkdirSync(root)",
    "const root = homedir(); fs.renameSync(root, '/tmp/x')",
    "fs.promises.rename('/tmp/x', join(homedir(), 'x'))",
    "fs.rmdirSync(join(homedir(), 'x'))",
    "fs.unlink(join(homedir(), 'x'), callback)",
    "import { writeFileSync as write } from 'node:fs'; const save = write; save(homedir(), 'x')",
    "writeFileSync(join((0, os.homedir)(), 'x'), 'x')",
    "fs.rmSync(paths['cezarHomeDir']())",
  ])('rejects an ambient home reaching a write: %s', source => {
    expect(unsafeHomeWrites(source)).toHaveLength(1);
  });

  it.each([
    "writeFileSync(join(Home.sandbox(dir).root, 'config.json'), '{}')",
    "readFileSync(join(homedir(), 'config.json')); // test-home-read: inspect the selected home",
    "const home = resolveHome({purpose: 'cli'}); // test-home-read: pure resolution, result not written",
    "const file = join(tmp, 'x'); writeFileSync(file, 'homedir()')",
    "// writeFileSync(homedir(), 'x')\nconst sample = `mkdirSync(cezarHomeDir())`",
  ])('allows explicit sandbox writes and annotated reads: %s', source => {
    expect(unsafeHomeWrites(source)).toEqual([]);
  });

  it.each(['a.test.ts', 'a.test.tsx', 'a.testkit.ts', 'a.test.mjs', 'a.test.cjs'])('covers %s repository-wide', file => {
    expect(testHomeWrite.applies(`scripts/${file}`)).toBe(true);
    expect(testHomeWrite.check(`scripts/${file}`, "writeFileSync(join(cezarHomeDir(), 'config.json'), '{}')")).toHaveLength(1);
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
      writeFileSync(join(root, '.github/scripts/unsafe.test.cjs'), "writeFileSync(join(cezarHomeDir(), 'config.json'), '{}'); process.env.CEZ_HOME = '/host';");
      writeFileSync(join(root, '.github/scripts/mutants-file.cjs'), 'mkdirSync(homedir())');
      const problems = externalTestHomeProblems(root, ['.github/scripts/unsafe.test.cjs', '.github/scripts/mutants-file.cjs', 'deleted.test.mjs']);
      expect(problems).toEqual([expect.stringContaining('cez/home-boundary'), expect.stringContaining('cez/test-home-write')]);
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
  ])('tracks static bindings: %s', (_form, source) => {
    expect(unsafeHomeWrites(source)).toHaveLength(1);
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
    expect(unsafeHomeWrites(source)).toHaveLength(1);
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
    "import {cezarHomeDir as read} from '../paths.ts'; read()",
    "import * as paths from '../paths.ts'; paths.cezarHomeDir()",
    "const {cezarHomeDir: read} = require('../paths.cjs'); read()",
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
    expect(unsafeHomeWrites(source)).toHaveLength(1);
  });

  it.each(['writeFile', 'writeFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
    'rename', 'renameSync', 'unlink', 'unlinkSync'])('covers fs.%s and promise/callback forms', method => {
    expect(unsafeHomeWrites(`fs.${method}(join(homedir(), 'x'), '/tmp/b', callback)`)).toHaveLength(1);
    expect(unsafeHomeWrites(`fs.promises.${method}(join(cezarHomeDir(), 'x'), '/tmp/b')`)).toHaveLength(1);
  });
});
