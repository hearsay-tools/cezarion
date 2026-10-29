import { runInternals } from './run-internals.testkit.ts';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { ciNativeMessages } from './waits-parity.testkit.ts';
import { manager, restart, root, semaphore, store, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

// hearsay-tools/cezarion#1380: losing the saved cause before Continue, or preferring a
// saved message over the restart explanation, must fail on every native input wire.
function native(runner: RunnerId) {
  const adapter = HARNESS_ADAPTERS[runner];
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv(adapter.binEnv, adapter.mockBin);
  vi.stubEnv('CEZ_MOCK_ARGS_FILE', join(root, 'args'));
  vi.stubEnv('CEZ_MOCK_STDIN_FILE', join(root, 'stdin'));
  return () => ciNativeMessages(runner, root).map(text => {
    // In-thread runners prepend their system instructions to the native input.
    const separator = '\n\n---\n\n';
    const at = text.lastIndexOf(separator);
    return at < 0 ? text : text.slice(at + separator.length);
  });
}

async function start(runner: RunnerId, scenario: 'provider-error' | 'done') {
  const run = manager.startRun(QUICK_TASK_WORKFLOW, {
    task: HARNESS_ADAPTERS[runner].scenarios[scenario]!, runner, worktree: false,
  });
  await until(() => ['failed', 'done', 'review'].includes(store.getRun(run.id)?.status ?? '') && !manager.isActive(run.id));
  return run.id;
}

describe('resume diagnostics through every native wire (hearsay-tools/cezarion#1380)', () => {
  useWorkerWaitFixture();
  afterEach(() => vi.unstubAllEnvs());

  for (const runner of RUNNER_IDS) {
    it(`${runner} R85 checkpoints and delivers the failed step and continuation causes before Continue text`, async () => {
      const messages = native(runner);
      const id = await start(runner, 'provider-error');
      for (const text of [`${HARNESS_ADAPTERS[runner].scenarios['provider-error']}\nKeep this second line.`, '']) {
        const failed = store.getRun(id)!.steps.at(-1)!;
        expect(failed.status).toBe('failed');
        expect(failed.error).toBeTruthy();
        const before = messages().length;
        expect(manager.continueRun(id, { text })).toEqual({ ok: true });
        // Read the committed row before async startup: error clearing must not lose the cause.
        const disk = readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!;
        expect(disk.error).toBeUndefined();
        expect(disk.continuationMessage).toMatchObject({
          text: text || 'Continue.',
          resumeContext: { failure: { stepId: failed.id, error: failed.error } },
        });
        await until(() => messages().length > before);
        const prompt = messages()[before]!;
        const [line, ...body] = prompt.split('\n');
        expect(line).toContain('failed');
        expect(line).toContain(failed.id);
        expect(line).toContain(failed.error);
        expect(line).toContain('verify their state before restarting');
        expect(body.join('\n')).toBe(text || 'Continue.');
        if (text) await until(() => store.getRun(id)?.status === 'failed' && !manager.isActive(id));
      }
    }, 60_000);

    it(`${runner} R87 leaves a non-error Continue unchanged`, async () => {
      const messages = native(runner);
      const id = await start(runner, 'done');
      const before = messages().length;
      const text = 'Keep working.\nKeep this second line.';
      expect(manager.continueRun(id, { text })).toEqual({ ok: true });
      await until(() => messages().length > before);
      expect(messages()[before]).toBe(text);
    }, 30_000);

    it(`${runner} R88 keeps the accepted failure cause and attachment through a restart`, async () => {
      const messages = native(runner);
      const id = await start(runner, 'provider-error');
      const failed = structuredClone(store.getRun(id)!.steps.at(-1)!);
      const text = 'Review the attached brief.';
      const held = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
      expect(manager.continueRun(id, {
        text, images: [{ type: 'file', mediaType: 'application/pdf', data: Buffer.from('brief-1380').toString('base64') }],
      }, true)).toEqual({ ok: true });
      const accepted = readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!;
      expect(accepted.continuationMessage.images).toHaveLength(1);
      const url = accepted.continuationMessage.images[0] as string;
      const path = join(root, '.ai/cezar/runs', `${id}-images`, url.split('/').at(-1)!);
      const before = messages().length;
      await restart();
      const recovered = readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!;
      expect(recovered.continuationMessage).toMatchObject({ text, images: [url], resumeContext: {
        failure: { stepId: failed.id, error: failed.error }, restarted: true,
      } });
      held.mockRestore();
      await (runInternals(manager).line).pump();
      await until(() => messages().length > before);
      const prompt = messages()[before]!;
      expect(prompt.split('\n')[0]).toContain(failed.error);
      expect(prompt.split('\n')[0]).toContain('cezar process restarted');
      expect(prompt).toContain(`\n${text}`);
      expect(prompt).toContain(path);
      expect(readFileSync(path, 'utf8')).toBe('brief-1380');
    }, 60_000);

    it(`${runner} R89 keeps multiline errors on one line without hiding a slash skill or changing human history`, async () => {
      const messages = native(runner);
      const skills = join(root, '.ai/cezar/skills');
      mkdirSync(skills, { recursive: true });
      writeFileSync(join(skills, 'resume-check.md'), '---\nname: resume-check\ndescription: Resume check\n---\nRESUME-SKILL-1380\n');
      const id = await start(runner, 'provider-error');
      const error = 'Provider unavailable\nTry later\r\nNo retry was made.';
      store.updateStep(id, 'task', { error });
      const before = messages().length;
      expect(manager.continueRun(id, { text: '/resume-check' })).toEqual({ ok: true });
      await until(() => messages().length > before);
      const prompt = messages()[before]!;
      expect(prompt.split('\n')[0]).toContain('Provider unavailable Try later No retry was made.');
      expect(prompt).toContain('RESUME-SKILL-1380');
      expect(store.readEvents(id).filter(event => event.type === 'user-message').at(-1)?.text).toBe('/resume-check');
    }, 30_000);

    it(`${runner} R90 explains repeated recovery once when the interrupted task had no saved message`, async () => {
      const messages = native(runner);
      const id = await start(runner, 'done');
      store.updateStep(id, 'task', { status: 'running', finishedAt: undefined });
      store.updateRun(id, { status: 'running', currentStepId: 'task', finishedAt: undefined, continuationMessage: undefined });
      const before = messages().length;
      const held = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
      await restart();
      const checkpoint = readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!;
      expect(checkpoint.continuationMessage).toMatchObject({ text: 'Continue.', origin: 'lifecycle', resumeContext: { restarted: true } });
      await restart();
      held.mockRestore();
      await (runInternals(manager).line).pump();
      await until(() => messages().length > before);
      const prompt = messages()[before]!;
      expect(prompt.match(/cezar process restarted/g)).toHaveLength(1);
      expect(prompt.split('\n')[0]).toContain('verify their state before restarting');
    }, 60_000);

    it(`${runner} R91 preserves human text that equals the legacy restart fallback`, async () => {
      const messages = native(runner);
      const id = await start(runner, 'done');
      const text = 'The cezar process restarted while you were working on this task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';
      const before = messages().length;
      expect(manager.continueRun(id, { text })).toEqual({ ok: true });
      await until(() => messages().length > before);
      expect(messages()[before]).toBe(text);
    }, 30_000);

    for (const status of ['running', 'queued'] as const) {
      it(`${runner} R86 explains restart ahead of a saved ${status} continuation, without a live session`, async () => {
        const messages = native(runner);
        const id = await start(runner, 'done');
        const original = store.getRun(id)!.steps[0]!;
        const text = 'Saved human text.\nDo not change it.';
        store.addStep(id, { id: 'continue-1', name: 'Continue', kind: 'agent', synthetic: 'continuation' });
        store.updateStep(id, 'continue-1', { status: status === 'queued' ? 'pending' : 'running' });
        store.updateRun(id, {
          status, currentStepId: status === 'running' ? 'continue-1' : undefined,
          finishedAt: undefined, error: undefined,
          continuationMessage: { id: 'continue-1', text, createdAt: new Date().toISOString(), origin: 'human' },
        });
        expect(original.sessionId).toBeTruthy();
        const before = messages().length;
        // Two cold recoveries before admission must keep the original body and one context.
        const held = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
        await restart();
        await restart();
        const disk = readPersistedRuns(join(root, '.ai/cezar')).find(run => run.id === id)!;
        expect(disk.continuationMessage).toMatchObject({ text, resumeContext: { restarted: true } });
        held.mockRestore();
        await (runInternals(manager).line).pump();
        await until(() => messages().length > before);
        const prompt = messages()[before]!;
        expect(prompt.split('\n')[0]).toContain('cezar process restarted');
        expect(prompt.match(/cezar process restarted/g)).toHaveLength(1);
        expect(prompt).toContain(`\n${text}`);
      }, 60_000);
    }
  }
});
