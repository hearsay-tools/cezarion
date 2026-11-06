import { afterEach, expect, it, vi } from 'vitest';
import * as scanner from '../ast-grep-rules.testkit.ts';
import { astGrepProblems } from './run.ts';

afterEach(() => vi.restoreAllMocks());

it('selects exact rule ids and still reports added and stale sites in that group', async () => {
  const scan = vi.spyOn(scanner, 'scanRepository').mockResolvedValue([
    { file: 'new.ts', rule: 'rule.a', site: 'new()', line: 3 },
  ]);
  vi.spyOn(scanner, 'readRule').mockImplementation(id => ({ id, message: 'Use the owner.' }));
  vi.spyOn(scanner, 'readBaseline').mockImplementation(rule => rule === 'rule+b'
    ? [{ file: 'old.ts', rule, site: 'old()', count: 1 }] : []);
  const problems = await astGrepProblems(false, ['rule.a', 'rule+b']);
  const filter = new RegExp(scan.mock.calls[0]![0]!);
  expect(['rule.a', 'rule+b', 'ruleXa', 'ruleb', 'prefixrule.a'].filter(id => filter.test(id))).toEqual(['rule.a', 'rule+b']);
  expect(problems).toEqual([
    expect.stringContaining('new.ts:3 ast-grep/rule.a: 1 more'),
    expect.stringContaining('ast-grep/rule+b: stale entry old.ts'),
  ]);
});

it('does not scan all rules when a group is empty', async () => {
  const scan = vi.spyOn(scanner, 'scanRepository').mockRejectedValue(new Error('must not run'));
  expect(await astGrepProblems(false, [])).toEqual([]);
  expect(scan).not.toHaveBeenCalled();
});

it('propagates tool failure from a selected group', async () => {
  vi.spyOn(scanner, 'scanRepository').mockRejectedValue(new Error('scan failed'));
  await expect(astGrepProblems(false, ['rule'])).rejects.toThrow('scan failed');
});
