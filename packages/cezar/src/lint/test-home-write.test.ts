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
    "const home = () => homedir(); rmSync(join(home(), 'x'))",
    "const root = homedir(); fs.renameSync(root, '/tmp/x')",
    "fs.promises.rename('/tmp/x', join(homedir(), 'x'))",
    "fs.rmdirSync(join(homedir(), 'x'))",
    "fs.unlink(join(homedir(), 'x'), callback)",
    "import { writeFileSync as write } from 'node:fs'; const save = write; save(homedir(), 'x')",
    "writeFileSync(join((0, os.homedir)(), 'x'), 'x')",
    "function save(path) { writeFileSync(path, '{}') } save(join(homedir(), 'config.json'))",
    "const remove = path => fs.rmSync(path); remove(homedir())",
  ])('rejects an ambient home reaching a write: %s', source => {
    expect(unsafeHomeWrites(source)).toHaveLength(1);
  });

  it.each([
    "writeFileSync(join(Home.sandbox(dir).root, 'config.json'), '{}')",
    "readFileSync(join(homedir(), 'config.json'))",
    "const home = homedir(); expect(path).toBe(join(home, 'x')); writeFileSync(join(tmp, 'x'), home)",
    "const file = join(tmp, 'x'); writeFileSync(file, 'homedir()')",
    "// writeFileSync(homedir(), 'x')\nconst sample = `mkdirSync(cezarHomeDir())`",
    "const home = homedir(); writeFileSync(fixtures.home, home)",
  ])('allows sandbox writes and read-only home paths: %s', source => {
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

  it.each(['writeFile', 'writeFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
    'rename', 'renameSync', 'unlink', 'unlinkSync'])('covers fs.%s and promise/callback forms', method => {
    expect(unsafeHomeWrites(`fs.${method}(join(homedir(), 'x'), '/tmp/b', callback)`)).toHaveLength(1);
    expect(unsafeHomeWrites(`fs.promises.${method}(join(cezarHomeDir(), 'x'), '/tmp/b')`)).toHaveLength(1);
  });
});
