import { expect, it } from 'vitest';
import { ruleIds } from '../ast-grep-rules.testkit.ts';
import { astGrepProblems } from './run.ts';

// Split the sorted rule list by index so new rules enter exactly one bridge file.
// bound: ast-grep's process timeout is 100 s; leave room for a loaded host.
it('finds no ast-grep problem in repository group 2/2', { timeout: 330_000 }, async () => {
  const rules = ruleIds().filter((_, index) => index % 2 === 1);
  expect(await astGrepProblems(undefined, rules), 'npm run lint: docs/sdlc/lint.md').toEqual([]);
});
