import { setRunStatus, crashStore } from '../runs/run-store.testkit.ts';
import { runnerHook, run, GIT_ID, waitForProduct, setupMonitoringFixture, FINISHED_RUN_STATUSES } from './run-fixture.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentRunResult, type AgentRunSpec } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { type WorkflowDef } from './types.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

describe('RunManager.continueRun override', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const launches: AgentRunSpec[] = [];

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base');
    await run('git', ['add', 'base.txt'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    launches.length = 0;
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => undefined,
      startSession: spec => {
        launches.push(spec);
        return { result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
          sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => undefined,
          holdsHumanInput: () => false, end: () => undefined, interrupt: () => undefined, open: false };
      },
    };
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    runnerHook.runner = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A finished run with a resumable session on the `claude`/`sonnet` backend. */
  function resumableRun(): string {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      runner: 'claude',
      model: 'sonnet',
      steps: [{ id: 's1', name: 'Work', kind: STEP_KIND.agent }],
    });
    setRunStatus(store, record.id, RUN_STATUS.done, { finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    return record.id;
  }

  it.each([
    ['immediate', 'account-a', 'account-b'],
    ['capacity', 'account-a', 'account-b'],
    ['immediate', 'default', 'account-b'],
    ['capacity', 'account-a', 'default'],
  ])('preserves account switching through %s Continue recovery (%s to %s)', async (mode, before, after) => {
    const id = resumableRun();
    store.updateRun(id, { agentProfile: before });
    store.updateStep(id, 's1', { profileId: before, backend: 'claude' });
    expect(manager.continueRun(id, {
      text: 'read this with the chosen account', agentProfile: after,
      images: [{ type: 'file', mediaType: 'application/pdf', data: 'YQ==' }],
    }, mode === 'capacity')).toEqual({ ok: true });
    // A crash right after the Continue was accepted: nothing still pending is written.
    manager.dispose(); crashStore(store);
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = createFixtureManager(store, repoRoot);
    await manager.recover();
    await waitForProduct(manager, store, () => launches.length === 1);
    expect(launches[0]?.userPrompt).toContain('read this with the chosen account');
    expect(launches[0]?.resume).not.toBe(true);
    expect(store.getRun(id)?.agentProfile).toBe(after);
  });

  it.each([true, false, undefined])('human Continue preserves saved autonomous=%s (#458)', (autonomous) => {
    const id = resumableRun();
    store.updateRun(id, { autonomous });
    expect(manager.continueRun(id, { text: 'Continue setup' })).toEqual({ ok: true });
    expect(store.getRun(id)?.status).toBe('running');
    expect(store.getRun(id)?.autonomous).toBe(autonomous);
    store.flush();
    expect(RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true }).getRun(id)?.autonomous)
      .toBe(autonomous);
  });

  it('persists a runner + model override as the run current backend', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { runner: 'codex', model: 'gpt-5.1-codex' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('codex');
    expect(after?.model).toBe('gpt-5.1-codex');
  });

  it('starts fresh when Continue switches to a backend that does not own the session', async () => {
    const id = resumableRun();


    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    await waitForProduct(manager, store, () => launches.length === 1);
    expect(launches[0]?.resume).not.toBe(true);
    expect(store.getRun(id)?.steps.at(-1)?.backend).toBe('codex');
  });

  it('resumes when Continue stays on the backend that owns the session', async () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude' });


    expect(manager.continueRun(id, { runner: 'claude' })).toEqual({ ok: true });
    await waitForProduct(manager, store, () => launches.length === 1);
    expect(launches[0]).toMatchObject({ resume: true, sessionId: 'sess-1' });
    expect(store.getRun(id)?.steps.at(-1)?.backend).toBe('claude');
  });

  it('an omitted override preserves the run current backend/model (backward compat)', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('claude');
    expect(after?.model).toBe('sonnet');
  });

  it('persists an effort override and keeps it when Continue omits it (#45)', async () => {
    const id = resumableRun();
    store.updateRun(id, { effort: 'medium' });
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBe('medium');
    await waitForProduct(manager, store, () => !manager.isActive(id));
    setRunStatus(store, id, RUN_STATUS.done);

    expect(manager.continueRun(id, { effort: 'xhigh' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBe('xhigh');
  });

  it('an empty effort clears the pin so the harness keeps its default (#45)', () => {
    const id = resumableRun();
    store.updateRun(id, { effort: 'high' });
    expect(manager.continueRun(id, { effort: '' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBeUndefined();
  });

  it('rejects an effort override while modelsLocked (#45)', () => {
    const id = resumableRun();
    writeFileSync(
      join(repoRoot, '.ai', 'cezar', 'config.json'),
      JSON.stringify({ modelsLocked: true }),
      'utf8',
    );
    const result = manager.continueRun(id, { effort: 'max' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/locked/);
    expect(store.getRun(id)?.effort).toBeUndefined();
  });

  it('a runner-only switch keeps the effort pin — it is shared vocabulary, not per-backend (#45)', () => {
    const id = resumableRun();
    store.updateRun(id, { effort: 'max' });
    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBe('max');
  });

  it("an empty model clears the pin so the runner picks the model (auto)", () => {
    const id = resumableRun();
    manager.continueRun(id, { model: '' });
    expect(store.getRun(id)?.model).toBeUndefined();
    // Runner untouched → the run keeps its backend.
    expect(store.getRun(id)?.runner).toBe('claude');
  });

  it("rejects a model that is recognizably another runner's preset (no corruption persisted)", () => {
    const id = resumableRun();
    // The review's corruption case (#401): a codex preset landing on a claude continuation.
    const result = manager.continueRun(id, { model: 'gpt-5.1-codex' });
    expect(result).toEqual({ ok: false, error: "model 'gpt-5.1-codex' is not a claude model" });
    expect(store.getRun(id)?.model).toBe('sonnet');
    expect(store.getRun(id)?.runner).toBe('claude');
  });

  it('a runner-only switch clears the previous backend model pin instead of carrying it over', () => {
    const id = resumableRun(); // claude/sonnet
    // The composer sends only `runner` when the user switches backend without touching the
    // model pill (it displays `auto` at that point). The inherited `sonnet` pin belongs to
    // claude and must not reach the codex runner via `runContinuation`'s `model: record.model`.
    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('codex');
    expect(after?.model).toBeUndefined();
  });

  it('a runner-only switch keeps a free-form model id — only known foreign presets are cleared', () => {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      runner: 'claude',
      model: 'my-org/custom-tune',
      steps: [{ id: 's1', name: 'Work', kind: STEP_KIND.agent }],
    });
    setRunStatus(store, record.id, RUN_STATUS.done, { finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    expect(manager.continueRun(record.id, { runner: 'codex' })).toEqual({ ok: true });
    expect(store.getRun(record.id)?.model).toBe('my-org/custom-tune');
  });

  it('a runner-only continue on the SAME backend keeps the pin (no spurious clear)', () => {
    const id = resumableRun(); // claude/sonnet
    expect(manager.continueRun(id, { runner: 'claude' })).toEqual({ ok: true });
    expect(store.getRun(id)?.model).toBe('sonnet');
  });

  it('guards legacy records too — no persisted runner resolves to claude, like runContinuation', () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 's1', name: 'Work', kind: STEP_KIND.agent }] });
    setRunStatus(store, record.id, RUN_STATUS.done, { finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 's1', { sessionId: 'sess-1' });
    const result = manager.continueRun(record.id, { model: 'gpt-5.1-codex' });
    expect(result.ok).toBe(false);
    expect(store.getRun(record.id)?.model).toBeUndefined();
  });

  it('keeps free-form model ids working — only cross-runner presets are rejected', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { model: 'my-custom-alias' })).toEqual({ ok: true });
    expect(store.getRun(id)?.model).toBe('my-custom-alias');
  });

  /* Agent accounts (spec 2026-07-29-agent-profiles): a follow-up may switch login as well as
     backend — and a session id only resolves inside the config dir that created it. */

  it('persists the picked account as the run current one', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('klaudiusz');
    // Nothing else moves: the account is its own axis.
    expect(store.getRun(id)?.runner).toBe('claude');
    expect(store.getRun(id)?.model).toBe('sonnet');
  });

  it('starts fresh when Continue switches to another login of the same agent', async () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude', profileId: 'default' });


    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    // `claude --resume <id>` under another login would find nothing and silently open a fresh
    // conversation, so the session id is deliberately not passed.
    await waitForProduct(manager, store, () => launches.length === 1);
    expect(launches[0]?.resume).not.toBe(true);
    expect(store.getRun(id)?.steps.at(-1)?.backend).toBe('claude');
  });

  it('resumes when the picked account is the one that owns the session', async () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude', profileId: 'klaudiusz' });


    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    await waitForProduct(manager, store, () => launches.length === 1);
    expect(launches[0]).toMatchObject({ resume: true, sessionId: 'sess-1' });
  });

  it('treats a step that recorded no account as the discovered one', async () => {
    // Pre-accounts sessions ran under whatever `agentHomePaths()` finds, so re-picking `default`
    // is not a switch and must still resume.
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude' });


    expect(manager.continueRun(id, { agentProfile: 'default' })).toEqual({ ok: true });
    await waitForProduct(manager, store, () => launches.length === 1);
    expect(launches[0]).toMatchObject({ resume: true, sessionId: 'sess-1' });
  });

  it('an omitted account preserves the one the run is on (backward compat)', () => {
    const id = resumableRun();
    store.updateRun(id, { agentProfile: 'klaudiusz' });
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('klaudiusz');
  });

  it('a runner switch drops the previous agent account instead of carrying it over', () => {
    // An account belongs to ONE agent: a claude login says nothing about which codex account
    // should run, and leaving it on the record would re-apply it if a later Continue switched back.
    const id = resumableRun();
    store.updateRun(id, { agentProfile: 'klaudiusz' });
    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBeUndefined();
  });

  it('keeps the account when the continuation stays on the same agent', () => {
    const id = resumableRun();
    store.updateRun(id, { agentProfile: 'klaudiusz' });
    expect(manager.continueRun(id, { runner: 'claude' })).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('klaudiusz');
  });

  it('refuses to continue a run with no resumable session (no override persisted)', () => {
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'claude', steps: [] });
    setRunStatus(store, record.id, RUN_STATUS.done);
    const result = manager.continueRun(record.id, { runner: 'codex' });
    expect(result.ok).toBe(false);
    expect(store.getRun(record.id)?.runner).toBe('claude');
  });
});

