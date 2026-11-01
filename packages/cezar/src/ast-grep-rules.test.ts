import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  baselinePath,
  baselineRules,
  compareToBaseline,
  missingBinaryMessage,
  readBaseline,
  readRule,
  resolveBinary,
  ruleIds,
  ruleTestsDir,
  runAstGrep,
  shrink,
  tally,
  updateBaseline,
  writeBaseline,
  type BaselineEntry,
  type Site,
} from './ast-grep-rules.testkit.ts';

/**
 * The ast-grep rules that pin construction sites and readers (hearsay-tools/cezarion#1802).
 * Each rule in `.ai/ast-grep/rules` matches a syntax tree, and its baseline records the matches
 * the repository carried when the rule landed. `npm run lint` scans the repository and fails a
 * match beyond the baseline with the rule's message, which names the owner to use instead. The baseline can only shrink, the same
 * shape `test-wait-discipline.test.ts` uses for the unit tests' waits. The rules' own cases
 * live in `.ai/ast-grep/rule-tests`, so a rule that stops matching cannot go dead unseen.
 */
// bound: each case below starts the ast-grep binary, a second on an idle host. This is a hang
// guard for a loaded one, longer than the testkit's 100 s process timeout so that a hang names itself.
const SPAWN_TIMEOUT_MS = 120_000;

const site = (file: string, name: string, line = 1): Site => ({ file, rule: 'r', site: name, line });
const entry = (file: string, name: string, count: number): BaselineEntry => ({ file, rule: 'r', site: name, count });

describe('the rule files', () => {
  it('name each rule file for its rule, and give each rule a message and a rule-tests file', () => {
    const ids = ruleIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(readRule(id).id, `${id}.yml declares another id`).toBe(id);
      const testFile = join(ruleTestsDir, `${id}-test.yml`);
      expect(existsSync(testFile), `${id} has no ${testFile}: ast-grep test pins each rule on valid and invalid snippets`).toBe(true);
      expect(parse(readFileSync(testFile, 'utf8')), `${id}-test.yml tests another rule`).toMatchObject({ id });
    }
  });

  it('keep every baseline beside a rule of its name, and name that rule in each entry', () => {
    const ids = new Set(ruleIds());
    for (const rule of baselineRules()) {
      expect(ids.has(rule), `${rule}.baseline.json has no ${rule}.yml beside it`).toBe(true);
      for (const { rule: named } of readBaseline(rule)) expect(named, `${rule}.baseline.json holds an entry for another rule`).toBe(rule);
    }
  });
});

describe('the rule cases', () => {
  it('report every invalid snippet and no valid one', { timeout: SPAWN_TIMEOUT_MS }, async () => {
    const run = await runAstGrep(['test', '--skip-snapshot-tests']);
    expect(run.code, `ast-grep test failed:\n${run.stdout}${run.stderr}`).toBe(0);
  });
});

describe('the baseline helpers', () => {
  it('tally sites by file and first line, sorted', () => {
    expect(tally([site('b.ts', 's', 9), site('a.ts', 'z', 5), site('a.ts', 'z', 12), site('a.ts', 'y', 1)])).toEqual([
      entry('a.ts', 'y', 1),
      entry('a.ts', 'z', 2),
      entry('b.ts', 's', 1),
    ]);
  });

  it('reports a new match as added and a fixed one as stale', () => {
    const baseline = [entry('a.ts', 'old', 2), entry('a.ts', 'gone', 1)];
    const actual = [entry('a.ts', 'old', 1), entry('a.ts', 'new', 1)];
    expect(compareToBaseline(actual, baseline)).toEqual({
      added: [entry('a.ts', 'new', 1)],
      // A lowered count and a vanished match are both stale: the baseline must shrink to match.
      stale: [entry('a.ts', 'old', 2), entry('a.ts', 'gone', 1)],
    });
  });

  it('reports only the surplus of a known match as added', () => {
    expect(compareToBaseline([entry('a.ts', 's', 3)], [entry('a.ts', 's', 2)]).added).toEqual([entry('a.ts', 's', 1)]);
  });

  it('allows no match when a rule has no baseline file', () => {
    expect(readBaseline('no-such-rule')).toEqual([]);
    expect(compareToBaseline([entry('a.ts', 's', 1)], []).added).toEqual([entry('a.ts', 's', 1)]);
  });

  it('shrink lowers a count, drops a gone match and never adds one', () => {
    const baseline = [entry('a.ts', 'two', 2), entry('a.ts', 'gone', 1), entry('b.ts', 'same', 1)];
    const actual = [entry('a.ts', 'two', 1), entry('b.ts', 'same', 4), entry('c.ts', 'new', 1)];
    expect(shrink(baseline, actual)).toEqual([entry('a.ts', 'two', 1), entry('b.ts', 'same', 1)]);
  });
});

describe('update mode', () => {
  // The helpers take the directory, so no case writes a real baseline.
  const inTempDir = (run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'ast-grep-rules-'));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('starts the baseline of a rule that has none with the matches it has now', () => {
    inTempDir((dir) => {
      updateBaseline('r', [entry('a.ts', 's', 2)], dir);
      expect(readBaseline('r', dir)).toEqual([entry('a.ts', 's', 2)]);
      expect(JSON.parse(readFileSync(baselinePath('r', dir), 'utf8'))).toHaveProperty('$comment');
    });
  });

  it('writes no baseline for a rule with no match and none recorded', () => {
    inTempDir((dir) => {
      updateBaseline('r', [], dir);
      expect(existsSync(baselinePath('r', dir))).toBe(false);
    });
  });

  it('lowers a baseline that exists and never adds a match to it', () => {
    inTempDir((dir) => {
      writeBaseline('r', [entry('a.ts', 'two', 2), entry('a.ts', 'gone', 1)], dir);
      updateBaseline('r', [entry('a.ts', 'two', 1), entry('b.ts', 'new', 3)], dir);
      expect(readBaseline('r', dir)).toEqual([entry('a.ts', 'two', 1)]);
    });
  });
});

describe('finding the ast-grep binary', () => {
  it('returns the path the package resolves', () => {
    expect(resolveBinary({ resolveBinaryPath: () => '/x/ast-grep', detectPackageName: () => 'p' })).toBe('/x/ast-grep');
  });

  it('fails on a host with no binary, and names the package it is missing', () => {
    const resolver = { resolveBinaryPath: () => null, detectPackageName: () => '@ast-grep/cli-linux-x64-gnu' };
    expect(() => resolveBinary(resolver)).toThrow(/@ast-grep\/cli-linux-x64-gnu is not installed.*without --no-optional/s);
  });

  it('fails on a platform the package has no binary for, and names the platform', () => {
    const resolver = { resolveBinaryPath: () => null, detectPackageName: () => null };
    expect(() => resolveBinary(resolver)).toThrow(new RegExp(`no ast-grep binary for ${process.platform} ${process.arch}`));
    expect(missingBinaryMessage(null, 'linux', 'x64')).toContain('no ast-grep binary for linux x64');
  });

  it('finds the binary installed in this checkout', () => {
    expect(existsSync(resolveBinary())).toBe(true);
  });
});
