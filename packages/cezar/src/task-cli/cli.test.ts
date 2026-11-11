import { productIdentity } from '../home/identity.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import {
  makeHumanWait,
  RUN_STATUS,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import { runStatusSchema } from '@open-mercato/cezar-contract/runs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runTaskCommand, taskHelp } from './cli.ts';
import { harness, store, manager, cockpit, out, discoveries, useTaskCliFixture, io, run, withWebhook, last, start, worker } from './cli.testkit.ts';

/** Reload module initializers while Stryker's selected flag-table mutant is active. */
async function freshTaskCli() {
  vi.resetModules();
  return import('./cli.ts');
}

describe('cez task', () => {
  useTaskCliFixture();

  describe('default output and help (#572, #573, #574)', () => {
    it.each(runStatusSchema.options)('prints only the next-action datum for %s rows', async (status) => {
      const id = await start();
      setRunStatus(store, id, status, { currentStepId: 'implement', pullRequestUrl: 'https://github.com/example/repo/pull/1', error: 'failed step\nstack trace', branch: 'cez/test', diffStat: { adds: 1, dels: 2, files: 1 }, tokensUsed: 123 });
      expect(await run(['list'])).toBe(0);
      const datum = status === 'running' ? { currentStepId: 'implement' }
        : status === 'done' || status === 'review' ? { pullRequestUrl: 'https://github.com/example/repo/pull/1' }
          : status === 'failed' ? { error: 'failed step…' } : {};
      const rows = last().runs as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id, title: 'do the thing', status, attention: expect.any(String), attentionLabel: expect.any(String),
        updatedAt: expect.any(String), ...datum,
      });
      const response = await fetch(`${cockpit.api}/runs`);
      expect(await run(['list', '--full'])).toBe(0);
      expect(last().runs).toEqual(await response.json());
    });

    it.each([
      ['199 characters', 'x'.repeat(199), 'x'.repeat(199)],
      ['200 characters', 'x'.repeat(200), 'x'.repeat(200)],
      ['201 characters', 'x'.repeat(201), `${'x'.repeat(199)}…`],
      ['multiple lines', 'first line\nsecond line', 'first line…'],
      ['CRLF', 'first line\r\nsecond line', 'first line…'],
      ['long first line', `${'x'.repeat(200)}\nsecond line`, `${'x'.repeat(199)}…`],
    ])('caps list errors: %s; keeps status and --full errors intact', async (_label, error, expected) => {
      const id = await start();
      setRunStatus(store, id, RUN_STATUS.failed, { error });
      expect(await run(['list'])).toBe(0);
      expect((last().runs as Array<Record<string, unknown>>)[0]?.error).toBe(expected);
      expect(await run(['status', id])).toBe(0);
      expect(last().error).toBe(error);
      const response = await fetch(`${cockpit.api}/runs/${id}`);
      expect(await run(['status', id, '--full'])).toBe(0);
      expect(last()).toEqual(await response.json());
    });

    it.each(['running', 'review', 'failed'] as const)('omits absent next-action fields for %s', async (status) => {
      const id = await start();
      setRunStatus(store, id, status);
      expect(await run(['list'])).toBe(0);
      const row = (last().runs as Array<Record<string, unknown>>)[0]!;
      for (const field of ['currentStepId', 'pullRequestUrl', 'error', 'branch', 'diffStat', 'tokensUsed']) {
        expect(row).not.toHaveProperty(field);
      }
    });

    it('always prints the existing handoff route on default status, including an unseeded run', async () => {
      const id = await start();
      expect(await run(['status', id])).toBe(0);
      expect(last().handoffUrl).toBe(`${cockpit.origin}/api/v1/p/default/runs/${id}/handoff`);
      const response = await fetch(last().handoffUrl as string);
      expect(response.status).toBe(200);
      expect(await run(['status', id, '--full'])).toBe(0);
      expect(last()).not.toHaveProperty('handoffUrl');
    });

    it.each([['list', '--help'], ['--help']])('enumerates exactly the contract statuses in %j', async (...args) => {
      expect(await run(args)).toBe(0);
      const line = out.at(-1)!.split('\n').find((line) => line.startsWith('  --status '));
      expect(line?.split('Only these statuses: ')[1]).toBe(`${runStatusSchema.options.join(', ')}.`);
      expect(discoveries).toBe(0);
    });

    it('repeats the contract statuses in invalid-value errors before discovery', async () => {
      expect(await run(['list', '--status', 'active'])).toBe(64);
      expect(last().error).toBe(`unknown status 'active'; one of ${runStatusSchema.options.join(', ')}`);
      expect(discoveries).toBe(0);
    });

    it.each([['send', '--help'], ['--help']])('teaches steer, answer and resume in %j', async (...args) => {
      expect(await run(args)).toBe(0);
      const help = out.at(-1)!;
      for (const text of [
        ("cez task send <id> 'Use the retry helper instead'").replace("cez", productIdentity().command),
        ("cez task send <id> 'Use option A'").replace("cez", productIdentity().command),
        ("cez task send <id> --resume '…'").replace("cez", productIdentity().command),
        'delivered', 'queued', 'resumed', 'attention: waiting', 'question',
        'Human input', 'delivery: not-delivered', 'next', '--text-file <path|->', '--text-file -', ("cez task start --help").replace("cez", productIdentity().command),
      ]) expect(help).toContain(text);
      expect(discoveries).toBe(0);
    });
  });

  describe('send', () => {
    it.each([[[]], [['--resume']], [['--notify']]])('refuses agent input before discovery with %j', async (flags) => {
      expect(await runTaskCommand(['send', 'target', 'hello', ...flags], { CEZ_TASK_ID: 'sender' }, io())).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: expect.stringContaining('human input'), next: expect.stringContaining(("cez message progress").replace("cez", productIdentity().command)) });
      expect(discoveries).toBe(0);
    });

    it.each(['', '   '])('treats an empty task ID as outside a task: %j', async (taskId) => {
      const id = await start();
      expect(await runTaskCommand(['send', id, 'hello'], { CEZ_TASK_ID: taskId }, io())).toBe(0);
      expect(store.getRun(id)?.queuedMessages?.[0]?.text).toBe('hello');
    });

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
      expect(last().next).toBe(`${productIdentity().command} task send ${id} '…' --resume`);
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

  describe('archive, stop, finish, diff, open', () => {
    it('archives and unarchives a task through the cockpit', async () => {
      const id = await start();
      expect(await run(['archive', id])).toBe(0);
      expect(last()).toEqual({ id, archived: true });
      expect(store.getRun(id)?.archived).toBe(true);
      expect(await run(['list'])).toBe(0);
      expect(last().runs).toEqual([]);

      expect(await run(['unarchive', id])).toBe(0);
      expect(last()).toEqual({ id, archived: false });
      expect(store.getRun(id)?.archived).toBe(false);
      expect(await run(['list'])).toBe(0);
      expect((last().runs as Array<{ id: string }>).map((row) => row.id)).toEqual([id]);
    });

    it('archives finished tasks and reports the count', async () => {
      const finished = await start('finished');
      const active = await start('active');
      setRunStatus(store, finished, RUN_STATUS.done);
      expect(await run(['archive-finished'])).toBe(0);
      expect(last()).toEqual({ archived: 1, ids: [finished], pinnedIds: [] });
      expect(store.getRun(finished)?.archived).toBe(true);
      expect(store.getRun(active)?.archived).toBe(false);
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
      expect(store.readEvents(id).find((event) => event.type === 'handoff')).toMatchObject({ notify: true, message: 'take over' });
      expect(await run(['notify', id, '--off'])).toBe(0);
      expect(last()).toEqual({ id, notify: false });
    });

    it('notify reads the note from stdin, and refuses --off with a note', async () => {
      await withWebhook();
      const id = await start();
      expect(await run(['notify', id, '--message-file', '-'], 'from stdin')).toBe(0);
      expect(store.readEvents(id).find((event) => event.type === 'handoff')).toMatchObject({ message: 'from stdin' });
      expect(await run(['notify', id, '--off', '--message', 'x'])).toBe(64);
    });

    it('notify on a worker is a usage error naming the parent, and subscribes nothing (#635)', async () => {
      await withWebhook();
      const parent = await start('parent');
      const child = worker(parent);
      expect(await run(['notify', child])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', parentId: parent });
      expect(last().error).toContain(`${productIdentity().command} task notify ${parent}`);
      expect(store.getRun(child)?.notify).not.toBe(true);
      // --off still undoes a subscription made before this guard existed.
      store.updateRun(child, { notify: true });
      expect(await run(['notify', child, '--off'])).toBe(0);
      expect(last()).toEqual({ id: child, notify: false });
    });

    it('send --notify on a worker is the same usage error and delivers nothing (#635)', async () => {
      await withWebhook();
      const parent = await start('parent');
      const child = worker(parent);
      expect(await run(['send', child, 'more', '--notify'])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', parentId: parent });
      expect(store.getRun(child)?.notify).not.toBe(true);
      expect(store.getRun(child)?.queuedMessages ?? []).toEqual([]);
    });

    it('send --notify turns the webhook on before delivering', async () => {
      await withWebhook();
      const id = await start();
      expect(await run(['send', id, 'more', '--notify'])).toBe(0);
      expect(last()).toMatchObject({ id, notify: true });
      expect(store.getRun(id)?.notify).toBe(true);
    });

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

  describe('command results (hearsay-tools/cezarion#2353)', () => {
    /** Replace only the response under test; other requests reach the real cockpit. */
    const respond = (suffix: string, data: unknown, status = 200) => {
      const fetch = globalThis.fetch;
      return vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
        String(url) === `${cockpit.api}${suffix}`
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
      manager.cancel(id);
      setRunStatus(store, id, RUN_STATUS.review);
      expect(await run(['finish', id])).toBe(0);
      expect(last()).toEqual({ id, finished: true });
      expect(store.getRun(id)?.status).toBe(RUN_STATUS.done);
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
      const url = `${cockpit.origin}/p/default/tasks/${id}`;
      expect(open.mock.calls).toEqual([[url]]);
      expect(last()).toEqual({ id, url, opened: true });
    });

    it.each(['delivered', 'deferred'] as const)('prints the %s message delivery', async (delivery) => {
      const id = await start();
      const spy = respond(`/runs/${id}/messages`, { [delivery]: true });
      try {
        expect(await run(['send', id, 'message'])).toBe(0);
        expect(last()).toEqual({ id, delivery });
        expect(spy.mock.calls.map(([url]) => String(url))).toEqual([`${cockpit.api}/runs/${id}/messages`]);
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
        expect(spy.mock.calls.map(([url]) => String(url))).toEqual([`${cockpit.api}/runs/${id}/messages`]);
      } finally { spy.mockRestore(); }
    });

    it('passes a continuation refusal through', async () => {
      const id = await start();
      manager.cancel(id);
      const spy = respond(`/runs/${id}/continue`, { error: 'cannot continue' }, 409);
      try {
        expect(await run(['send', id, 'continue text', '--resume'])).toBe(2);
        expect(last()).toEqual({ code: 'refused', status: 409, error: 'cannot continue' });
      } finally { spy.mockRestore(); }
    });

    it('sends the continuation text and omits a notification message', async () => {
      await withWebhook();
      const id = await start();
      manager.cancel(id);
      const spy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['send', id, 'continue text', '--resume', '--notify'])).toBe(0);
        expect(last()).toEqual({ id, delivery: 'resumed', notify: true });
        const posts = spy.mock.calls.filter(([, init]) => init?.method === 'POST')
          .map(([url, init]) => ({ url: String(url), body: JSON.parse(init!.body as string) as unknown }));
        expect(posts).toEqual([
          { url: `${cockpit.api}/runs/${id}/notify`, body: { notify: true } },
          { url: `${cockpit.api}/runs/${id}/messages`, body: { text: 'continue text' } },
          { url: `${cockpit.api}/runs/${id}/continue`, body: { text: 'continue text' } },
        ]);
      } finally { spy.mockRestore(); }
    });

    it('omits unselected start options and skips skill discovery', async () => {
      const spy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['start', 'plain task'])).toBe(0);
        expect(spy.mock.calls.map(([url]) => String(url))).toEqual([`${cockpit.api}/runs`]);
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
      const record = store.getRun(id)!;
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
        expect(store.getRun(last().id as string)?.task).toBe('task');
      } finally { spy.mockRestore(); }
    });

    it('does not mistake a different catalog entry for the requested skill', async () => {
      const dir = join(harness.repoRoot, '.ai/skills');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'other-skill.md'), '# Other skill\n');
      expect(await run(['start', 'task', '--skill', 'wanted'])).toBe(0);
      expect(last()).toMatchObject({ warning: 'skill "wanted" is not currently available; the run may use the plain prompt' });
    });

    it.each([[], ['--full']])('filters and sorts mixed statuses before limiting with %j', async (...flags) => {
      const a = await start('old done');
      const b = await start('queued');
      const c = await start('new done');
      setRunStatus(store, a, RUN_STATUS.done, { createdAt: '2026-01-01T00:00:00.000Z' });
      store.updateRun(b, { createdAt: '2026-01-03T00:00:00.000Z' });
      setRunStatus(store, c, RUN_STATUS.done, { createdAt: '2026-01-02T00:00:00.000Z' });
      const suffix = flags.length > 0 ? '/runs' : '/run-summaries?archived=recent';
      const response = await fetch(`${cockpit.api}${suffix}`);
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
      store.commitWait(id, makeHumanWait({ id: randomUUID() }));
      setRunStatus(store, id, RUN_STATUS.waiting);
      store.appendEvent(id, { type: 'ask.requested', requestId: 'ask-1', questions: [{ header: 'Choice', question: 'Which module?' }] });
      const response = await fetch(`${cockpit.api}/runs/${id}/history-context`);
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
      const discover = vi.fn(async () => cockpit);
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
        expect(store.getRun(last().id as string)?.task).toBe('first é\nsecond 42');
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
        expect(discoveries).toBe(0);
      });
    });

    // /proc exposes open file paths on Linux only; CI runs this resource check there.
    it.skipIf(process.platform !== 'linux')('reads the complete UTF-8 file and closes its descriptor', async () => {
      const path = join(harness.repoRoot, 'task.txt');
      const task = 'é'.repeat(100_000);
      writeFileSync(path, task);
      expect(await run(['start', '--task-file', path])).toBe(0);
      expect(store.getRun(last().id as string)?.task).toBe(task);
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
      const path = join(harness.repoRoot, 'task.txt');
      writeFileSync(path, Buffer.alloc(size, 'x'));
      expect(await run(['start', '--task-file', path])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: error === 'byte limit' ? `${path} is larger than the 100000-character limit` : error });
      expect(discoveries).toBe(0);
    });

    it('refuses a missing text file before discovery', async () => {
      const path = join(harness.repoRoot, 'absent.txt');
      expect(await run(['start', '--task-file', path])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: `cannot read ${path}` });
      expect(discoveries).toBe(0);
    });

    it.each([
      { argv: ['start'], error: 'start is missing the task' },
      { argv: ['send', 'id', '  '], error: 'send is missing the text' },
      { argv: ['start', 'text', '--task-file', '-'], error: 'start takes the task as an argument or a file, not both' },
      { argv: ['send', 'id', 'text', '--text-file', '-'], error: 'send takes the text as an argument or a file, not both' },
    ])('prints the complete text refusal for $argv', async ({ argv, error }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error });
      expect(discoveries).toBe(0);
    });
  });

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
        usage: { operations: expect.arrayContaining([{ name: operation, synopsis: expect.stringContaining(`${productIdentity().command} task ${operation}`) }]) },
      });
      expect(discoveries).toBe(0);
    });

    it.each(booleanFlags)('$operation --$flag refuses a value', async ({ operation, flag }) => {
      expect(await run([operation, `--${flag}=true`])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: `${operation}: Option '--${flag}' does not take an argument` });
      expect(last()).toHaveProperty('usage.operations');
      expect(discoveries).toBe(0);
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
      expect(discoveries).toBe(0);
      expect(store.listRuns()).toEqual([]);
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
      expect(discoveries).toBe(0);
    });

    it.each(['start', 'list', 'status', 'log', 'wait', 'send', 'notify', 'stop', 'finish', 'archive', 'unarchive', 'archive-finished', 'diff', 'open'])(
      '%s accepts help without positionals and rejects values for common flags', async (operation) => {
        expect(await run([operation, '--help'])).toBe(0);
        expect(out.at(-1)).toContain(`${productIdentity().command} task ${operation}`);
        for (const flag of ['url', 'repo']) {
          expect(await run([operation, `--${flag}`])).toBe(64);
          expect(last()).toMatchObject({ code: 'invalid_input', error: `${operation}: Option '--${flag} <value>' argument missing` });
        }
        expect(await run([operation, '--help=true'])).toBe(64);
        expect(last()).toMatchObject({ code: 'invalid_input', error: `${operation}: Option '--help' does not take an argument` });
        expect(discoveries).toBe(0);
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
      expect(out.at(-1)?.split('\n')).toContain(`  ${productIdentity().command} task ${operation} ${args}`.trimEnd());
      expect(await run([operation, ...Array.from({ length: max + 1 }, () => 'x')])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: `${operation} has an extra argument` });
      expect(last()).toHaveProperty('usage.operations');
      expect(discoveries).toBe(0);
    });

    it.each(['status', 'log', 'wait', 'send', 'notify', 'stop', 'finish', 'archive', 'unarchive', 'diff', 'open'])(
      '%s refuses a missing task id', async (operation) => {
        expect(await run([operation])).toBe(64);
        expect(last()).toMatchObject({ code: 'invalid_input', error: `${operation} is missing a positional` });
        expect(discoveries).toBe(0);
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
        expect(discoveries).toBe(0);
      },
    );

    it.each(['-1', '1.5', 'x', ''])('refuses non-integer --since=%s before discovery', async (value) => {
      expect(await run(['log', 'x', `--since=${value}`])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: '--since must be a non-negative integer', usage: { operations: expect.any(Array) } });
      expect(discoveries).toBe(0);
    });

    it.each([
      { argv: ['wait', 'x', '--mode', 'some'], error: '--mode must be one of any, all' },
      { argv: ['wait', 'x', '--until', 'later'], error: '--until must be one of settled, attention' },
      { argv: ['start', 'x', '--wait', '--until', 'later'], error: '--until must be one of settled, attention' },
      { argv: ['log', 'x', '--follow', '--until', 'later'], error: '--until must be one of settled, attention' },
    ])('refuses an unknown choice for $argv', async ({ argv, error }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error, usage: { operations: expect.any(Array) } });
      expect(discoveries).toBe(0);
    });

    it('ignores an unused start timeout when --wait is absent', async () => {
      expect(await run(['start', 'no wait', '--timeout-seconds', '0'])).toBe(0);
      expect(store.getRun(last().id as string)?.task).toBe('no wait');
      expect(last()).toMatchObject({ created: true, status: RUN_STATUS.queued });
    });

    it('defaults wait mode to all when terminal runs have mixed results', async () => {
      const done = await start('done');
      const failed = await start('failed');
      setRunStatus(store, done, RUN_STATUS.done);
      setRunStatus(store, failed, RUN_STATUS.failed);
      expect(await run(['wait', done, failed, '--timeout-seconds', '1800'])).toBe(1);
      expect(last()).toMatchObject({ until: 'attention', timedOut: false, runs: [
        { id: done, status: RUN_STATUS.done }, { id: failed, status: RUN_STATUS.failed },
      ] });
    });

    it.each(['attention', 'settled'])('accepts wait --until %s without a dependent flag', async (until) => {
      const id = await start();
      setRunStatus(store, id, RUN_STATUS.done);
      expect(await run(['wait', id, '--until', until, '--mode', 'any', '--timeout-seconds', '1800'])).toBe(0);
      expect(last()).toMatchObject({ until, timedOut: false, runs: [{ id, status: RUN_STATUS.done }] });
    });

    it('accepts start --wait --until settled after the cockpit finishes the run', async () => {
      const fetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const response = await fetch(url, init);
        if (String(url) === `${cockpit.api}/runs` && init?.method === 'POST') {
          const created = await response.clone().json() as { id: string };
          setRunStatus(store, created.id, RUN_STATUS.done);
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
      store.appendEvent(id, { type: 'text', text: 'visible log line' });
      setRunStatus(store, id, RUN_STATUS.done);
      const offset = out.length;
      expect(await run(['log', id, '--follow', '--until', until, '--since', '0', '--max-chars', '1000000', '--timeout-seconds', '1800'])).toBe(0);
      expect(out.slice(offset).join('\n')).toContain('visible log line');
    });

    it('forwards model and effort with the selected workflow', async () => {
      expect(await run(['start', 'x', '--workflow', 'quick-task', '--model', 'chosen-model', '--effort', 'high'])).toBe(0);
      expect(store.getRun(last().id as string)).toMatchObject({ workflow: 'quick-task', model: 'chosen-model', effort: 'high' });
    });

    it('requests per-file diff counts with --stat', async () => {
      execFileSync('git', ['init', harness.repoRoot]);
      writeFileSync(join(harness.repoRoot, '.git/info/exclude'), '.ai/\n');
      execFileSync('git', ['-C', harness.repoRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base']);
      expect(await run(['start', 'diff task', '--no-worktree'])).toBe(0);
      const id = last().id as string;
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['diff', id, '--stat'])).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${cockpit.api}/runs/${id}/changes`]);
        expect(last()).toMatchObject({ id, stat: { adds: 0, dels: 0, files: 0 }, files: [] });
        expect(last()).not.toHaveProperty('diff');
      } finally { fetchSpy.mockRestore(); }
    });

    it('uses the final repeated string flag and accepts repeated boolean flags', async () => {
      expect(await run(['start', 'x', '--model', 'first', '--model', 'last', '--autonomous', '--autonomous'])).toBe(0);
      expect(store.getRun(last().id as string)).toMatchObject({ model: 'last', autonomous: true });
    });

    it.each(['1', '1000'])('accepts inclusive list limit %s and trims status entries', async (limit) => {
      const id = await start();
      expect(await run(['list', '--limit', limit, '--status', ' done, , queued, '])).toBe(0);
      expect(last()).toMatchObject({ total: 1, runs: [{ id }] });
    });
  });

  describe('usage', () => {
    it('prints help text without discovering a cockpit', async () => {
      expect(await run(['--help'])).toBe(0);
      expect(out.join('\n')).toContain(("cez task start").replace("cez", productIdentity().command));
      expect(out.at(-1)).toContain(("cez task archive <id>").replace("cez", productIdentity().command));
      expect(out.at(-1)).toContain(("cez task unarchive <id>").replace("cez", productIdentity().command));
      expect(out.at(-1)).toContain(("cez task archive-finished").replace("cez", productIdentity().command));
      expect(await run(['start', '--help'])).toBe(0);
      expect(out.at(-1)).toContain('--request-id');
      expect(out.at(-1)).toMatch(/--archive-when-done[^\n]*default off/);
      expect(out.at(-1)).toMatch(/--auto-merge-pr[^\n]*default off/);
      expect(out.at(-1)).toMatch(/--workflow[^\n]*\n  --skill /);
      expect(discoveries).toBe(0);
    });

    it.each([[['--help']], [['start', '--help']]])('documents safe task input in %j (#568)', async (argv) => {
      expect(await run(argv)).toBe(0);
      const help = out.at(-1)!;
      expect(help).toContain(`${productIdentity().command} task start --task-file <path|-> | '<task>'`);
      expect(help).toContain(("cez task start --task-file task.md").replace("cez", productIdentity().command));
      expect(help).toContain(("cez task start --task-file - <<'EOF'").replace("cez", productIdentity().command));
      expect(help).toContain('POSIX shells expand backticks and $() in double-quoted arguments');
      expect(help).toContain('before the CLI receives the text');
      expect(help).toContain('Do not put raw backticks in double-quoted task arguments');
      expect(discoveries).toBe(0);
    });

    // #553/#609: the help is where a bot learns the clear contract, so it is pinned.
    it.each([[['--help']], [['wait', '--help']], [['start', '--help']], [['status', '--help']], [['list', '--help']], [['log', '--help']]])(
      'states the attention contract and the wait default in %j (#553, #609)', async (argv) => {
        expect(await run(argv)).toBe(0);
        const help = out.at(-1)!;
        expect(help).toContain('attention (default)');
        expect(help).toContain('--until settled');
        expect(help).toMatch(/`waiting` is attention even when no question is pending/);
        expect(help).not.toMatch(/hasPendingHumanAsk/);
        expect(help).toMatch(/`waiting` on its own open PR or timer wait [^`]*"waiting for merge"[^`]* is neither settled nor attention/);
        expect(help).toContain(("cez task wait <id>                   # default: stops when the task needs you").replace("cez", productIdentity().command));
        expect(help).toContain(("cez task wait <id> --until settled   # terminal status only").replace("cez", productIdentity().command));
        expect(help).toContain(("cez task start '…' --wait --autonomous --until settled").replace("cez", productIdentity().command));
        expect(discoveries).toBe(0);
      });

    // #931: `log --follow` stops for attention too, so its help carries the same contract.
    it.each([[['--help']], [['log', '--help']]])('documents the log --follow default in %j (#931)', async (argv) => {
      expect(await run(argv)).toBe(0);
      const help = out.at(-1)!;
      expect(help).toContain(("cez task log <id> --follow             # default: stops when the task needs you").replace("cez", productIdentity().command));
      expect(help).toMatch(/--until <attention\|settled>/);
      expect(discoveries).toBe(0);
    });

    it('describes the webhook flags and the notify operation (#589)', async () => {
      expect(await run(['--help'])).toBe(0);
      const all = out.at(-1)!;
      expect(all).toContain(("cez task notify <id>").replace("cez", productIdentity().command));
      expect(all).toContain('--notify');
      expect(all).toContain('--no-notify');
      expect(all).toContain('--off');
      expect(await run(['start', '--help'])).toBe(0);
      expect(out.at(-1)).toMatch(/--notify .*webhook/);
      expect(out.at(-1)).toMatch(/--no-notify .*webhook/);
      expect(out.at(-1)).toContain('notify:');
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

    it.each([[['list', '--limit', '0']], [['list', '--status', 'nope']], [['wait', 'x', '--mode', 'some']], [['log', 'x', '--since', '-1']], [['log', 'x', '--max-chars', '0']], [['start', 'x', '--wait', '--timeout-seconds', '0']], [['start', 'x', '--until', 'settled']], [['start', 'x', '--wait', '--until', 'later']], [['log', 'x', '--until', 'settled']], [['log', 'x', '--follow', '--until', 'later']]])(
      'judges %j as a usage error before looking for a cockpit', async (argv) => {
        expect(await run(argv)).toBe(64);
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
