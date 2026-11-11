import { productIdentity } from '../home/identity.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import { runTaskCommand } from './cli.ts';
import { taskCliFixture } from './cli.testkit.ts';

describe('cez task', () => {
  const ctx = taskCliFixture();
  const { io, run, last, start, worker, withWebhook } = ctx;

  describe('send', () => {
    it.each([[[]], [['--resume']], [['--notify']]])('refuses agent input before discovery with %j', async (flags) => {
      expect(await runTaskCommand(['send', 'target', 'hello', ...flags], { CEZ_TASK_ID: 'sender' }, io())).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: expect.stringContaining('human input'), next: expect.stringContaining(("cez message progress").replace("cez", productIdentity().command)) });
      expect(ctx.discoveries).toBe(0);
    });

    it.each(['', '   '])('treats an empty task ID as outside a task: %j', async (taskId) => {
      const id = await start();
      expect(await runTaskCommand(['send', id, 'hello'], { CEZ_TASK_ID: taskId }, io())).toBe(0);
      expect(ctx.store.getRun(id)?.queuedMessages?.[0]?.text).toBe('hello');
    });

    it('stacks a message onto a queued run', async () => {
      const id = await start();
      expect(await run(['send', id, 'also this'])).toBe(0);
      expect(last()).toMatchObject({ id, delivery: 'queued' });
      expect(ctx.store.getRun(id)?.queuedMessages?.[0]?.text).toBe('also this');
    });

    it('reads the text from stdin with --text-file -', async () => {
      const id = await start();
      expect(await run(['send', id, '--text-file', '-'], 'from "stdin"')).toBe(0);
      expect(ctx.store.getRun(id)?.queuedMessages?.[0]?.text).toBe('from "stdin"');
    });

    it('refuses to reopen a closed session without --resume and names the next command', async () => {
      const id = await start();
      ctx.manager.cancel(id);
      expect(await run(['send', id, 'hi'])).toBe(1);
      expect(last()).toMatchObject({ id, delivery: 'not-delivered', reason: 'session closed' });
      expect(last().next).toBe(`${productIdentity().command} task send ${id} '…' --resume`);
    });

    it('reopens a closed session with --resume', async () => {
      const id = await start();
      ctx.manager.cancel(id);
      expect(await run(['send', id, 'go on', '--resume'])).toBe(0);
      expect(last()).toMatchObject({ id, delivery: 'resumed' });
    });

    it('passes an unknown run through as exit 2', async () => {
      expect(await run(['send', 'bogus', 'hi'])).toBe(2);
    });
  });

  describe('archive, stop, finish, diff, open', () => {
    it('archives and unarchives a task through the cockpit', async () => {
      const id = await start();
      expect(await run(['archive', id])).toBe(0);
      expect(last()).toEqual({ id, archived: true });
      expect(ctx.store.getRun(id)?.archived).toBe(true);
      expect(await run(['list'])).toBe(0);
      expect(last().runs).toEqual([]);

      expect(await run(['unarchive', id])).toBe(0);
      expect(last()).toEqual({ id, archived: false });
      expect(ctx.store.getRun(id)?.archived).toBe(false);
      expect(await run(['list'])).toBe(0);
      expect((last().runs as Array<{ id: string }>).map((row) => row.id)).toEqual([id]);
    });

    it('archives finished tasks and reports the count', async () => {
      const finished = await start('finished');
      const active = await start('active');
      setRunStatus(ctx.store, finished, RUN_STATUS.done);
      expect(await run(['archive-finished'])).toBe(0);
      expect(last()).toEqual({ archived: 1, ids: [finished], pinnedIds: [] });
      expect(ctx.store.getRun(finished)?.archived).toBe(true);
      expect(ctx.store.getRun(active)?.archived).toBe(false);
    });

    it.each(['archive', 'unarchive'])('%s passes an unknown id through as exit 2', async (operation) => {
      expect(await run([operation, 'bogus'])).toBe(2);
      expect(last()).toEqual({ code: 'refused', status: 404, error: 'not found' });
    });

    it('notify hands a task to the webhook with a note, and --off stops it (#589)', async () => {
      await withWebhook();
      const id = await start();
      expect(await run(['notify', id, '--message', 'take over'])).toBe(0);
      expect(last()).toEqual({ id, notify: true, message: true });
      expect(ctx.store.readEvents(id).find((event) => event.type === 'handoff')).toMatchObject({ notify: true, message: 'take over' });
      expect(await run(['notify', id, '--off'])).toBe(0);
      expect(last()).toEqual({ id, notify: false });
    });

    it('notify reads the note from stdin, and refuses --off with a note', async () => {
      await withWebhook();
      const id = await start();
      expect(await run(['notify', id, '--message-file', '-'], 'from stdin')).toBe(0);
      expect(ctx.store.readEvents(id).find((event) => event.type === 'handoff')).toMatchObject({ message: 'from stdin' });
      expect(await run(['notify', id, '--off', '--message', 'x'])).toBe(64);
    });

    it('notify on a worker is a usage error naming the parent, and subscribes nothing (#635)', async () => {
      await withWebhook();
      const parent = await start('parent');
      const child = worker(parent);
      expect(await run(['notify', child])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', parentId: parent });
      expect(last().error).toContain(`${productIdentity().command} task notify ${parent}`);
      expect(ctx.store.getRun(child)?.notify).not.toBe(true);
      // --off still undoes a subscription made before this guard existed.
      ctx.store.updateRun(child, { notify: true });
      expect(await run(['notify', child, '--off'])).toBe(0);
      expect(last()).toEqual({ id: child, notify: false });
    });

    it('send --notify on a worker is the same usage error and delivers nothing (#635)', async () => {
      await withWebhook();
      const parent = await start('parent');
      const child = worker(parent);
      expect(await run(['send', child, 'more', '--notify'])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', parentId: parent });
      expect(ctx.store.getRun(child)?.notify).not.toBe(true);
      expect(ctx.store.getRun(child)?.queuedMessages ?? []).toEqual([]);
    });

    it('send --notify turns the webhook on before delivering', async () => {
      await withWebhook();
      const id = await start();
      expect(await run(['send', id, 'more', '--notify'])).toBe(0);
      expect(last()).toMatchObject({ id, notify: true });
      expect(ctx.store.getRun(id)?.notify).toBe(true);
    });

    it('stops a run', async () => {
      const id = await start();
      expect(await run(['stop', id])).toBe(0);
      expect(last()).toEqual({ id, cancelled: true });
      expect(ctx.store.getRun(id)?.status).toBe('cancelled');
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
      expect(last()).toEqual({ id, url: `${ctx.cockpit.origin}/p/default/tasks/${id}`, opened: false });
      expect(opened).toBe(0);
    });
  });
});
