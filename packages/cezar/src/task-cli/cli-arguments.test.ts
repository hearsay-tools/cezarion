import { setRunStatus } from '../runs/run-store.testkit.ts';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTaskCommand } from './cli.ts';
import { taskCliFixture } from './cli.testkit.ts';

/** Reload module initializers while Stryker's selected flag-table mutant is active. */
async function freshTaskCli() {
  vi.resetModules();
  return import('./cli.ts');
}

describe('cez task', () => {
  const ctx = taskCliFixture();
  const { io, last, start } = ctx;

  describe('argument contract (hearsay-tools/cezarion#2352)', () => {
    let runFlags: typeof runTaskCommand;
    beforeEach(async () => { ({ runTaskCommand: runFlags } = await freshTaskCli()); });
    const run = (argv: string[], stdin?: string) => runFlags(argv, {}, io(stdin));

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
        expect(ctx.out.at(-1)).toContain(`cez task ${operation}`);
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
      expect(ctx.out.at(-1)?.split('\n')).toContain(`  cez task ${operation} ${args}`.trimEnd());
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

    const integers = [
      { argv: ['list'], flag: 'limit', max: 1_000 },
      { argv: ['log', 'x'], flag: 'max-chars', max: 1_000_000 },
      { argv: ['wait', 'x'], flag: 'timeout-seconds', max: 1_800 },
      { argv: ['start', 'x', '--wait'], flag: 'timeout-seconds', max: 1_800 },
      { argv: ['log', 'x', '--follow'], flag: 'timeout-seconds', max: 1_800 },
    ];
    it.each(integers.flatMap((row) => ['0', '-1', '1.5', 'x', '', String(row.max + 1)].map((value) => ({ ...row, value }))))(
      'refuses $flag=$value before discovery for $argv', async ({ argv, flag, max, value }) => {
        expect(await run([...argv, `--${flag}=${value}`])).toBe(64);
        expect(last()).toMatchObject({ code: 'invalid_input', error: `--${flag} must be an integer from 1 to ${max}`, usage: { operations: expect.any(Array) } });
        expect(ctx.discoveries).toBe(0);
      },
    );

    it.each(['-1', '1.5', 'x', ''])('refuses non-integer --since=%s before discovery', async (value) => {
      expect(await run(['log', 'x', `--since=${value}`])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: '--since must be a non-negative integer', usage: { operations: expect.any(Array) } });
      expect(ctx.discoveries).toBe(0);
    });

    it.each([
      { argv: ['wait', 'x', '--mode', 'some'], error: '--mode must be one of any, all' },
      { argv: ['wait', 'x', '--until', 'later'], error: '--until must be one of settled, attention' },
      { argv: ['start', 'x', '--wait', '--until', 'later'], error: '--until must be one of settled, attention' },
      { argv: ['log', 'x', '--follow', '--until', 'later'], error: '--until must be one of settled, attention' },
    ])('refuses an unknown choice for $argv', async ({ argv, error }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error, usage: { operations: expect.any(Array) } });
      expect(ctx.discoveries).toBe(0);
    });

    it('ignores an unused start timeout when --wait is absent', async () => {
      expect(await run(['start', 'no wait', '--timeout-seconds', '0'])).toBe(0);
      expect(ctx.store.getRun(last().id as string)?.task).toBe('no wait');
      expect(last()).toMatchObject({ created: true, status: RUN_STATUS.queued });
    });

    it('defaults wait mode to all when terminal runs have mixed results', async () => {
      const done = await start('done');
      const failed = await start('failed');
      setRunStatus(ctx.store, done, RUN_STATUS.done);
      setRunStatus(ctx.store, failed, RUN_STATUS.failed);
      expect(await run(['wait', done, failed, '--timeout-seconds', '1800'])).toBe(1);
      expect(last()).toMatchObject({ until: 'attention', timedOut: false, runs: [
        { id: done, status: RUN_STATUS.done }, { id: failed, status: RUN_STATUS.failed },
      ] });
    });

    it.each(['attention', 'settled'])('accepts wait --until %s without a dependent flag', async (until) => {
      const id = await start();
      setRunStatus(ctx.store, id, RUN_STATUS.done);
      expect(await run(['wait', id, '--until', until, '--mode', 'any', '--timeout-seconds', '1800'])).toBe(0);
      expect(last()).toMatchObject({ until, timedOut: false, runs: [{ id, status: RUN_STATUS.done }] });
    });

    it('accepts start --wait --until settled after the cockpit finishes the run', async () => {
      const fetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const response = await fetch(url, init);
        if (String(url) === `${ctx.cockpit.api}/runs` && init?.method === 'POST') {
          const created = await response.clone().json() as { id: string };
          setRunStatus(ctx.store, created.id, RUN_STATUS.done);
        }
        return response;
      });
      try {
        expect(await run(['start', 'finish now', '--wait', '--until', 'settled', '--timeout-seconds', '1800'])).toBe(0);
        expect(last()).toMatchObject({ status: RUN_STATUS.done, created: true, until: 'settled', timedOut: false });
      } finally { fetchSpy.mockRestore(); }
    });

    it.each(['attention', 'settled'])('accepts log --follow --until %s and inclusive numeric limits', async (until) => {
      const id = await start();
      ctx.store.appendEvent(id, { type: 'text', text: 'visible log line' });
      setRunStatus(ctx.store, id, RUN_STATUS.done);
      const offset = ctx.out.length;
      expect(await run(['log', id, '--follow', '--until', until, '--since', '0', '--max-chars', '1000000', '--timeout-seconds', '1800'])).toBe(0);
      expect(ctx.out.slice(offset).join('\n')).toContain('visible log line');
    });

    it('forwards model and effort with the selected workflow', async () => {
      expect(await run(['start', 'x', '--workflow', 'quick-task', '--model', 'chosen-model', '--effort', 'high'])).toBe(0);
      expect(ctx.store.getRun(last().id as string)).toMatchObject({ workflow: 'quick-task', model: 'chosen-model', effort: 'high' });
    });

    it('requests per-file diff counts with --stat', async () => {
      execFileSync('git', ['init', ctx.harness.repoRoot]);
      writeFileSync(join(ctx.harness.repoRoot, '.git/info/exclude'), '.ai/\n');
      execFileSync('git', ['-C', ctx.harness.repoRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base']);
      expect(await run(['start', 'diff task', '--no-worktree'])).toBe(0);
      const id = last().id as string;
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['diff', id, '--stat'])).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${ctx.cockpit.api}/runs/${id}/changes`]);
        expect(last()).toMatchObject({ id, stat: { adds: 0, dels: 0, files: 0 }, files: [] });
        expect(last()).not.toHaveProperty('diff');
      } finally { fetchSpy.mockRestore(); }
    });

    it('uses the final repeated string flag and accepts repeated boolean flags', async () => {
      expect(await run(['start', 'x', '--model', 'first', '--model', 'last', '--autonomous', '--autonomous'])).toBe(0);
      expect(ctx.store.getRun(last().id as string)).toMatchObject({ model: 'last', autonomous: true });
    });

    it.each(['1', '1000'])('accepts inclusive list limit %s and trims status entries', async (limit) => {
      const id = await start();
      expect(await run(['list', '--limit', limit, '--status', ' done, , queued, '])).toBe(0);
      expect(last()).toMatchObject({ total: 1, runs: [{ id }] });
    });
  });
});
