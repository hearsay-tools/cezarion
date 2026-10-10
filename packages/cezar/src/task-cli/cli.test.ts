import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { apiRunSchema, runStatusSchema } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { startTestCockpit, type TestCockpit } from './cockpit.testkit.ts';
import { runTaskCommand, taskHelp, type TaskIo } from './cli.ts';
import { discoverCockpit } from './discovery.ts';
import { TaskCliError, type Cockpit } from './http.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { registerProject } from '../workspace/projects.ts';

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
  /** Register the harness repo with a task webhook (#589); CEZ_HOME is a per-worker sandbox. */
  const withWebhook = async () => {
    const entry = await registerProject(harness.repoRoot);
    await mergeWriteWorkspaceConfig((config) => {
      const found = config.projects.find((p) => p.id === entry.id)!;
      found.webhook = { url: 'https://bot.example/hook', token: 't' };
    });
  };
  const last = () => JSON.parse(out.at(-1) ?? 'null') as Record<string, unknown>;
  const start = async (task = 'do the thing') => {
    expect(await run(['start', task])).toBe(0);
    return last().id as string;
  };
  /** A delegated worker owned by `parentId`, as the delegation layer creates one (#635). */
  const worker = (parentId: string) => {
    const workerId = randomUUID();
    if (!store.getRun(parentId)?.delegation) store.updateRun(parentId, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    return store.createOwnedRun(
      { title: 'worker', task: 'worker', workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] },
      parentId,
      randomUUID(),
      {
        role: 'worker', permissions: [], parentRunId: parentId,
        workspace: {
          ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
          path: `/managed/${workerId}`, branch: `cez/${workerId.slice(0, 8)}`, baselineSha: 'a'.repeat(40),
        },
      },
      'a'.repeat(64),
    ).id;
  };

  describe('shared flag positions (hearsay-tools/cezarion#554)', () => {
    const cases = ['list', 'status', 'stop'].flatMap((operation) =>
      ['url', 'repo'].flatMap((flag) => ['before', 'after'].flatMap((position) =>
        ['space', 'equals'].map((form) => ({ operation, flag, position, form })),
      )),
    );
    it.each(cases)('$operation with --$flag $position ($form) resolves and requests the same cockpit', async ({ operation, flag, position, form }) => {
      const project = await registerProject(harness.repoRoot);
      const api = `${cockpit.origin}/api/v1/p/${project.id}`;
      const id = await start();
      const value = flag === 'url' ? cockpit.origin : harness.repoRoot;
      const globals = form === 'space' ? [`--${flag}`, value] : [`--${flag}=${value}`];
      const command = operation === 'list' ? [operation] : [operation, id];
      const argv = position === 'before' ? [...globals, ...command] : [...command, ...globals];
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await runTaskCommand(argv, flag === 'url' ? { CEZ_URL: 'http://127.0.0.1:1' } : {}, {
          ...io(),
          discover: async (options) => {
            expect(options).toEqual({
              url: flag === 'url' ? cockpit.origin : undefined,
              repoDir: flag === 'repo' ? harness.repoRoot : resolve(process.cwd()),
            });
            const found = await discoverCockpit({ ...options, ports: [Number(new URL(cockpit.origin).port)] });
            expect(found.api).toBe(api);
            return found;
          },
        })).toBe(0);
        const requests = fetchSpy.mock.calls
          .filter(([url]) => String(url).startsWith(api + '/'))
          .map(([url, init]) => ({ url: String(url), method: init?.method ?? 'GET' }));
        expect(requests).toEqual([{
          url: operation === 'list' ? `${api}/run-summaries?archived=recent`
            : `${api}/runs/${id}${operation === 'stop' ? '/cancel' : ''}`,
          method: operation === 'stop' ? 'POST' : 'GET',
        }]);
        if (operation === 'list') expect(last().runs).toMatchObject([{ id }]);
        else if (operation === 'status') expect(last()).toMatchObject({ id, status: 'queued' });
        else {
          expect(last()).toEqual({ id, cancelled: true });
          expect(store.getRun(id)?.status).toBe('cancelled');
        }
      } finally { fetchSpy.mockRestore(); }
    });

    it.each(['--x', '--wait', '--full', '--timeout-seconds=1'])('rejects %s before the operation without discovery', async (flag) => {
      expect(await run([flag, 'start', 'x'])).toBe(64);
      expect(last()).toMatchObject({
        code: 'invalid_input',
        error: `unknown option '${flag.split('=')[0]}' before the operation; only --url, --repo and --help go there`,
        usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: 'cez task list' }]) },
      });
      expect(discoveries).toBe(0);
    });

    it.each([
      ['--url', 'http://127.0.0.1:1', 'list', '--url=http://127.0.0.1:2'],
      ['--repo=one', 'list', '--repo', 'two'],
      ['--help', 'list', '--help'],
      ['-h', 'list', '--help'],
      ['--url=one', '--url', 'two', 'list'],
      ['--repo', 'one', '--repo=two', 'list'],
      ['--help', '-h', 'list'],
    ].map((argv) => ({ argv })))('rejects duplicate shared flags in $argv', async ({ argv }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: expect.stringContaining('duplicate option'), usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: 'cez task list' }]) } });
      expect(discoveries).toBe(0);
    });

    it.each(['url', 'repo'].flatMap((flag) => [
      [`--${flag}`], [`--${flag}`, '--help', 'list'], [`--${flag}=--help`, 'list'],
      [`--${flag}`, '', 'list'], [`--${flag}=`, 'list'],
    ]).map((argv) => ({ argv })))('rejects missing or option-shaped leading values in $argv', async ({ argv }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: expect.stringContaining('requires a value'), usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: 'cez task list' }]) } });
      expect(discoveries).toBe(0);
    });

    it.each([['--url', 'http://127.0.0.1:1'], ['--repo=checkout']].map((argv) => ({ argv })))('reports missing operation after $argv', async ({ argv }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: 'missing operation', usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: 'cez task list' }]) } });
      expect(discoveries).toBe(0);
    });

    it.each(['--help', '-h'].flatMap((help) => ['start', 'list', 'status', 'stop'].map((operation) => ({ help, operation }))))(
      '$help $operation prints operation help without discovery', async ({ help, operation }) => {
        expect(await run([help, operation])).toBe(0);
        expect(out.at(-1)).toBe(taskHelp(operation));
        expect(discoveries).toBe(0);
      },
    );

    it('keeps parsing after the operation strict even with leading help', async () => {
      expect(await run(['--help', 'list', '--x'])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input' });
      expect(discoveries).toBe(0);
    });
  });

  describe('start', () => {
    it('creates a queued run in the cockpit and prints its thread url', async () => {
      expect(await run(['start', 'do the thing'])).toBe(0);
      const printed = last();
      expect(printed).toMatchObject({ status: 'queued', created: true });
      expect(printed.url).toBe(`${cockpit.origin}/p/default/tasks/${printed.id as string}`);
      expect(store.getRun(printed.id as string)?.task).toBe('do the thing');
    });

    it('starts a run with the selected discovered skill as its agent step', async () => {
      const dir = join(harness.repoRoot, '.ai/skills');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'cli-sample-skill.md'), '# CLI sample skill\n');
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['start', 'do the thing', '--skill', 'cli-sample-skill'])).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${cockpit.api}/skills?wait=1`, `${cockpit.api}/runs`]);
        expect(last()).not.toHaveProperty('warning');
      } finally { fetchSpy.mockRestore(); }
      const record = store.getRun(last().id as string);
      expect(record?.workflowDef?.steps).toEqual([
        { id: 'task', name: 'cli-sample-skill', skill: 'cli-sample-skill', prompt: '{{task}}' },
      ]);
      expect(record?.task).toBe('do the thing');
    });

    it('retries a skill start with the same request id without creating another run', async () => {
      const dir = join(harness.repoRoot, '.ai/skills');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'cli-sample-skill.md'), '# CLI sample skill\n');
      const args = ['start', 'x', '--skill', 'cli-sample-skill', '--request-id', '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d'];
      expect(await run(args)).toBe(0);
      const first = last();
      expect(await run(args)).toBe(0);
      expect(last()).toMatchObject({ id: first.id, created: false });
      expect(store.listRuns()).toHaveLength(1);
    });

    it('retries an accepted skill start after the skill disappears', async () => {
      const dir = join(harness.repoRoot, '.ai/skills');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'cli-sample-skill.md');
      writeFileSync(path, '# CLI sample skill\n');
      const args = ['start', 'x', '--skill', 'cli-sample-skill', '--request-id', '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d'];
      expect(await run(args)).toBe(0);
      const first = last();
      unlinkSync(path);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(args)).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${cockpit.api}/skills?wait=1`, `${cockpit.api}/runs`]);
      } finally { fetchSpy.mockRestore(); }
      expect(last()).toMatchObject({
        id: first.id, created: false,
        warning: 'skill "cli-sample-skill" is not currently available; the run may use the plain prompt',
      });
      expect(store.listRuns()).toHaveLength(1);
    });

    it('warns on an unknown skill, starts the run, and never downloads run history', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['start', 'x', '--skill', 'not-a-real-cli-skill', '--request-id', '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d'])).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${cockpit.api}/skills?wait=1`, `${cockpit.api}/runs`]);
      } finally { fetchSpy.mockRestore(); }
      expect(last()).toMatchObject({
        created: true,
        warning: 'skill "not-a-real-cli-skill" is not currently available; the run may use the plain prompt',
      });
      expect(store.getRun(last().id as string)?.workflowDef?.steps).toEqual([
        { id: 'task', name: 'not-a-real-cli-skill', skill: 'not-a-real-cli-skill', prompt: '{{task}}' },
      ]);
      expect(store.listRuns()).toHaveLength(1);
    });

    it('warns and still starts when the skill catalog is unavailable', async () => {
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
        String(url) === `${cockpit.api}/skills?wait=1`
          ? Promise.resolve(new Response(JSON.stringify({ error: 'catalog unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }))
          : originalFetch(url, init));
      try {
        expect(await run(['start', 'x', '--skill', 'maybe-there'])).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${cockpit.api}/skills?wait=1`, `${cockpit.api}/runs`]);
      } finally { fetchSpy.mockRestore(); }
      expect(last()).toMatchObject({
        created: true,
        warning: 'could not check whether skill "maybe-there" is available; the run may use the plain prompt',
      });
      expect(store.listRuns()).toHaveLength(1);
    });

    it('warns and still starts when the catalog request fails', async () => {
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
        String(url) === `${cockpit.api}/skills?wait=1`
          ? Promise.reject(new TypeError('catalog offline'))
          : originalFetch(url, init));
      try {
        expect(await run(['start', 'x', '--skill', 'maybe-there'])).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${cockpit.api}/skills?wait=1`, `${cockpit.api}/runs`]);
      } finally { fetchSpy.mockRestore(); }
      expect(last()).toMatchObject({
        created: true,
        warning: 'could not check whether skill "maybe-there" is available; the run may use the plain prompt',
      });
      expect(store.listRuns()).toHaveLength(1);
    });

    it('rejects a changed retry payload even after its skill disappears', async () => {
      const dir = join(harness.repoRoot, '.ai/skills');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'cli-sample-skill.md');
      writeFileSync(path, '# CLI sample skill\n');
      const id = '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d';
      expect(await run(['start', 'x', '--skill', 'cli-sample-skill', '--request-id', id])).toBe(0);
      unlinkSync(path);
      expect(await run(['start', 'different task', '--skill', 'cli-sample-skill', '--request-id', id])).toBe(2);
      expect(last()).toMatchObject({ error: 'request id payload conflict' });
      expect(store.listRuns()).toHaveLength(1);
    });

    it('rejects an empty --skill before discovering a cockpit', async () => {
      expect(await run(['start', 'x', '--skill', '  '])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input' });
      expect(discoveries).toBe(0);
    });

    it('rejects --skill with --workflow before discovering a cockpit', async () => {
      expect(await run(['start', 'x', '--skill', 'cli-sample-skill', '--workflow', 'quick-task'])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input' });
      expect(discoveries).toBe(0);
      expect(store.listRuns()).toHaveLength(0);
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

    it('rejects empty stdin as a usage error even when no cockpit is running', async () => {
      const noCockpit = async () => { throw new TaskCliError(2, { code: 'no-cockpit', error: 'none' }); };
      expect(await runTaskCommand(['start', '--task-file', '-'], {}, { ...io('  '), discover: noCockpit })).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input' });
      expect(await runTaskCommand(['send', 'r1', '--text-file', '-'], {}, { ...io(''), discover: noCockpit })).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input' });
    });

    it('does not opt in on a project without a webhook, and prints notify:false (#589)', async () => {
      const id = await start();
      expect(last().notify).toBe(false);
      expect(store.getRun(id)?.notify).toBeUndefined();
    });

    it('refuses an explicit --notify on a project without a webhook with the hint, exit 2', async () => {
      expect(await run(['start', 'do it', '--notify'])).toBe(2);
      expect(String(last().error)).toContain('no task webhook');
    });

    it('opts in by default when discovery saw a webhook, and --no-notify opts out', async () => {
      await withWebhook();
      const hooked: TaskIo = { ...io(), discover: async () => ({ ...cockpit, hasWebhook: true }) };
      expect(await runTaskCommand(['start', 'do it'], {}, hooked)).toBe(0);
      expect(last().notify).toBe(true);
      expect(store.getRun(last().id as string)?.notify).toBe(true);
      expect(await runTaskCommand(['start', 'do it', '--no-notify'], {}, hooked)).toBe(0);
      expect(last().notify).toBe(false);
    });

    it('rejects --notify with --no-notify before discovering a cockpit', async () => {
      expect(await run(['start', 'do it', '--notify', '--no-notify'])).toBe(64);
      expect(discoveries).toBe(0);
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
        ['id', 'title', 'status', 'attention', 'attentionLabel', 'hasPendingHumanAsk', 'tokensUsed', 'url', 'handoffUrl'].sort(),
      );
      expect(printed).toMatchObject({ id, status: 'queued', hasPendingHumanAsk: false, attention: 'none', attentionLabel: 'queued' });
    });

    // #609: the operator who cleared on `hasPendingHumanAsk: false` read the wrong field. The
    // default projection now carries the cockpit's own answer, and `waiting` is attention with
    // or without a structured question; `running` + `monitoring` is neither settled nor attention.
    it('carries the cockpit attention bucket and label, from the shared function', async () => {
      const id = await start();
      store.updateRun(id, { status: 'waiting', hasPendingHumanAsk: false });
      expect(await run(['status', id])).toBe(0);
      expect(last()).toMatchObject({ status: 'waiting', hasPendingHumanAsk: false, attention: 'waiting', attentionLabel: 'needs you' });
      store.updateRun(id, { status: 'running', activity: 'monitoring' });
      expect(await run(['status', id])).toBe(0);
      expect(last()).toMatchObject({ status: 'running', activity: 'monitoring', attention: 'running', attentionLabel: 'monitoring' });
    });

    it('prints the contract ApiRun with --full, without the derived attention fields', async () => {
      const id = await start();
      expect(await run(['status', '--full', id])).toBe(0);
      expect(apiRunSchema.safeParse(last()).success).toBe(true);
      expect(last()).not.toHaveProperty('attention');
      expect(last()).not.toHaveProperty('attentionLabel');
    });

    it('passes an unknown run id through as the cockpit refusal, exit 2', async () => {
      expect(await run(['status', 'bogus'])).toBe(2);
      expect(last()).toMatchObject({ code: 'refused', status: 404, error: 'not found' });
    });
  });

  describe('list', () => {
    it('lists and waits on a project history larger than the single-response byte cap', async () => {
      // Each task is valid at the API boundary; only the aggregate exceeds 3 MiB.
      const runs = Array.from({ length: 32 }, (_, index) => {
        const run = store.createRun({ title: `task ${index}`, workflow: 'quick-task', task: 'x'.repeat(100_000), steps: [] });
        store.updateRun(run.id, { status: 'done' });
        return run;
      });
      expect(await run(['list', '--limit', '100'])).toBe(0);
      expect(last().runs).toHaveLength(32);
      expect(await run(['wait', runs[0]!.id, '--timeout-seconds', '10'])).toBe(0);
      expect(last()).toMatchObject({ timedOut: false, runs: [{ id: runs[0]!.id, status: 'done' }] });
    });

    it('reads the run summaries, and only --full reads every full record (#817)', async () => {
      await start('a');
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['list'])).toBe(0);
        expect(await run(['list', '--all'])).toBe(0);
        expect(await run(['list', '--full'])).toBe(0);
        // #864: without --all the archived runs are filtered out anyway, so `list` reads the
        // windowed list; --all keeps every row.
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
          `${cockpit.api}/run-summaries?archived=recent`, `${cockpit.api}/run-summaries`, `${cockpit.api}/runs`,
        ]);
      } finally { fetchSpy.mockRestore(); }
    });

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
      expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'title', 'status', 'attention', 'attentionLabel', 'hasPendingHumanAsk', 'updatedAt'].sort());
      expect(rows[0]).toMatchObject({ attention: 'none', attentionLabel: 'done' });
    });

    it('carries attention + attentionLabel on default rows only, never on --full rows (#609)', async () => {
      const a = await start('a');
      const b = await start('b');
      store.updateRun(a, { status: 'waiting', hasPendingHumanAsk: false });
      store.updateRun(b, { status: 'running', activity: 'monitoring' });
      expect(await run(['list'])).toBe(0);
      const rows = last().runs as Array<Record<string, unknown>>;
      expect(rows.find((row) => row.id === a)).toMatchObject({ status: 'waiting', hasPendingHumanAsk: false, attention: 'waiting', attentionLabel: 'needs you' });
      expect(rows.find((row) => row.id === b)).toMatchObject({ status: 'running', activity: 'monitoring', attention: 'running', attentionLabel: 'monitoring' });
      expect(await run(['list', '--full'])).toBe(0);
      for (const row of last().runs as Array<Record<string, unknown>>) {
        expect(apiRunSchema.safeParse(row).success).toBe(true);
        expect(row).not.toHaveProperty('attention');
      }
    });

    it('leaves workers out of the list and its total, with or without --all (#635)', async () => {
      const parent = await start('parent');
      const child = worker(parent);
      for (const argv of [['list'], ['list', '--all'], ['list', '--full']]) {
        expect(await run(argv)).toBe(0);
        expect((last().runs as Array<{ id: string }>).map((row) => row.id)).toEqual([parent]);
        expect(last().total).toBe(1);
      }
      // Still id-addressed: the operator had to get the id from somewhere.
      expect(await run(['status', child])).toBe(0);
      expect(last()).toMatchObject({ id: child });
    });
  });

  describe('default output and help (#572, #573, #574)', () => {
    it.each(runStatusSchema.options)('prints only the next-action datum for %s rows', async (status) => {
      const id = await start();
      store.updateRun(id, {
        status, currentStepId: 'implement', pullRequestUrl: 'https://github.com/example/repo/pull/1',
        error: 'failed step\nstack trace', branch: 'cez/test', diffStat: { adds: 1, dels: 2, files: 1 }, tokensUsed: 123,
      });
      expect(await run(['list'])).toBe(0);
      const datum = status === 'running' ? { currentStepId: 'implement' }
        : status === 'done' || status === 'review' ? { pullRequestUrl: 'https://github.com/example/repo/pull/1' }
          : status === 'failed' ? { error: 'failed step…' } : {};
      const rows = last().runs as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id, title: 'do the thing', status, attention: expect.any(String), attentionLabel: expect.any(String),
        hasPendingHumanAsk: false, updatedAt: expect.any(String), ...datum,
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
      store.updateRun(id, { status: 'failed', error });
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
      store.updateRun(id, { status });
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
        "cez task send <id> 'Use the retry helper instead'",
        "cez task send <id> 'Use option A'",
        "cez task send <id> --resume '…'",
        'delivered', 'queued', 'resumed', 'attention: waiting', 'question',
        'delivery: not-delivered', 'next', '--text-file <path|->', '--text-file -', 'cez task start --help',
      ]) expect(help).toContain(text);
      expect(discoveries).toBe(0);
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
      store.updateRun(finished, { status: 'done' });
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
      expect(last().error).toContain(`cez task notify ${parent}`);
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

  describe('usage', () => {
    it('prints help text without discovering a cockpit', async () => {
      expect(await run(['--help'])).toBe(0);
      expect(out.join('\n')).toContain('cez task start');
      expect(out.at(-1)).toContain('cez task archive <id>');
      expect(out.at(-1)).toContain('cez task unarchive <id>');
      expect(out.at(-1)).toContain('cez task archive-finished');
      expect(await run(['start', '--help'])).toBe(0);
      expect(out.at(-1)).toContain('--request-id');
      expect(out.at(-1)).toMatch(/--workflow[^\n]*\n  --skill /);
      expect(discoveries).toBe(0);
    });

    it.each([[['--help']], [['start', '--help']]])('documents safe task input in %j (#568)', async (argv) => {
      expect(await run(argv)).toBe(0);
      const help = out.at(-1)!;
      expect(help).toMatch(/cez task start --task-file <path\|-> \| '<task>'/);
      expect(help).toContain('cez task start --task-file task.md');
      expect(help).toContain("cez task start --task-file - <<'EOF'");
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
        expect(help).toMatch(/`waiting` is attention even when hasPendingHumanAsk is false/);
        expect(help).toMatch(/never clear a task on hasPendingHumanAsk alone/);
        expect(help).toMatch(/`running` with activity `monitoring` is neither settled nor attention/);
        expect(help).toContain('cez task wait <id>                   # default: stops when the task needs you');
        expect(help).toContain('cez task wait <id> --until settled   # terminal status only');
        expect(help).toContain('cez task start \'…\' --wait --autonomous --until settled');
        expect(discoveries).toBe(0);
      });

    // #931: `log --follow` stops for attention too, so its help carries the same contract.
    it.each([[['--help']], [['log', '--help']]])('documents the log --follow default in %j (#931)', async (argv) => {
      expect(await run(argv)).toBe(0);
      const help = out.at(-1)!;
      expect(help).toContain('cez task log <id> --follow             # default: stops when the task needs you');
      expect(help).toMatch(/--until <attention\|settled>/);
      expect(discoveries).toBe(0);
    });

    it('describes the webhook flags and the notify operation (#589)', async () => {
      expect(await run(['--help'])).toBe(0);
      const all = out.at(-1)!;
      expect(all).toContain('cez task notify <id>');
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