describe('RunManager idle shutdown', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('honors cancellation that races an idle-close callback', async () => {
    const clock = fixture.observeIdleTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    expect(clock.pending).toBe(1);
    clock.fire(clock.captured - 1);
    expect(fixture.manager.cancel(record.id)).toBe(true);
    await waitFor(record.id, candidate => candidate?.status === 'cancelled');
    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.cancelled });
    expect(fixture.store.getRun(record.id)?.finishedAt).toBeDefined();
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', status: STEP_STATUS.cancelled }),
    ]));
  }, 30_000);

  it('publishes a runner failure that occurs during idle shutdown', async () => {
    const clock = fixture.observeIdleTimers();
    runnerHook.runner = {
      backend: 'claude',
      specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
      interrupt: async () => undefined,
      startSession: (_spec, onEvent) => {
        let rejectResult: (error: Error) => void = () => undefined;
        const result = new Promise<AgentRunResult>((_resolve, reject) => { rejectResult = reject; });
        let open = true;
        queueMicrotask(() => onEvent?.({ type: 'turn-end' }));
        return {
          result,
          sendMessage: () => false,
          sendAgentMessage: () => false,
          discardQueuedMessages: () => undefined, holdsHumanInput: () => false,
          end: () => {
            open = false;
            rejectResult(new Error('provider failed during shutdown'));
          },
          interrupt: () => { open = false; },
          get open() { return open; },
        };
      },
    };
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'wait then fail', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    expect(clock.pending).toBe(1);
    clock.fire(clock.captured - 1);
    await waitFor(record.id, candidate => candidate?.status === 'failed');
    expect(fixture.store.getRun(record.id)).toMatchObject({
      status: RUN_STATUS.failed, error: expect.stringContaining('provider failed during shutdown'),
    });
  }, 30_000);
});

