import { productIdentity } from '../home/identity.ts';
import { describe, expect, it } from 'vitest';

import { taskCliArgumentRun, taskCliFixture } from './cli.testkit.ts';

describe('cez task', () => {
  const ctx = taskCliFixture();
  const { last } = ctx;

  describe('argument contract (hearsay-tools/cezarion#2352)', () => {
    const run = taskCliArgumentRun(ctx.io);

    it.each([
      { argv: [], error: 'missing operation' },
      { argv: ['unknown'], error: "unknown operation 'unknown'" },
      { argv: ['status'], error: 'status is missing a positional' },
      { argv: ['list', 'extra'], error: 'list has an extra argument' },
      { argv: ['wait', ...Array.from({ length: 33 }, (_, i) => String(i))], error: 'wait has an extra argument' },
      { argv: ['--help=true', 'list'], error: "option '--help' does not take a value" },
      { argv: ['-h=true', 'list'], error: "option '-h' does not take a value" },
      { argv: ['-x', 'list'], error: "unknown option '-x' before the operation; only --url, --repo and --help go there" },
      { argv: ['-xurl', 'one', 'list'], error: "unknown option '-xurl' before the operation; only --url, --repo and --help go there" },
      { argv: ['-xrepo', 'one', 'list'], error: "unknown option '-xrepo' before the operation; only --url, --repo and --help go there" },
      { argv: ['--url=one', '--url=two', 'list'], error: "duplicate option '--url'" },
      { argv: ['--repo=one', 'list', '--repo=two'], error: "duplicate option '--repo'" },
      { argv: ['--help', 'list', '--help'], error: "duplicate option '--help'" },
      ...['url', 'repo'].flatMap((flag) => [[], [''], ['--help']].map((tail) => ({
        argv: [`--${flag}`, ...tail], error: `option '--${flag}' requires a value`,
      }))),
    ])('prints the exact parser refusal for $argv', async ({ argv, error }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error, usage: { operations: expect.any(Array) } });
      expect(ctx.discoveries).toBe(0);
    });

    it.each(['start', 'list', 'status', 'log', 'wait', 'send', 'notify', 'stop', 'finish', 'archive', 'unarchive', 'archive-finished', 'diff', 'open'])(
      '%s accepts help without positionals and rejects values for common flags', async (operation) => {
        expect(await run([operation, '--help'])).toBe(0);
        expect(ctx.out.at(-1)).toContain(`${productIdentity().command} task ${operation}`);
        for (const flag of ['url', 'repo']) {
          expect(await run([operation, `--${flag}`])).toBe(64);
          expect(last()).toMatchObject({ code: 'invalid_input', error: `${operation}: Option '--${flag} <value>' argument missing` });
        }
        expect(await run([operation, '--help=true'])).toBe(64);
        expect(last()).toMatchObject({ code: 'invalid_input', error: `${operation}: Option '--help' does not take an argument` });
        expect(ctx.discoveries).toBe(0);
      },
    );

    it.each([
      { operation: 'start', args: "--task-file <path|-> | '<task>'", max: 1 },
      { operation: 'list', args: '', max: 0 },
      { operation: 'status', args: '<id>', max: 1 },
      { operation: 'log', args: '<id>', max: 1 },
      { operation: 'wait', args: '<id>...', max: 32 },
      { operation: 'send', args: "<id> '<text>' | <id> --text-file <path|->", max: 2 },
      { operation: 'notify', args: "<id> [--message '<note>' | --message-file <path|->]", max: 1 },
      { operation: 'stop', args: '<id>', max: 1 },
      { operation: 'finish', args: '<id>', max: 1 },
      { operation: 'archive', args: '<id>', max: 1 },
      { operation: 'unarchive', args: '<id>', max: 1 },
      { operation: 'archive-finished', args: '', max: 0 },
      { operation: 'diff', args: '<id>', max: 1 },
      { operation: 'open', args: '<id>', max: 1 },
    ])('$operation documents and enforces its positional arguments', async ({ operation, args, max }) => {
      expect(await run([operation, '--help'])).toBe(0);
      expect(ctx.out.at(-1)?.split('\n')).toContain(`  ${productIdentity().command} task ${operation} ${args}`.trimEnd());
      expect(await run([operation, ...Array.from({ length: max + 1 }, () => 'x')])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: `${operation} has an extra argument` });
      expect(last()).toHaveProperty('usage.operations');
      expect(ctx.discoveries).toBe(0);
    });

    it.each(['status', 'log', 'wait', 'send', 'notify', 'stop', 'finish', 'archive', 'unarchive', 'diff', 'open'])(
      '%s refuses a missing task id', async (operation) => {
        expect(await run([operation])).toBe(64);
        expect(last()).toMatchObject({ code: 'invalid_input', error: `${operation} is missing a positional` });
        expect(ctx.discoveries).toBe(0);
      },
    );
  });
});
