import { productIdentity } from '../home/identity.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { apiRunSchema } from '@open-mercato/cezar-contract/runs';
import { describe, expect, it, vi } from 'vitest';
import { runTaskCommand, taskHelp, type TaskIo } from './cli.ts';
import { discoverCockpit } from './discovery.ts';
import { TaskCliError } from './http.ts';
import { registerProject } from '../workspace/projects.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { useTaskCliFixture, harness, store, cockpit, out, discoveries, io, run, withWebhook, last, start, worker } from './cli.testkit.ts';

/** The agent's open timer: the monitoring park since hearsay-tools/cezarion#1301. */
const openTimer = () => ({
  kind: WAIT_KIND.timer, id: randomUUID(), source: WAIT_SOURCE.agent, via: WAIT_VIA['monitoring-line'],
  registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 600_000).toISOString(), phase: WAIT_PHASE.open, turnId: 'turn-1', seconds: 600,
});

describe('cez task', () => {
  useTaskCliFixture();

  describe('shared flag positions (hearsay-tools/cezarion#554)', () => {
    const cases = ['list', 'status', 'stop'].flatMap((operation) =>
      ['url', 'repo'].flatMap((flag) => ['before', 'after'].flatMap((position) =>
        ['space', 'equals'].map((form) => ({ operation, flag, position, form })),
      )),
    );
    it.each(cases)('$operation with --$flag $position ($form) resolves and requests the same cockpit', async ({ operation, flag, position, form }) => {
      const project = await registerProject(harness.repoRoot, undefined, testHome());
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
        else if (operation === 'status') expect(last()).toMatchObject({ id, status: RUN_STATUS.queued });
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
        usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: ("cez task list").replace("cez", productIdentity().command) }]) },
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
      expect(last()).toMatchObject({ code: 'invalid_input', error: expect.stringContaining('duplicate option'), usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: ("cez task list").replace("cez", productIdentity().command) }]) } });
      expect(discoveries).toBe(0);
    });

    it.each(['url', 'repo'].flatMap((flag) => [
      [`--${flag}`], [`--${flag}`, '--help', 'list'], [`--${flag}=--help`, 'list'],
      [`--${flag}`, '', 'list'], [`--${flag}=`, 'list'],
    ]).map((argv) => ({ argv })))('rejects missing or option-shaped leading values in $argv', async ({ argv }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: expect.stringContaining('requires a value'), usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: ("cez task list").replace("cez", productIdentity().command) }]) } });
      expect(discoveries).toBe(0);
    });

    it.each([['--url', 'http://127.0.0.1:1'], ['--repo=checkout']].map((argv) => ({ argv })))('reports missing operation after $argv', async ({ argv }) => {
      expect(await run(argv)).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input', error: 'missing operation', usage: { operations: expect.arrayContaining([{ name: 'list', synopsis: ("cez task list").replace("cez", productIdentity().command) }]) } });
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
      expect(printed).toMatchObject({ status: RUN_STATUS.queued, created: true });
      expect(printed.url).toBe(`${cockpit.origin}/p/default/tasks/${printed.id as string}`);
      expect(store.getRun(printed.id as string)?.task).toBe('do the thing');
      expect(store.getRun(printed.id as string)?.archiveWhenDone).not.toBe(true);
      expect(store.getRun(printed.id as string)?.autoMergePr).not.toBe(true);
    });

    it.each([
      ['--archive-when-done', { archiveWhenDone: true }],
      ['--auto-merge-pr', { autoMergePr: true }],
    ] as const)('saves %s without enabling the other completion control', async (flag, expected) => {
      expect(await run(['start', 'complete this task', flag])).toBe(0);
      const record = store.getRun(last().id as string)!;
      expect(record).toMatchObject(expected);
      expect(record[flag === '--archive-when-done' ? 'autoMergePr' : 'archiveWhenDone']).not.toBe(true);
    });

    // hearsay-tools/cezarion#2784: both task access switches default on; each --no-* flag turns one off.
    it.each([
      [[], { allowWorkers: true, allowMessaging: true }],
      [['--no-workers'], { allowWorkers: false, allowMessaging: true }],
      [['--no-messaging'], { allowWorkers: true, allowMessaging: false }],
      [['--no-workers', '--no-messaging'], { allowWorkers: false, allowMessaging: false }],
    ] as const)('saves task access from %j', async (flags, expected) => {
      expect(await run(['start', 'access this task', ...flags])).toBe(0);
      expect(store.getRun(last().id as string)).toMatchObject(expected);
    });

    it.each(['positional', 'file', 'stdin', 'workflow', 'skill'] as const)('preserves %s task input with both completion controls', async (source) => {
      const text = 'multi\nline "quoted" `code` $HOME';
      const taskPath = join(harness.repoRoot, 'task.md');
      writeFileSync(taskPath, text);
      const input = source === 'file' ? ['--task-file', taskPath]
        : source === 'stdin' ? ['--task-file', '-'] : [text];
      const execution = source === 'workflow' ? ['--workflow', 'quick-task']
        : source === 'skill' ? ['--skill', 'completion-skill'] : [];
      expect(await run(['start', ...input, ...execution, '--archive-when-done', '--auto-merge-pr'], text)).toBe(0);
      const record = store.getRun(last().id as string)!;
      expect(record).toMatchObject({ task: text, archiveWhenDone: true, autoMergePr: true });
      if (source === 'skill') expect(record.workflowDef?.steps).toEqual([
        { id: 'task', name: 'completion-skill', skill: 'completion-skill', prompt: '{{task}}' },
      ]);
      else expect(record.workflow).toBe('quick-task');
    });

    it('retries starts with completion controls and rejects changed controls', async () => {
      const id = randomUUID();
      const args = ['start', 'x', '--request-id', id, '--archive-when-done', '--auto-merge-pr'];
      expect(await run(args)).toBe(0);
      const first = last();
      expect(await run(args)).toBe(0);
      expect(last()).toMatchObject({ id: first.id, created: false });
      for (const flag of ['--archive-when-done', '--auto-merge-pr']) {
        expect(await run(args.filter((arg) => arg !== flag))).toBe(2);
        expect(last()).toMatchObject({ error: 'request id payload conflict' });
      }
      expect(store.listRuns()).toHaveLength(1);
      expect(store.getRun(first.id as string)).toMatchObject({ archiveWhenDone: true, autoMergePr: true });
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

    describe('runner flag (hearsay-tools/cezarion#632)', () => {
      const cases = RUNNER_IDS.flatMap((runner) => [
        { runner, flags: ['--runner', runner] },
        { runner, flags: ['--backend', runner] },
        { runner, flags: ['--runner', runner, '--backend', runner] },
      ]);
      it.each(cases)('$flags sends runner $runner on the run API', async ({ runner, flags }) => {
        expect(await run(['start', ...flags, 'x'])).toBe(0);
        expect(store.getRun(last().id as string)?.runner).toBe(runner);
      });

      it('rejects conflicting --runner and --backend before discovering a cockpit', async () => {
        expect(await run(['start', '--runner', 'codex', '--backend', 'claude', 'x'])).toBe(64);
        expect(last()).toMatchObject({
          code: 'invalid_input',
          error: '--runner codex and --backend claude name different runners; pass one --runner',
        });
        expect(discoveries).toBe(0);
        expect(store.listRuns()).toHaveLength(0);
      });

      it('shows --runner first and --backend as a one-line alias in start help', () => {
        const lines = taskHelp('start').split('\n');
        const runnerLine = lines.findIndex((line) => line.startsWith('  --runner '));
        const backendLines = lines.flatMap((line, index) => (line.includes('--backend') ? [index] : []));
        expect(runnerLine).toBeGreaterThan(-1);
        expect(backendLines).toEqual([runnerLine + 1]);
        expect(lines[runnerLine + 1]).toMatch(/^ {2}--backend .*Alias of --runner\.$/);
      });
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
        ['id', 'title', 'status', 'attention', 'attentionLabel', 'tokensUsed', 'url', 'handoffUrl'].sort(),
      );
      expect(printed).toMatchObject({ id, status: RUN_STATUS.queued, attention: 'none', attentionLabel: 'queued' });
    });

    // #609: the operator who cleared on a false pending-question flag read the wrong field. The
    // default projection now carries the cockpit's own answer, and `waiting` is attention with
    // or without a structured question; a run waiting on its own timer is neither settled nor
    // attention (the monitoring park is a timer wait since hearsay-tools/cezarion#1301).
    it('carries the cockpit attention bucket and label, from the shared function', async () => {
      const id = await start();
      setRunStatus(store, id, RUN_STATUS.waiting);
      expect(await run(['status', id])).toBe(0);
      expect(last()).toMatchObject({ status: RUN_STATUS.waiting, attention: 'waiting', attentionLabel: 'needs you' });
      store.commitWait(id, openTimer());
      expect(await run(['status', id])).toBe(0);
      expect(last()).toMatchObject({ status: RUN_STATUS.waiting, attention: 'running', attentionLabel: 'monitoring' });
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
        setRunStatus(store, run.id, RUN_STATUS.done);
        return run;
      });
      expect(await run(['list', '--limit', '100'])).toBe(0);
      expect(last().runs).toHaveLength(32);
      expect(await run(['wait', runs[0]!.id, '--timeout-seconds', '10'])).toBe(0);
      expect(last()).toMatchObject({ timedOut: false, runs: [{ id: runs[0]!.id, status: RUN_STATUS.done }] });
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
      setRunStatus(store, b, RUN_STATUS.done);
      expect(await run(['list', '--status', 'done'])).toBe(0);
      const rows = last().runs as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.id)).toEqual([b]);
      expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'title', 'status', 'attention', 'attentionLabel', 'updatedAt'].sort());
      expect(rows[0]).toMatchObject({ attention: 'none', attentionLabel: 'done' });
    });

    it('carries attention + attentionLabel on default rows only, never on --full rows (#609)', async () => {
      const a = await start('a');
      const b = await start('b');
      setRunStatus(store, a, RUN_STATUS.waiting);
      setRunStatus(store, b, RUN_STATUS.waiting);
      store.commitWait(b, openTimer());
      expect(await run(['list'])).toBe(0);
      const rows = last().runs as Array<Record<string, unknown>>;
      expect(rows.find((row) => row.id === a)).toMatchObject({ status: RUN_STATUS.waiting, attention: 'waiting', attentionLabel: 'needs you' });
      expect(rows.find((row) => row.id === b)).toMatchObject({ status: RUN_STATUS.waiting, attention: 'running', attentionLabel: 'monitoring' });
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
});