describe('RunManager check retry recovery', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('keeps a check retry budget bounded across a recovered workflow remainder', async () => {
    const workflow: WorkflowDef = {
      name: 'bounded-retry', source: 'file',
      steps: [
        { id: 'task', name: 'Task', prompt: '{{task}}' },
        { id: 'verify', name: 'Verify', command: 'node -e "process.exit(1)"', onFail: { retry: 'task', max: 1 } },
      ],
    };
    const record = fixture.store.createRun({
      title: 'bounded retry', task: 'mock:cezar-done', workflow: workflow.name,
      steps: [
        { id: 'task', name: 'Task', kind: STEP_KIND.agent },
        { id: 'verify', name: 'Verify', kind: STEP_KIND.check },
      ],
    });
    fixture.currentId = record.id;
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done, iterations: 1 });
    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.failed, iterations: 1, retriesUsed: 1 });
    setRunStatus(fixture.store, record.id, RUN_STATUS.queued, { workflowDef: workflow });

    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.pending });
    fixture.store.updateRun(record.id, { workflowDef: workflow, worktree: false });
    await fixture.manager.recover();
    await waitForProduct(fixture.manager, fixture.store, () => !fixture.manager.isActive(record.id) && FINISHED_RUN_STATUSES.has(fixture.store.getRun(record.id)!.status));

    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.failed });
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', status: STEP_STATUS.done, iterations: 1 }),
      expect.objectContaining({ id: 'verify', status: STEP_STATUS.failed, iterations: 2 }),
    ]));
  }, 30_000);

  it('does not spend a check retry merely because another loop executed it before', async () => {
    const workflow: WorkflowDef = {
      name: 'distinct-retry-budget', source: 'file',
      steps: [
        { id: 'task', name: 'Task', prompt: '{{task}}' },
        { id: 'gate', name: 'Gate', command: 'node -e "process.exit(1)"', onFail: { retry: 'task', max: 1 } },
      ],
    };
    const record = fixture.store.createRun({
      title: 'distinct retry', task: 'mock:cezar-done', workflow: workflow.name,
      steps: [
        { id: 'task', name: 'Task', kind: STEP_KIND.agent },
        { id: 'gate', name: 'Gate', kind: STEP_KIND.check },
      ],
    });
    fixture.currentId = record.id;
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done, iterations: 1 });
    fixture.store.updateStep(record.id, 'gate', { status: STEP_STATUS.done, iterations: 1 });
    setRunStatus(fixture.store, record.id, RUN_STATUS.queued, { workflowDef: workflow });

    const flushes: RunRecord[] = [];
    const originalFlush = fixture.store.flush.bind(fixture.store);
    vi.spyOn(fixture.store, 'flush').mockImplementation(() => {
      flushes.push(structuredClone(fixture.store.getRun(record.id)!));
      originalFlush();
    });
    fixture.store.updateStep(record.id, 'gate', { status: STEP_STATUS.pending });
    fixture.store.updateRun(record.id, { workflowDef: workflow, worktree: false });
    await fixture.manager.recover();
    await waitForProduct(fixture.manager, fixture.store, () => !fixture.manager.isActive(record.id) && FINISHED_RUN_STATUSES.has(fixture.store.getRun(record.id)!.status));

    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', iterations: 2 }),
      expect.objectContaining({ id: 'gate', status: STEP_STATUS.failed, iterations: 3, retriesUsed: 1 }),
    ]));
    expect(flushes.some(snapshot =>
      snapshot.status === 'queued' && snapshot.currentStepId === undefined &&
      snapshot.steps.some(step => step.id === 'task' && step.status === 'pending') &&
      snapshot.steps.some(step => step.id === 'gate' && step.status === 'pending' && step.retriesUsed === 1),
    )).toBe(true);
  }, 30_000);

  it('does not treat an unrelated failed check as a continuation workflow source', async () => {
    const clock = fixture.observeIdleTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    expect(clock.pending).toBe(1);
    clock.fire(clock.captured - 1);
    await waitFor(record.id, () => !fixture.manager.isActive(record.id));
    const workflow: WorkflowDef = {
      name: 'failed-check', source: 'file',
      steps: [
        SINGLE_STEP.steps[0]!,
        { id: 'verify', name: 'Verify', command: 'false' },
        { id: 'later', name: 'Later', command: 'true' },
      ],
    };
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done });
    fixture.store.addStep(record.id, { id: 'verify', name: 'Verify', kind: STEP_KIND.check });
    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.failed, iterations: 1 });
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.check });
    setRunStatus(fixture.store, record.id, RUN_STATUS.failed, { currentStepId: undefined, workflowDef: workflow });

    expect(fixture.manager.continueRun(record.id, { text: 'mock:cezar-done inspect failure' })).toEqual({ ok: true });
    await waitFor(record.id, (candidate) => candidate?.status === 'done' || candidate?.status === 'review');
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'verify', status: STEP_STATUS.failed, iterations: 1 }),
      expect.objectContaining({ id: 'later', status: STEP_STATUS.pending, iterations: 0 }),
    ]));
  }, 30_000);

  it('restart reruns an interrupted check instead of completing it as a continuation source', async () => {
    const clock = fixture.observeIdleTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    expect(clock.pending).toBe(1);
    clock.fire(clock.captured - 1);
    await waitFor(record.id, () => !fixture.manager.isActive(record.id));
    fixture.manager.dispose();
    const workflow: WorkflowDef = { name: 'interrupted-check', source: 'file', steps: [
      SINGLE_STEP.steps[0]!,
      { id: 'verify', name: 'Verify', command: 'true' },
      { id: 'later', name: 'Later', command: 'true' },
    ] };
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done });
    fixture.store.addStep(record.id, { id: 'verify', name: 'Verify', kind: STEP_KIND.check });
    fixture.store.updateStep(record.id, 'verify', { status: STEP_STATUS.running, iterations: 1 });
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.check });
    setRunStatus(fixture.store, record.id, RUN_STATUS.running, { currentStepId: 'verify', workflowDef: workflow });
    fixture.store.flush();

    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    await waitFor(record.id, candidate => candidate?.status === 'done' || candidate?.status === 'review');
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'verify', status: STEP_STATUS.done, iterations: 2 }),
      expect.objectContaining({ id: 'later', status: STEP_STATUS.done, iterations: 1 }),
    ]));
  }, 30_000);
});

