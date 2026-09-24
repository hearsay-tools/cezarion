import { apiRunSchema } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { startTestCockpit, type TestCockpit } from './cockpit.testkit.ts';
import { runTaskCommand, type TaskIo } from './cli.ts';
import type { Cockpit } from './http.ts';

/** `cez task` against a real cockpit app on a real socket (#504). */
describe('cez task', () => {
  let harness: TestCockpit;
  let store: RunStore;
  let manager: RunManager;
  let cockpit: Cockpit;
  let out: string[];
  let discoveries: number;

  beforeEach(async () => {
    harness = await startTestCockpit();
    ({ store, manager, cockpit } = harness);
    out = [];
    discoveries = 0;
  });

  afterEach(() => harness.close());

  const io = (stdin = ''): TaskIo => ({
    stdout: (line) => out.push(line),
    stdin: async () => stdin,
    discover: async () => { discoveries += 1; return cockpit; },
    open: () => {},
  });
  const run = (argv: string[], stdin?: string) => runTaskCommand(argv, {}, io(stdin));
  const last = () => JSON.parse(out.at(-1) ?? 'null') as Record<string, unknown>;
  const start = async (task = 'do the thing') => {
    expect(await run(['start', task])).toBe(0);
    return last().id as string;
  };

  describe('start', () => {
    it('creates a queued run in the cockpit and prints its thread url', async () => {
      expect(await run(['start', 'do the thing'])).toBe(0);
      const printed = last();
      expect(printed).toMatchObject({ status: 'queued', created: true });
      expect(printed.url).toBe(`${cockpit.origin}/p/default/tasks/${printed.id as string}`);
      expect(store.getRun(printed.id as string)?.task).toBe('do the thing');
    });

    it('reports created:false for a retry with the same request id', async () => {
      const id = '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d';
      expect(await run(['start', '--request-id', id, 'x'])).toBe(0);
      const first = last();
      expect(await run(['start', '--request-id', id, 'x'])).toBe(0);
      expect(last()).toMatchObject({ id: first.id, created: false });
      expect(store.listRuns()).toHaveLength(1);
    });

    it('passes a request-id payload conflict through with exit 2 and starts nothing', async () => {
      const id = '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d';
      await run(['start', '--request-id', id, 'x']);
      expect(await run(['start', '--request-id', id, 'y'])).toBe(2);
      expect(last()).toMatchObject({ error: 'request id payload conflict' });
      expect(store.listRuns()).toHaveLength(1);
    });

    it('reads the task from stdin with --task-file -', async () => {
      const text = 'multi\nline "quoted" `code` $HOME';
      expect(await run(['start', '--task-file', '-'], text)).toBe(0);
      expect(store.getRun(last().id as string)?.task).toBe(text);
    });

    it('treats empty stdin as a usage error and starts nothing', async () => {
      expect(await run(['start', '--task-file', '-'], '  \n')).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input' });
      expect(store.listRuns()).toHaveLength(0);
    });

    it('forwards --no-worktree and --autonomous', async () => {
      expect(await run(['start', '--no-worktree', '--autonomous', 'x'])).toBe(0);
      const record = store.getRun(last().id as string);
      expect(record?.worktree).toBe(false);
      expect(record?.autonomous).toBe(true);
    });
  });

  describe('status', () => {
    it('prints the slim projection', async () => {
      const id = await start();
      expect(await run(['status', id])).toBe(0);
      const printed = last();
      expect(Object.keys(printed).sort()).toEqual(
        ['id', 'title', 'status', 'hasPendingHumanAsk', 'tokensUsed', 'url'].sort(),
      );
      expect(printed).toMatchObject({ id, status: 'queued', hasPendingHumanAsk: false });
    });

    it('prints the contract ApiRun with --full', async () => {
      const id = await start();
      expect(await run(['status', '--full', id])).toBe(0);
      expect(apiRunSchema.safeParse(last()).success).toBe(true);
    });

    it('passes an unknown run id through as the cockpit refusal, exit 2', async () => {
      expect(await run(['status', 'bogus'])).toBe(2);
      expect(last()).toMatchObject({ code: 'refused', status: 404, error: 'not found' });
    });
  });

  describe('list', () => {
    it('lists slim rows newest first, hides archived unless --all, filters and limits', async () => {
      const a = await start('a');
      const b = await start('b');
      store.setArchived(a, true);
      expect(await run(['list'])).toBe(0);
      expect((last().runs as Array<{ id: string }>).map((row) => row.id)).toEqual([b]);
      expect(await run(['list', '--all'])).toBe(0);
      expect((last().runs as Array<{ id: string }>).map((row) => row.id).sort()).toEqual([a, b].sort());
      expect(await run(['list', '--all', '--limit', '1'])).toBe(0);
      expect(last().runs).toHaveLength(1);
      store.updateRun(b, { status: 'done' });
      expect(await run(['list', '--status', 'done'])).toBe(0);
      const rows = last().runs as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.id)).toEqual([b]);
      expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'title', 'status', 'hasPendingHumanAsk', 'updatedAt'].sort());
    });
  });

  describe('send', () => {
    it('stacks a message onto a queued run', async () => {
      const id = await start();
      expect(await run(['send', id, 'also this'])).toBe(0);
      expect(last()).toMatchObject({ id, delivery: 'queued' });
      expect(store.getRun(id)?.queuedMessages?.[0]?.text).toBe('also this');
    });

    it('reads the text from stdin with --text-file -', async () => {
      const id = await start();
      expect(await run(['send', id, '--text-file', '-'], 'from "stdin"')).toBe(0);
      expect(store.getRun(id)?.queuedMessages?.[0]?.text).toBe('from "stdin"');
    });

    it('refuses to reopen a closed session without --resume and names the next command', async () => {
      const id = await start();
      manager.cancel(id);
      expect(await run(['send', id, 'hi'])).toBe(1);
      expect(last()).toMatchObject({ id, delivery: 'not-delivered', reason: 'session closed' });
      expect(last().next).toBe(`cez task send ${id} '…' --resume`);
    });

    it('reopens a closed session with --resume', async () => {
      const id = await start();
      manager.cancel(id);
      expect(await run(['send', id, 'go on', '--resume'])).toBe(0);
      expect(last()).toMatchObject({ id, delivery: 'resumed' });
    });

    it('passes an unknown run through as exit 2', async () => {
      expect(await run(['send', 'bogus', 'hi'])).toBe(2);
    });
  });

  describe('stop, finish, diff, open', () => {
    it('stops a run', async () => {
      const id = await start();
      expect(await run(['stop', id])).toBe(0);
      expect(last()).toEqual({ id, cancelled: true });
      expect(store.getRun(id)?.status).toBe('cancelled');
    });

    it('passes the finish refusal reason through verbatim with exit 2', async () => {
      const id = await start();
      expect(await run(['finish', id])).toBe(2);
      expect(last()).toMatchObject({ code: 'refused', status: 409 });
      expect(typeof last().error).toBe('string');
    });

    it('prints the diff as JSON even when the run has no worktree', async () => {
      const id = await start();
      expect(await run(['diff', id])).toBe(0);
      expect(typeof last().diff).toBe('string');
    });

    it('prints the thread url without opening it under --no-open', async () => {
      const id = await start();
      let opened = 0;
      expect(await runTaskCommand(['open', id, '--no-open'], {}, { ...io(), open: () => { opened += 1; } })).toBe(0);
      expect(last()).toEqual({ id, url: `${cockpit.origin}/p/default/tasks/${id}`, opened: false });
      expect(opened).toBe(0);
    });
  });

  describe('usage', () => {
    it('prints help text without discovering a cockpit', async () => {
      expect(await run(['--help'])).toBe(0);
      expect(out.join('\n')).toContain('cez task start');
      expect(await run(['start', '--help'])).toBe(0);
      expect(out.at(-1)).toContain('--request-id');
      expect(discoveries).toBe(0);
    });

    it.each([[['frobnicate']], [['start', '--bogus', 'x']], [['status']], [[]]])(
      'answers %j with the JSON usage error and exit 64',
      async (argv) => {
        expect(await run(argv)).toBe(64);
        expect(last()).toMatchObject({ code: 'invalid_input' });
        expect(last().usage).toBeDefined();
        expect(discoveries).toBe(0);
      },
    );

    it('never prints delegation credentials', async () => {
      const env = { CEZ_DELEGATION_TOKEN: 'secret-token-value', CEZ_DELEGATION_URL: 'http://127.0.0.1:9/api/v1/delegation' };
      await runTaskCommand(['start', 'x'], env, io());
      await runTaskCommand(['status', 'bogus'], env, io());
      expect(out.join('\n')).not.toContain('secret-token-value');
    });
  });
});
