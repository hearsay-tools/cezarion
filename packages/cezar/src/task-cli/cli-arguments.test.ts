import { describe, expect, it } from 'vitest';

import { taskCliArgumentRun, taskCliFixture } from './cli.testkit.ts';

describe('cez task', () => {
  const ctx = taskCliFixture();
  const { last } = ctx;

  describe('argument contract (hearsay-tools/cezarion#2352)', () => {
    const run = taskCliArgumentRun(ctx.io);

    const stringFlags = [
      ['start', 'task-file request-id workflow skill runner backend model effort until timeout-seconds'],
      ['list', 'status limit'], ['log', 'since max-chars until timeout-seconds'],
      ['wait', 'mode until timeout-seconds'], ['send', 'text-file'], ['notify', 'message message-file'],
    ].flatMap(([operation, flags]) => flags!.split(' ').map((flag) => ({ operation: operation!, flag })));

    const booleanFlags = [
      ['start', 'autonomous archive-when-done auto-merge-pr no-worktree no-workers no-messaging wait notify no-notify'],
      ['list', 'all full'], ['status', 'full'], ['log', 'follow'], ['send', 'resume notify'],
      ['notify', 'off'], ['diff', 'stat'], ['open', 'no-open'],
    ].flatMap(([operation, flags]) => flags!.split(' ').map((flag) => ({ operation: operation!, flag })));

    it.each(stringFlags)('$operation --$flag needs a string value', async ({ operation, flag }) => {
      expect(await run([operation, `--${flag}`])).toBe(64);
      expect(last()).toMatchObject({
        code: 'invalid_input', error: `${operation}: Option '--${flag} <value>' argument missing`,
        usage: { operations: expect.arrayContaining([{ name: operation, synopsis: expect.stringContaining(`cez task ${operation}`) }]) },
      });
      expect(ctx.discoveries).toBe(0);
    });

    it.each(booleanFlags)('$operation --$flag refuses a value', async ({ operation, flag }) => {
      expect(await run([operation, `--${flag}=true`])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: `${operation}: Option '--${flag}' does not take an argument` });
      expect(last()).toHaveProperty('usage.operations');
      expect(ctx.discoveries).toBe(0);
    });

    it.each([
      { argv: ['start', 'x', '--until', 'settled'], error: '--until needs --wait' },
      { argv: ['log', 'x', '--until', 'settled'], error: '--until needs --follow' },
      { argv: ['start', 'x', '--notify', '--no-notify'], error: '--notify and --no-notify cannot be used together' },
      { argv: ['notify', 'x', '--off', '--message', 'note'], error: '--off takes no note' },
      { argv: ['notify', 'x', '--off', '--message-file', '-'], error: '--off takes no note' },
      { argv: ['notify', 'x', '--message', 'a', '--message-file', '-'], error: 'notify takes the note as an argument or a file, not both' },
      { argv: ['start', 'x', '--skill', 'a', '--workflow', 'quick-task'], error: '--skill and --workflow cannot be used together' },
      { argv: ['start', 'x', '--skill', ' '], error: '--skill must name a skill' },
      { argv: ['start', 'x', '--runner', 'codex', '--backend', 'claude'], error: '--runner codex and --backend claude name different runners; pass one --runner' },
    ])('refuses conflicting flags: $error', async ({ argv, error }) => {
      expect(await run(argv, 'note')).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error, usage: { operations: expect.any(Array) } });
      expect(ctx.discoveries).toBe(0);
      expect(ctx.store.listRuns()).toEqual([]);
    });
  });
});