describe('registry /skill expansion survives a continuation (#811)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  let savedDryRun: string | undefined;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-811-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar/skills'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/cezar/skills/demo-review.md'),
      '---\nname: demo-review\ndescription: Review a diff.\n---\n\nRun the demo review playbook.\n',
    );
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    runId = undefined;
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    if (runId) manager.cancel(runId);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const eventsOf = (id: string) =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string; stepId?: string });

  const waitFor = (predicate: () => boolean, ms = 20_000) => waitForProduct(manager, store, predicate, ms);

  /** A finished run, ready for the cockpit's Reply composer. The dry-run mock ends its
   *  turn with no marker, so the run parks at `waiting` with the session open — closing
   *  it is what a user pressing Finish does, and `continueRun` only accepts a run that
   *  reached a terminal status. */
  const finishedRun = async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true);
    await waitFor(() => ['done', 'review'].includes(store.getRun(record.id)?.status ?? '') && !manager.isActive(record.id));
    return record.id;
  };

  it("expands the continuation's OPENING prompt before it becomes the session userPrompt", async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: '/demo-review look at the diff' })).toEqual({ ok: true });
    await waitFor(() =>
      eventsOf(id).some((e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into')),
    );

    const echoed = eventsOf(id).find(
      (e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into'),
    );
    // The backend saw the expanded skill prompt, NOT a bare slash command it would
    // reject as an unknown skill.
    expect(echoed?.text).toContain('Selected skill: /demo-review');
    expect(echoed?.text).not.toContain('/demo-review look at the diff');

    // Delivery-only: the transcript still shows what the user actually typed.
    const typed = eventsOf(id).find((e) => e.type === 'user-message' && e.stepId === 'continue-1');
    expect(typed?.text).toBe('/demo-review look at the diff');
  }, 40_000);

  it('expands a FOLLOW-UP delivered into the reopened continuation session', async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    await waitFor(() => store.getRun(id)?.status === 'waiting');

    expect(manager.sendMessage(id, [{ type: 'text', text: '/demo-review now review it' }])).toBe(true);
    await waitFor(() =>
      eventsOf(id).filter((e) => e.type === 'text' && e.text?.includes('Selected skill: /demo-review')).length > 0,
    );
    expect(
      eventsOf(id).some((e) => e.type === 'text' && e.text?.includes('Selected skill: /demo-review')),
    ).toBe(true);
  }, 40_000);

  it('leaves an unknown slash command untouched so backend-native commands still work', async () => {
    const id = await finishedRun();
    expect(manager.continueRun(id, { text: '/compact please' })).toEqual({ ok: true });
    await waitFor(() =>
      eventsOf(id).some((e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into')),
    );
    const echoed = eventsOf(id).find(
      (e) => e.stepId === 'continue-1' && e.type === 'text' && e.text?.includes('looking into'),
    );
    expect(echoed?.text).toContain('/compact please');
  }, 40_000);
});

