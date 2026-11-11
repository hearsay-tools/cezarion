import { setRunStatus } from '../runs/run-store.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { makeHumanWait, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it, vi } from 'vitest';
import { runTaskCommand, taskHelp } from './cli.ts';
import { taskCliFixture } from './cli.testkit.ts';
describe('cez task', () => {
  const ctx = taskCliFixture();
  const { io, run, last, start, withWebhook } = ctx;
  describe('command results (hearsay-tools/cezarion#2353)', () => {

/** Replace only the response under test; other requests reach the real cockpit. */
    const respond = (suffix: string, data: unknown, status = 200) => {
      const fetch = globalThis.fetch;
      return vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
        String(url) === `${ctx.cockpit.api}${suffix}`
          ? Promise.resolve(Response.json(data, { status })) : fetch(url, init));
    };

    it.each([
      { argv: ['status', 'target'], suffix: '/runs/target', what: 'run' },
      { argv: ['list', '--full'], suffix: '/runs', what: 'run list' },
      { argv: ['start', 'task'], suffix: '/runs', what: 'start' },
      { argv: ['send', 'target', 'text'], suffix: '/runs/target/messages', what: 'message' },
      { argv: ['stop', 'target'], suffix: '/runs/target/cancel', what: 'cancel' },
      { argv: ['finish', 'target'], suffix: '/runs/target/finish', what: 'finish' },
      { argv: ['archive', 'target'], suffix: '/runs/target/archive', what: 'archive' },
      { argv: ['archive-finished'], suffix: '/runs/archive-finished', what: 'archive-finished' },
      { argv: ['diff', 'target', '--stat'], suffix: '/runs/target/changes', what: 'changes' },
      { argv: ['diff', 'target'], suffix: '/runs/target/diff', what: 'diff' },
    ])('refuses a malformed $what response', async ({ argv, suffix, what }) => {
      const spy = respond(suffix, {});
      try {
        expect(await run(argv)).toBe(2);
        expect(last()).toEqual({ code: 'unavailable', error: `cockpit returned an unexpected ${what} response` });
      } finally { spy.mockRestore(); }
    });

    it.each([
      { argv: ['list', '--full'], suffix: '/runs' },
      { argv: ['stop', 'target'], suffix: '/runs/target/cancel' },
      { argv: ['archive-finished'], suffix: '/runs/archive-finished' },
      { argv: ['diff', 'target', '--stat'], suffix: '/runs/target/changes' },
      { argv: ['diff', 'target'], suffix: '/runs/target/diff' },
    ])('passes the cockpit refusal through for $argv', async ({ argv, suffix }) => {
      const spy = respond(suffix, { error: 'operation refused' }, 403);
      try {
        expect(await run(argv)).toBe(2);
        expect(last()).toEqual({ code: 'refused', status: 403, error: 'operation refused' });
      } finally { spy.mockRestore(); }
    });

    it.each([200, 403])('validates notify responses with HTTP %s', async (status) => {
      const id = await start();
      const spy = respond(`/runs/${id}/notify`, { error: 'subscription refused' }, status);
      try {
        expect(await run(['notify', id])).toBe(2);
        expect(last()).toEqual(status === 200
          ? { code: 'unavailable', error: 'cockpit returned an unexpected notify response' }
          : { code: 'refused', status, error: 'subscription refused' });
      } finally { spy.mockRestore(); }
    });

    it('prints successful finish and the stored completion', async () => {
      const id = await start();
      ctx.manager.cancel(id);
      setRunStatus(ctx.store, id, RUN_STATUS.review);
      expect(await run(['finish', id])).toBe(0);
      expect(last()).toEqual({ id, finished: true });
      expect(ctx.store.getRun(id)?.status).toBe(RUN_STATUS.done);
    });

    it('prints each changed file with its counts', async () => {
      const id = await start();
      const stat = { adds: 7, dels: 2, files: 1 };
      const file = { path: 'src/task.ts', status: 'modified', adds: 7, dels: 2 };
      const spy = respond(`/runs/${id}/changes`, { stat, files: [{ ...file, binary: false, patch: 'task patch' }] });
      try {
        expect(await run(['diff', id, '--stat'])).toBe(0);
        expect(last()).toEqual({ id, stat, files: [file] });
      } finally { spy.mockRestore(); }
    });

    it('opens the printed task URL once', async () => {
      const id = await start();
      const open = vi.fn();
      expect(await runTaskCommand(['open', id], {}, { ...io(), open })).toBe(0);
      const url = `${ctx.cockpit.origin}/p/default/tasks/${id}`;
      expect(open.mock.calls).toEqual([[url]]);
      expect(last()).toEqual({ id, url, opened: true });
    });

    it.each(['delivered', 'deferred'] as const)('prints the %s message delivery', async (delivery) => {
      const id = await start();
      const spy = respond(`/runs/${id}/messages`, { [delivery]: true });
      try {
        expect(await run(['send', id, 'message'])).toBe(0);
        expect(last()).toEqual({ id, delivery });
        expect(spy.mock.calls.map(([url]) => String(url))).toEqual([`${ctx.cockpit.api}/runs/${id}/messages`]);
      } finally { spy.mockRestore(); }
    });

    it.each([
      { status: 409, data: { error: 'another conflict' }, error: 'another conflict' },
      { status: 403, data: { error: 'session closed' }, error: 'session closed' },
      { status: 409, data: null, error: 'cockpit answered HTTP 409' },
    ])('does not resume a different refusal: $status $data', async ({ status, data, error }) => {
      const id = await start();
      const spy = respond(`/runs/${id}/messages`, data, status);
      try {
        expect(await run(['send', id, 'message', '--resume'])).toBe(2);
        expect(last()).toEqual({ code: 'refused', status, error });
        expect(spy.mock.calls.map(([url]) => String(url))).toEqual([`${ctx.cockpit.api}/runs/${id}/messages`]);
      } finally { spy.mockRestore(); }
    });

    it('passes a continuation refusal through', async () => {
      const id = await start();
      ctx.manager.cancel(id);
      const spy = respond(`/runs/${id}/continue`, { error: 'cannot continue' }, 409);
      try {
        expect(await run(['send', id, 'continue text', '--resume'])).toBe(2);
        expect(last()).toEqual({ code: 'refused', status: 409, error: 'cannot continue' });
      } finally { spy.mockRestore(); }
    });

    it('sends the continuation text and omits a notification message', async () => {
      await withWebhook();
      const id = await start();
      ctx.manager.cancel(id);
      const spy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['send', id, 'continue text', '--resume', '--notify'])).toBe(0);
        expect(last()).toEqual({ id, delivery: 'resumed', notify: true });
        const posts = spy.mock.calls.filter(([, init]) => init?.method === 'POST')
          .map(([url, init]) => ({ url: String(url), body: JSON.parse(init!.body as string) as unknown }));
        expect(posts).toEqual([
          { url: `${ctx.cockpit.api}/runs/${id}/notify`, body: { notify: true } },
          { url: `${ctx.cockpit.api}/runs/${id}/messages`, body: { text: 'continue text' } },
          { url: `${ctx.cockpit.api}/runs/${id}/continue`, body: { text: 'continue text' } },
        ]);
      } finally { spy.mockRestore(); }
    });

    it('omits unselected start options and skips skill discovery', async () => {
      const spy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['start', 'plain task'])).toBe(0);
        expect(spy.mock.calls.map(([url]) => String(url))).toEqual([`${ctx.cockpit.api}/runs`]);
        const body = JSON.parse(spy.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
        expect(body).toEqual({ task: 'plain task', workflow: 'quick-task', clientRequestId: expect.any(String) });
        expect(last()).toEqual({
          id: expect.any(String), url: expect.any(String), status: RUN_STATUS.queued,
          created: true, requestId: body.clientRequestId, notify: false,
        });
      } finally { spy.mockRestore(); }
    });

    it('prints a branch returned by start', async () => {
      const id = await start();
      const record = ctx.store.getRun(id)!;
      const spy = respond('/runs', { ...record, branch: 'cez/example' }, 201);
      try {
        expect(await run(['start', 'branch task'])).toBe(0);
        expect(last()).toMatchObject({ id, branch: 'cez/example', created: true });
      } finally { spy.mockRestore(); }
    });

    it.each([
      { status: 200, catalog: {} },
      { status: 503, catalog: [] },
    ])('warns when the catalog is invalid or refused: $status', async ({ status, catalog }) => {
      const spy = respond('/skills?wait=1', catalog, status);
      try {
        expect(await run(['start', 'task', '--skill', 'wanted'])).toBe(0);
        expect(last()).toMatchObject({
          warning: 'could not check whether skill "wanted" is available; the run may use the plain prompt', created: true,
        });
        expect(ctx.store.getRun(last().id as string)?.task).toBe('task');
      } finally { spy.mockRestore(); }
    });

    it('does not mistake a different catalog entry for the requested skill', async () => {
      const dir = join(ctx.harness.repoRoot, '.ai/skills');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'other-skill.md'), '# Other skill\n');
      expect(await run(['start', 'task', '--skill', 'wanted'])).toBe(0);
      expect(last()).toMatchObject({ warning: 'skill "wanted" is not currently available; the run may use the plain prompt' });
    });

    it.each([[], ['--full']])('filters and sorts mixed statuses before limiting with %j', async (...flags) => {
      const a = await start('old done');
      const b = await start('queued');
      const c = await start('new done');
      setRunStatus(ctx.store, a, RUN_STATUS.done, { createdAt: '2026-01-01T00:00:00.000Z' });
      ctx.store.updateRun(b, { createdAt: '2026-01-03T00:00:00.000Z' });
      setRunStatus(ctx.store, c, RUN_STATUS.done, { createdAt: '2026-01-02T00:00:00.000Z' });
      const suffix = flags.length > 0 ? '/runs' : '/run-summaries?archived=recent';
      const response = await fetch(`${ctx.cockpit.api}${suffix}`);
      const rows = await response.json() as Array<{ createdAt: string }>;
      // The real server sorts too. Return oldest first to exercise the CLI's own order.
      const spy = respond(suffix, rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      try {
        expect(await run(['list', ...flags, '--status', 'done', '--limit', '1'])).toBe(0);
        expect(last()).toMatchObject({ runs: [{ id: c }], total: 2 });
        expect(last().runs).toHaveLength(1);
      } finally { spy.mockRestore(); }
    });

    it.each([
      { status: 200, context: {} },
      { status: 503, context: { contextEvents: [], asOfSeq: 0 } },
    ])('omits a question when history is unavailable: $status', async ({ status, context }) => {
      const id = await start();
      ctx.store.commitWait(id, makeHumanWait({ id: randomUUID() }));
      setRunStatus(ctx.store, id, RUN_STATUS.waiting);
      ctx.store.appendEvent(id, { type: 'ask.requested', requestId: 'ask-1', questions: [{ header: 'Choice', question: 'Which module?' }] });
      const response = await fetch(`${ctx.cockpit.api}/runs/${id}/history-context`);
      const data: unknown = status === 503 ? await response.json() : context;
      const spy = respond(`/runs/${id}/history-context`, data, status);
      try {
        expect(await run(['status', id])).toBe(0);
        expect(last()).toMatchObject({ id, status: RUN_STATUS.waiting });
        expect(last()).not.toHaveProperty('question');
      } finally { spy.mockRestore(); }
    });

    it('uses the default stdout for help', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await runTaskCommand(['-h'], {})).toBe(0);
        expect(log.mock.calls).toEqual([[taskHelp()]]);
      } finally { log.mockRestore(); }
    });

    it.each([new Error('discovery broke'), 'discovery broke'])('prints an unexpected discovery failure: %s', async (error) => {
      expect(await runTaskCommand(['list'], {}, { ...io(), discover: async () => { throw error; } })).toBe(2);
      expect(last()).toEqual({ code: 'internal', error: 'discovery broke' });
    });

    it.each(['  http://127.0.0.1:1234  ', '   '])('trims the environment URL: %j', async (url) => {
      const discover = vi.fn(async () => ctx.cockpit);
      expect(await runTaskCommand(['list'], { CEZ_URL: url }, { ...io(), discover })).toBe(0);
      expect(discover.mock.calls).toEqual([[{ url: url.trim() || undefined, repoDir: resolve(process.cwd()) }]]);
    });

    it('lets an agent read status without using the human send channel', async () => {
      const id = await start();
      expect(await runTaskCommand(['status', id], { CEZ_TASK_ID: 'agent' }, io())).toBe(0);
      expect(last()).toMatchObject({ id, status: RUN_STATUS.queued });
    });
  });

  describe('command text input (hearsay-tools/cezarion#2353)', () => {
    /** Restore the real stream even when a CLI assertion fails. */
    const withStdin = async (chunks: unknown[], action: () => Promise<void>) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
      Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(chunks) });
      try { await action(); } finally { Object.defineProperty(process, 'stdin', descriptor); }
    };

    it('reads native stdin buffers and string chunks without changing text', async () => {
      const options = io();
      delete options.stdin;
      await withStdin([Buffer.from('first é\n'), 'second ', 42], async () => {
        expect(await runTaskCommand(['start', '--task-file', '-'], {}, options)).toBe(0);
        expect(ctx.store.getRun(last().id as string)?.task).toBe('first é\nsecond 42');
      });
    });

    it.each([
      { size: 400_000, error: 'task is longer than 100000 characters' },
      { size: 400_001, error: 'stdin is larger than the 100000-character limit' },
    ])('bounds native stdin at $size bytes', async ({ size, error }) => {
      const options = io();
      delete options.stdin;
      await withStdin([Buffer.alloc(size, 'x')], async () => {
        expect(await runTaskCommand(['start', '--task-file', '-'], {}, options)).toBe(64);
        expect(last()).toMatchObject({ code: 'invalid_input', error });
        expect(ctx.discoveries).toBe(0);
      });
    });

    // /proc exposes open file paths on Linux only; CI runs this resource check there.
    it.skipIf(process.platform !== 'linux')('reads the complete UTF-8 file and closes its descriptor', async () => {
      const path = join(ctx.harness.repoRoot, 'task.txt');
      const task = 'é'.repeat(100_000);
      writeFileSync(path, task);
      expect(await run(['start', '--task-file', path])).toBe(0);
      expect(ctx.store.getRun(last().id as string)?.task).toBe(task);
      // A leaked descriptor is an OS-visible resource, even after the read succeeds.
      const paths = readdirSync('/proc/self/fd').map((fd) => {
        try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return undefined; }
      });
      expect(paths).not.toContain(path);
    });

    it.each([
      { size: 400_000, error: 'task is longer than 100000 characters' },
      { size: 400_001, error: 'byte limit' },
    ])('bounds a text file at $size bytes', async ({ size, error }) => {
      const path = join(ctx.harness.repoRoot, 'task.txt');
      writeFileSync(path, Buffer.alloc(size, 'x'));
      expect(await run(['start', '--task-file', path])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: error === 'byte limit' ? `${path} is larger than the 100000-character limit` : error });
      expect(ctx.discoveries).toBe(0);
    });

    it('refuses a missing text file before discovery', async () => {
      const path = join(ctx.harness.repoRoot, 'absent.txt');
      expect(await run(['start', '--task-file', path])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: `cannot read ${path}` });
      expect(ctx.discoveries).toBe(0);
    });

    it.each([
      { argv: ['start'], error: 'start is missing the task' },
      { argv: ['send', 'id', '  '], error: 'send is missing the text' },
      { argv: ['start', 'text', '--task-file', '-'], error: 'start takes the task as an argument or a file, not both' },
      { argv: ['send', 'id', 'text', '--text-file', '-'], error: 'send takes the text as an argument or a file, not both' },
    ])('prints the complete text refusal for $argv', async ({ argv, error }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error });
      expect(ctx.discoveries).toBe(0);
    });
  });
});
