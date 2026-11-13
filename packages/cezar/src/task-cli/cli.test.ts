import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it, vi } from 'vitest';
import { runTaskCommand, taskHelp } from './cli.ts';
import { TaskCliError } from './http.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { taskCliFixture } from './cli.testkit.ts';

describe('cez task', () => {
  const ctx = taskCliFixture();
  const { io, run, last, start, withWebhook } = ctx;

  describe('start', () => {
    it('creates a queued run in the cockpit and prints its thread url', async () => {
      expect(await run(['start', 'do the thing'])).toBe(0);
      const printed = last();
      expect(printed).toMatchObject({ status: RUN_STATUS.queued, created: true });
      expect(printed.url).toBe(`${ctx.cockpit.origin}/p/default/tasks/${printed.id as string}`);
      expect(ctx.store.getRun(printed.id as string)?.task).toBe('do the thing');
      expect(ctx.store.getRun(printed.id as string)?.archiveWhenDone).not.toBe(true);
      expect(ctx.store.getRun(printed.id as string)?.autoMergePr).not.toBe(true);
    });

    it.each([
      ['--archive-when-done', { archiveWhenDone: true }],
      ['--auto-merge-pr', { autoMergePr: true }],
    ] as const)('saves %s without enabling the other completion control', async (flag, expected) => {
      expect(await run(['start', 'complete this task', flag])).toBe(0);
      const record = ctx.store.getRun(last().id as string)!;
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
      expect(ctx.store.getRun(last().id as string)).toMatchObject(expected);
    });

    it.each(['positional', 'file', 'stdin', 'workflow', 'skill'] as const)('preserves %s task input with both completion controls', async (source) => {
      const text = 'multi\nline "quoted" `code` $HOME';
      const taskPath = join(ctx.harness.repoRoot, 'task.md');
      writeFileSync(taskPath, text);
      const input = source === 'file' ? ['--task-file', taskPath]
        : source === 'stdin' ? ['--task-file', '-'] : [text];
      const execution = source === 'workflow' ? ['--workflow', 'quick-task']
        : source === 'skill' ? ['--skill', 'completion-skill'] : [];
      expect(await run(['start', ...input, ...execution, '--archive-when-done', '--auto-merge-pr'], text)).toBe(0);
      const record = ctx.store.getRun(last().id as string)!;
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
      expect(ctx.store.listRuns()).toHaveLength(1);
      expect(ctx.store.getRun(first.id as string)).toMatchObject({ archiveWhenDone: true, autoMergePr: true });
    });

    it('starts a run with the selected discovered skill as its agent step', async () => {
      const dir = join(ctx.harness.repoRoot, '.ai/skills');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'cli-sample-skill.md'), '# CLI sample skill\n');
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['start', 'do the thing', '--skill', 'cli-sample-skill'])).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${ctx.cockpit.api}/skills?wait=1`, `${ctx.cockpit.api}/runs`]);
        expect(last()).not.toHaveProperty('warning');
      } finally { fetchSpy.mockRestore(); }
      const record = ctx.store.getRun(last().id as string);
      expect(record?.workflowDef?.steps).toEqual([
        { id: 'task', name: 'cli-sample-skill', skill: 'cli-sample-skill', prompt: '{{task}}' },
      ]);
      expect(record?.task).toBe('do the thing');
    });

    it('retries a skill start with the same request id without creating another run', async () => {
      const dir = join(ctx.harness.repoRoot, '.ai/skills');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'cli-sample-skill.md'), '# CLI sample skill\n');
      const args = ['start', 'x', '--skill', 'cli-sample-skill', '--request-id', '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d'];
      expect(await run(args)).toBe(0);
      const first = last();
      expect(await run(args)).toBe(0);
      expect(last()).toMatchObject({ id: first.id, created: false });
      expect(ctx.store.listRuns()).toHaveLength(1);
    });

    it('retries an accepted skill start after the skill disappears', async () => {
      const dir = join(ctx.harness.repoRoot, '.ai/skills');
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
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${ctx.cockpit.api}/skills?wait=1`, `${ctx.cockpit.api}/runs`]);
      } finally { fetchSpy.mockRestore(); }
      expect(last()).toMatchObject({
        id: first.id, created: false,
        warning: 'skill "cli-sample-skill" is not currently available; the run may use the plain prompt',
      });
      expect(ctx.store.listRuns()).toHaveLength(1);
    });

    it('warns on an unknown skill, starts the run, and never downloads run history', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(await run(['start', 'x', '--skill', 'not-a-real-cli-skill', '--request-id', '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d'])).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${ctx.cockpit.api}/skills?wait=1`, `${ctx.cockpit.api}/runs`]);
      } finally { fetchSpy.mockRestore(); }
      expect(last()).toMatchObject({
        created: true,
        warning: 'skill "not-a-real-cli-skill" is not currently available; the run may use the plain prompt',
      });
      expect(ctx.store.getRun(last().id as string)?.workflowDef?.steps).toEqual([
        { id: 'task', name: 'not-a-real-cli-skill', skill: 'not-a-real-cli-skill', prompt: '{{task}}' },
      ]);
      expect(ctx.store.listRuns()).toHaveLength(1);
    });

    it('warns and still starts when the skill catalog is unavailable', async () => {
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
        String(url) === `${ctx.cockpit.api}/skills?wait=1`
          ? Promise.resolve(new Response(JSON.stringify({ error: 'catalog unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }))
          : originalFetch(url, init));
      try {
        expect(await run(['start', 'x', '--skill', 'maybe-there'])).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${ctx.cockpit.api}/skills?wait=1`, `${ctx.cockpit.api}/runs`]);
      } finally { fetchSpy.mockRestore(); }
      expect(last()).toMatchObject({
        created: true,
        warning: 'could not check whether skill "maybe-there" is available; the run may use the plain prompt',
      });
      expect(ctx.store.listRuns()).toHaveLength(1);
    });

    it('warns and still starts when the catalog request fails', async () => {
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
        String(url) === `${ctx.cockpit.api}/skills?wait=1`
          ? Promise.reject(new TypeError('catalog offline'))
          : originalFetch(url, init));
      try {
        expect(await run(['start', 'x', '--skill', 'maybe-there'])).toBe(0);
        expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${ctx.cockpit.api}/skills?wait=1`, `${ctx.cockpit.api}/runs`]);
      } finally { fetchSpy.mockRestore(); }
      expect(last()).toMatchObject({
        created: true,
        warning: 'could not check whether skill "maybe-there" is available; the run may use the plain prompt',
      });
      expect(ctx.store.listRuns()).toHaveLength(1);
    });

    it('rejects a changed retry payload even after its skill disappears', async () => {
      const dir = join(ctx.harness.repoRoot, '.ai/skills');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'cli-sample-skill.md');
      writeFileSync(path, '# CLI sample skill\n');
      const id = '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d';
      expect(await run(['start', 'x', '--skill', 'cli-sample-skill', '--request-id', id])).toBe(0);
      unlinkSync(path);
      expect(await run(['start', 'different task', '--skill', 'cli-sample-skill', '--request-id', id])).toBe(2);
      expect(last()).toMatchObject({ error: 'request id payload conflict' });
      expect(ctx.store.listRuns()).toHaveLength(1);
    });

    it('rejects an empty --skill before discovering a cockpit', async () => {
      expect(await run(['start', 'x', '--skill', '  '])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input' });
      expect(ctx.discoveries).toBe(0);
    });

    it('rejects --skill with --workflow before discovering a cockpit', async () => {
      expect(await run(['start', 'x', '--skill', 'cli-sample-skill', '--workflow', 'quick-task'])).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input' });
      expect(ctx.discoveries).toBe(0);
      expect(ctx.store.listRuns()).toHaveLength(0);
    });

    it('reports created:false for a retry with the same request id', async () => {
      const id = '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d';
      expect(await run(['start', '--request-id', id, 'x'])).toBe(0);
      const first = last();
      expect(await run(['start', '--request-id', id, 'x'])).toBe(0);
      expect(last()).toMatchObject({ id: first.id, created: false });
      expect(ctx.store.listRuns()).toHaveLength(1);
    });

    it('passes a request-id payload conflict through with exit 2 and starts nothing', async () => {
      const id = '2b7e1c9a-5d4f-4a3b-8c2d-1e0f9a8b7c6d';
      await run(['start', '--request-id', id, 'x']);
      expect(await run(['start', '--request-id', id, 'y'])).toBe(2);
      expect(last()).toMatchObject({ error: 'request id payload conflict' });
      expect(ctx.store.listRuns()).toHaveLength(1);
    });

    it('reads the task from stdin with --task-file -', async () => {
      const text = 'multi\nline "quoted" `code` $HOME';
      expect(await run(['start', '--task-file', '-'], text)).toBe(0);
      expect(ctx.store.getRun(last().id as string)?.task).toBe(text);
    });

    it('treats empty stdin as a usage error and starts nothing', async () => {
      expect(await run(['start', '--task-file', '-'], '  \n')).toBe(64);
      expect(last()).toMatchObject({ code: 'invalid_input' });
      expect(ctx.store.listRuns()).toHaveLength(0);
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
      expect(ctx.store.getRun(id)?.notify).toBeUndefined();
    });

    it('refuses an explicit --notify on a project without a webhook with the hint, exit 2', async () => {
      expect(await run(['start', 'do it', '--notify'])).toBe(2);
      expect(String(last().error)).toContain('no task webhook');
    });

    it('does not opt in by default on a project with a webhook; only --notify opts in', async () => {
      await withWebhook();
      expect(await run(['start', 'do it'])).toBe(0);
      expect(last().notify).toBe(false);
      expect(ctx.store.getRun(last().id as string)?.notify).toBeUndefined();
      expect(await run(['start', 'do it', '--notify'])).toBe(0);
      expect(last().notify).toBe(true);
      expect(ctx.store.getRun(last().id as string)?.notify).toBe(true);
      expect(await run(['start', 'do it', '--no-notify'])).toBe(0);
      expect(last().notify).toBe(false);
      expect(ctx.store.getRun(last().id as string)?.notify).toBeUndefined();
    });

    it('rejects --notify with --no-notify before discovering a cockpit', async () => {
      expect(await run(['start', 'do it', '--notify', '--no-notify'])).toBe(64);
      expect(ctx.discoveries).toBe(0);
    });

    describe('runner flag (hearsay-tools/cezarion#632)', () => {
      const cases = RUNNER_IDS.flatMap((runner) => [
        { runner, flags: ['--runner', runner] },
        { runner, flags: ['--backend', runner] },
        { runner, flags: ['--runner', runner, '--backend', runner] },
      ]);
      it.each(cases)('$flags sends runner $runner on the run API', async ({ runner, flags }) => {
        expect(await run(['start', ...flags, 'x'])).toBe(0);
        expect(ctx.store.getRun(last().id as string)?.runner).toBe(runner);
      });

      it('rejects conflicting --runner and --backend before discovering a cockpit', async () => {
        expect(await run(['start', '--runner', 'codex', '--backend', 'claude', 'x'])).toBe(64);
        expect(last()).toMatchObject({
          code: 'invalid_input',
          error: '--runner codex and --backend claude name different runners; pass one --runner',
        });
        expect(ctx.discoveries).toBe(0);
        expect(ctx.store.listRuns()).toHaveLength(0);
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
      const record = ctx.store.getRun(last().id as string);
      expect(record?.worktree).toBe(false);
      expect(record?.autonomous).toBe(true);
    });
  });
});