describe("registry /skill expansion on a fresh run's opening prompt (#87)", () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  let savedDryRun: string | undefined;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-87-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar/skills'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/cezar/skills/demo-review.md'),
      '---\nname: demo-review\ndescription: Review a diff.\n---\n\nRun the demo review playbook.\n',
    );
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    runId = undefined;
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    if (runId) manager.cancel(runId);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Tolerant of the pre-first-event window: the run's ndjson does not exist until
  // the engine writes its first event, and this describe polls events directly
  // (no store-status gate first), so a missing file is simply "no events yet".
  const eventsOf = (id: string) => {
    let raw: string;
    try {
      raw = readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8').trim();
    } catch {
      return [] as { type: string; text?: string; stepId?: string }[];
    }
    if (!raw) return [] as { type: string; text?: string; stepId?: string }[];
    return raw.split('\n').map((line) => JSON.parse(line) as { type: string; text?: string; stepId?: string });
  };

  const waitFor = (predicate: () => boolean, ms = 20_000) => waitForProduct(manager, store, predicate, ms);

  it('expands the opening prompt before it reaches the backend', async () => {
    const record = manager.startRun(SINGLE_STEP, {
      task: '/demo-review look at the diff',
      worktree: false,
    });
    runId = record.id;
    await waitFor(() =>
      eventsOf(record.id).some(
        (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
      ),
    );

    const echoed = eventsOf(record.id).find(
      (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
    );
    // The backend saw the expanded skill prompt, NOT the bare slash command it would
    // reject as an unknown command.
    expect(echoed?.text).toContain('Selected skill: /demo-review');
    expect(echoed?.text).not.toContain('/demo-review look at the diff');
    expect(store.getRun(record.id)?.task).toBe('/demo-review look at the diff');
  }, 40_000);

  it.each([
    { task: '/compact please', registry: true },
    { task: '/demo-review look at the diff', registry: false },
  ])('passes through $task with registry=$registry', async ({ task, registry }) => {
    if (!registry) rmSync(join(repoRoot, '.ai/cezar/skills'), { recursive: true });
    const record = manager.startRun(SINGLE_STEP, { task, worktree: false });
    runId = record.id;
    await waitFor(() =>
      eventsOf(record.id).some(
        (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
      ),
    );
    const echoed = eventsOf(record.id).find(
      (e) => e.stepId === 'task' && e.type === 'text' && e.text?.includes('looking into'),
    );
    expect(echoed?.text).toBe(`Okay — looking into: ${task}`);
    expect(store.getRun(record.id)?.task).toBe(task);
  }, 40_000);
});
