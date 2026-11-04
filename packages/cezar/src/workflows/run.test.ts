import { crashStore } from '../runs/run-store.testkit.ts';
import { runnerHook, run, GIT_ID, waitForProduct } from './run-fixture.testkit.ts';
import { handleRunnerUiEvent } from './run/session-events.ts';
import { beginUsageInvocation } from './run/usage-accounting.ts';
import { createActiveRun } from './active-run.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';
import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentSession, ContentBlock } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { RunStore, type StepState } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { parseTaskMarkers } from '../runs/task-markers.ts';
import { appendTurnText, trackTurnTail, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
describe('appendTurnText', () => {
  it.each(['initial execution', 'resumed execution'])(
    'preserves a marker boundary before later commentary during %s',
    () => {
      const turnText = appendTurnText(
        'Issue claimed.\n\nCEZ:PR=635\nCEZ:TITLE=linking per-project limits',
        'The verification gate confirms the defect.',
      );

      expect(turnText).toContain('CEZ:TITLE=linking per-project limits\nThe verification');
      expect(turnText).not.toContain('limitsThe');
      expect(parseTaskMarkers(turnText).title).toBe('linking per-project limits');
    },
  );

  it('matches runner result assembly for empty blocks and multiple complete text blocks', () => {
    expect(appendTurnText('', 'first')).toBe('first');
    expect(appendTurnText('first', '')).toBe('first');
    expect(appendTurnText(appendTurnText('', 'first'), 'second')).toBe('first\nsecond');
  });
});

describe('trackTurnTail', () => {
  const completed = (item: Extract<UiEvent, { type: 'item.completed' }>['item']): UiEvent => ({ type: 'item.completed', item });
  it('marks a non-empty top-level assistant message as a visible tail', () => {
    expect(trackTurnTail('none', completed({ kind: 'message', id: 'm', role: 'assistant', text: 'hi' }))).toBe('visible');
  });
  it('marks reasoning as a silent tail even after a visible message', () => {
    expect(trackTurnTail('visible', completed({ kind: 'reasoning', id: 'r', text: 'think' }))).toBe('silent');
  });
  it('marks a tool as a silent tail even after a visible message', () => {
    expect(trackTurnTail('visible', completed({ kind: 'tool', id: 't', name: 'Bash', toolKind: 'execute', title: 'Ran', status: 'completed' }))).toBe('silent');
  });
  it('marks a tool-only turn silent, not none', () => {
    expect(trackTurnTail('none', completed({ kind: 'tool', id: 't', name: 'Bash', toolKind: 'execute', title: 'Ran', status: 'completed' }))).toBe('silent');
  });
  it('ignores nested child items', () => {
    expect(trackTurnTail('visible', completed({ kind: 'message', id: 'c', role: 'assistant', text: 'child', parentItemId: 'p' }))).toBe('visible');
    expect(trackTurnTail('none', completed({ kind: 'reasoning', id: 'c', text: 'child', parentItemId: 'p' }))).toBe('none');
  });
  it('ignores empty assistant text and unrelated events', () => {
    expect(trackTurnTail('none', completed({ kind: 'message', id: 'e', role: 'assistant', text: '  ' }))).toBe('none');
    expect(trackTurnTail('visible', { type: 'turn.started', turnId: 't1' })).toBe('visible');
  });
});

describe('RunManager directional usage accounting', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-usage-accounting-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function fixture() {
    const run = store.createRun({
      title: 'usage',
      workflow: 'quick-task',
      task: 'usage',
      steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }],
    });
    store.updateStep(run.id, 'work', { iterations: 1, status: STEP_STATUS.running });
    const state = createActiveRun({ cwd: repoRoot, pendingHumanAsk: false, autonomous: false });
    const sink = new UiEventSink({ persist: () => undefined, emitLive: () => undefined });
    return { run, state, sink };
  }

  it('deduplicates starts and completions while summing multiple turns in one invocation', () => {
    const { run, state, sink } = fixture();
    beginUsageInvocation(runInternals(manager).context.store, run.id, state, 'work');
    const started: UiEvent = { type: 'turn.started', turnId: 'turn_1' };
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, started);
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, started);
    const completed: UiEvent = {
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 10, output: 2, total: 12 },
    };
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, completed);
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, completed);
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, { type: 'turn.started', turnId: 'turn_2' });
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, {
      type: 'turn.completed',
      turnId: 'turn_2',
      stopReason: 'end_turn',
      usage: { input: 5, output: 1, total: 6 },
    });

    expect(store.getRun(run.id)?.steps[0]).toMatchObject({
      usageInvocationsStarted: 1,
      usageInvocationsObserved: 1,
      usageTurnsStarted: 2,
      usageTurnsRecorded: 2,
      inputTokens: 15,
      outputTokens: 3,
    });
    expect(store.getRun(run.id)).toMatchObject({ inputTokens: 15, outputTokens: 3 });
  });

  it('keeps the run aggregate absent after a pre-turn failure even when a later invocation is metered', () => {
    const { run, state, sink } = fixture();
    beginUsageInvocation(runInternals(manager).context.store, run.id, state, 'work');
    // The first startSession attempt fails before emitting turn.started.
    beginUsageInvocation(runInternals(manager).context.store, run.id, state, 'work');
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, { type: 'turn.started', turnId: 'turn_1' });
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, {
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 8, output: 2, total: 10 },
    });

    expect(store.getRun(run.id)?.steps[0]).toMatchObject({
      usageInvocationsStarted: 2,
      usageInvocationsObserved: 1,
      usageTurnsStarted: 1,
      usageTurnsRecorded: 1,
      inputTokens: 8,
      outputTokens: 2,
    });
    expect(store.getRun(run.id)?.inputTokens).toBeUndefined();
    expect(store.getRun(run.id)?.outputTokens).toBeUndefined();
  });

  it('writes each completeness checkpoint before launching or forwarding its boundary event', () => {
    const { run, state } = fixture();
    store.flush();

    beginUsageInvocation(runInternals(manager).context.store, run.id, state, 'work');
    expect(RunStore.open(join(repoRoot, '.ai/cezar')).getRun(run.id)?.steps[0]).toMatchObject({
      usageInvocationsStarted: 1,
    });

    const persistedAtSink: StepState[] = [];
    const sink = new UiEventSink({ persist: () => undefined, emitLive: () => undefined });
    vi.spyOn(sink, 'handle').mockImplementation((_event: UiEvent) => {
        const persisted = RunStore.open(join(repoRoot, '.ai/cezar')).getRun(run.id)?.steps[0];
        if (persisted) persistedAtSink.push(persisted);
    });
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, { type: 'turn.started', turnId: 'turn_1' });
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, {
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 8, output: 2, total: 10 },
    });

    expect(persistedAtSink[0]).toMatchObject({
      usageInvocationsObserved: 1,
      usageTurnsStarted: 1,
    });
    expect(persistedAtSink[1]).toMatchObject({
      usageTurnsRecorded: 1,
      inputTokens: 8,
      outputTokens: 2,
    });
  });

  it('tracks an unmetered turn without recording it and ignores a completion that never started', () => {
    const { run, state, sink } = fixture();
    beginUsageInvocation(runInternals(manager).context.store, run.id, state, 'work');
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, {
      type: 'turn.completed',
      turnId: 'ghost',
      stopReason: 'end_turn',
      usage: { input: 99, output: 9, total: 108 },
    });
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, { type: 'turn.started', turnId: 'turn_1' });
    handleRunnerUiEvent(runInternals(manager).context, runInternals(manager).sessionHelperHost, run.id, state, sink, {
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
    });
    expect(store.getRun(run.id)?.steps[0]).toMatchObject({
      usageInvocationsStarted: 1,
      usageInvocationsObserved: 1,
      usageTurnsStarted: 1,
    });
    expect(store.getRun(run.id)?.steps[0]?.usageTurnsRecorded).toBeUndefined();
    expect(store.getRun(run.id)?.inputTokens).toBeUndefined();
  });
});

describe('RunManager reported cost accounting', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const workflow: WorkflowDef = {
    name: 'cost-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-cost-accounting-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    runnerHook.runner = undefined;
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it.each(['fresh', 'legacy-inflated', 'missed-persist'] as const)('counts cumulative Claude USD across Continue steps (%s)', async (priorState) => {
    let launches = 0;
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
      interrupt: async () => undefined,
      startSession(spec, onEvent, opts): AgentSession {
        const reports = launches++ === 0 ? [1.67, 1.74, 3.94] : [4.13, 5.01];
        let open = true;
        let finish!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>((resolve) => { finish = resolve; });
        queueMicrotask(() => void (async () => {
          opts?.onUiEvent?.({ type: 'session.started', sessionId: spec.sessionId!, backend: 'claude' });
          reports.forEach((usd, index) => {
            opts?.onUiEvent?.({ type: 'turn.started', turnId: `turn-${index}` });
            opts?.onUiEvent?.({
              type: 'turn.completed', turnId: `turn-${index}`, stopReason: 'end_turn',
              usage: { input: 1, output: 1, total: 100_002, cacheRead: 100_000 }, costUsd: usd,
            });
            onEvent?.({ type: 'cost', usd });
          });
          onEvent?.({ type: 'text', text: 'Finished.' });
          // The turn finishes through cezar_done, as an agent's does (hearsay-tools/cezarion#2397).
          const state = runInternals(manager).active.get(record.id)!;
          await manager.cezarToolHandlers(record.id, state.ciGeneration!).finishTurn({}, new AbortController().signal);
          onEvent?.({ type: 'turn-end' });
        })());
        const close = () => {
          if (!open) return;
          open = false;
          finish({ text: 'Finished.', toolCalls: [], tokensUsed: 0, sessionId: spec.sessionId });
        };
        return {
          result, sendMessage: () => false, sendAgentMessage: () => false,
          discardQueuedMessages: () => undefined, holdsHumanInput: () => false, end: close, interrupt: close,
          get open() { return open; },
        };
      },
    };

    const record = manager.startRun(workflow, { task: 'cost accounting', runner: 'claude', worktree: false });
    const waitForCost = async (cost: number) => {
      await waitForProduct(manager, store, () => store.getRun(record.id)?.status === 'done' && !manager.isActive(record.id) &&
        (store.getRun(record.id)?.steps.length ?? 0) >= launches);
      expect(store.getRun(record.id)?.costUsd).toBeCloseTo(cost);
    };
    await waitForCost(3.94);
    if (priorState === 'legacy-inflated') store.updateStep(record.id, record.steps[0]!.id, { costUsd: 7.35, backend: undefined });
    if (priorState === 'missed-persist') store.updateStep(record.id, record.steps[0]!.id, { costUsd: 1.74 });
    expect(manager.continueRun(record.id, { text: 'continue' })).toEqual({ ok: true });
    await waitForCost(priorState === 'legacy-inflated' ? 8.42 : 5.01);
    expect(store.getRun(record.id)?.steps[0]?.costUsd).toBeCloseTo(priorState === 'legacy-inflated' ? 7.35 : 3.94);
    expect(store.getRun(record.id)?.steps[1]?.costUsd).toBeCloseTo(1.07);
  }, 30_000);

  it('persists a reported cost from a Claude error result', async () => {
    const previous = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    try {
      const record = manager.startRun(workflow, {
        task: 'mock:auth-error', runner: 'claude', worktree: false,
      });
      await waitForProduct(manager, store, () => store.getRun(record.id)?.status === 'failed');
      expect(store.getRun(record.id)?.costUsd).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = previous;
    }
  }, 30_000);
});

describe('RunManager.continueRun override', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    // No live agent — we only assert the synchronous persistence continueRun does before it
    // hands off to the (stubbed) continuation.
    (manager as unknown as { runContinuation: () => Promise<void> }).runContinuation = async () => {};
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
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
    store.updateRun(record.id, { status: RUN_STATUS.done, finishedAt: new Date().toISOString() });
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
    const internals = runInternals(manager).line;
    const pump = vi.spyOn(internals, 'pump').mockResolvedValue();
    await manager.recover();
    expect(pump).toHaveBeenCalled();
    expect(runInternals(manager).line.pendingContinuations.get(id)?.prompt).toContain('read this with the chosen account');
    expect(runInternals(manager).line.pendingContinuations.get(id)?.sessionId).toBeUndefined();
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

  it('starts fresh when Continue switches to a backend that does not own the session', () => {
    const id = resumableRun();
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { runner: 'codex' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBeUndefined();
    expect(calls[0]?.[3]).toBe('codex');
  });

  it('resumes when Continue stays on the backend that owns the session', () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { runner: 'claude' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBe('sess-1');
    expect(calls[0]?.[3]).toBe('claude');
  });

  it('an omitted override preserves the run current backend/model (backward compat)', () => {
    const id = resumableRun();
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    const after = store.getRun(id);
    expect(after?.runner).toBe('claude');
    expect(after?.model).toBe('sonnet');
  });

  it('persists an effort override and keeps it when Continue omits it (#45)', () => {
    const id = resumableRun();
    store.updateRun(id, { effort: 'medium' });
    expect(manager.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
    expect(store.getRun(id)?.effort).toBe('medium');
    // The stub bypasses startup teardown; simulate its completed lifecycle before
    // accepting a second Continue (terminal status alone never proves termination).
    runInternals(manager).line.starting.delete(id);
    store.updateRun(id, { status: RUN_STATUS.done });

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
    store.updateRun(record.id, { status: RUN_STATUS.done, finishedAt: new Date().toISOString() });
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
    store.updateRun(record.id, { status: RUN_STATUS.done, finishedAt: new Date().toISOString() });
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

  it('starts fresh when Continue switches to another login of the same agent', () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude', profileId: 'default' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    // `claude --resume <id>` under another login would find nothing and silently open a fresh
    // conversation, so the session id is deliberately not passed.
    expect(calls[0]?.[2]).toBeUndefined();
    expect(calls[0]?.[3]).toBe('claude');
  });

  it('resumes when the picked account is the one that owns the session', () => {
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude', profileId: 'klaudiusz' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { agentProfile: 'klaudiusz' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBe('sess-1');
  });

  it('treats a step that recorded no account as the discovered one', () => {
    // Pre-accounts sessions ran under whatever `agentHomePaths()` finds, so re-picking `default`
    // is not a switch and must still resume.
    const id = resumableRun();
    store.updateStep(id, 's1', { backend: 'claude' });
    const calls: unknown[][] = [];
    (manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> }).runContinuation = async (...args) => {
      calls.push(args);
    };

    expect(manager.continueRun(id, { agentProfile: 'default' })).toEqual({ ok: true });
    expect(calls[0]?.[2]).toBe('sess-1');
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
    store.updateRun(record.id, { status: RUN_STATUS.done });
    const result = manager.continueRun(record.id, { runner: 'codex' });
    expect(result.ok).toBe(false);
    expect(store.getRun(record.id)?.runner).toBe('claude');
  });
});

describe('RunManager queued-stack mutators (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const PNG = Buffer.from('png').toString('base64');

  const WORKFLOW: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  };

  const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
  const image = (): ContentBlock => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG },
  });

  /** Seed a run that the engine still holds as queued. */
  const seedQueued = (task = 'ship it') => {
    const record = store.createRun({ title: 't', workflow: 'w', task, steps: [] });
    runInternals(manager).line.pendingJobs.set(record.id, { workflow: WORKFLOW, input: { task } });
    return record;
  };
  const dequeue = (id: string) =>
    runInternals(manager).line.pendingJobs.delete(id);
  const imagesDir = (id: string) => join(repoRoot, '.ai/cezar', 'runs', `${id}-images`);

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-stack-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('appends messages in order while queued', () => {
    const r = seedQueued();
    const first = manager.enqueueMessage(r.id, text('also update the changelog'));
    const second = manager.enqueueMessage(r.id, text('and bump the version'));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(store.getRun(r.id)?.queuedMessages?.map((m) => m.text)).toEqual([
      'also update the changelog',
      'and bump the version',
    ]);
  });

  it('notes a document persistence failure instead of silently losing the upload', () => {
    const r = seedQueued();
    writeFileSync(imagesDir(r.id), 'not a directory');
    manager.enqueueMessage(r.id, [{ type: 'file', mediaType: 'application/pdf', data: 'YQ==' }]);
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes('could not be saved'))).toBe(true);
    store.flush();
    const reopened = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(r.id)?.queuedMessages?.[0]?.text).toContain('could not be saved');
  });

  it('retains a delivery explanation when a document-only queued edit cannot be saved', () => {
    const r = seedQueued();
    const message = manager.enqueueMessage(r.id, text('replace me'))!;
    writeFileSync(imagesDir(r.id), 'not a directory');
    const edited = manager.editQueuedMessage(r.id, message.id, {
      text: '', images: [{ type: 'file', mediaType: 'application/pdf', data: 'YQ==' }],
    });
    expect(edited?.text).toContain('could not be saved');
  });

  it('persists attached images and records their URLs', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image(), { type: 'text', text: 'like this' }]);
    expect(msg?.images).toEqual([`/api/v1/runs/${r.id}/images/pasted-1.png`]);
    expect(existsSync(join(imagesDir(r.id), 'pasted-1.png'))).toBe(true);
  });

  it('hydrates edits and stacked messages into a queued restart continuation', async () => {
    const r = store.createRun({
      title: 'interrupted task',
      workflow: 'quick-task',
      task: 'original recovery goal',
      steps: [],
    });
    store.updateRun(r.id, { status: RUN_STATUS.queued });

    const internals = manager as unknown as {
      runContinuation(
        runId: string,
        stepId: string,
        sessionId: string | undefined,
        backend: 'claude',
        prompt: string,
        images: ContentBlock[],
        persistedImages: ContentBlock[],
        persistedAttachments: Array<{ name: string; url: string; path: string }>,
      ): Promise<void>;
    };
    runInternals(manager).line.pendingContinuations.set(r.id, {
      stepId: 'continue-1',
      sessionId: 'session-interrupted',
      backend: 'claude',
      prompt: 'restart recovery',
      images: [],
      lineJoinedAt: Date.parse(r.createdAt),
    });
    runInternals(manager).line.queue.push(r.id);

    expect(manager.editTask(r.id, 'amended recovery goal')).toBe(true);
    expect(
      manager.enqueueMessage(r.id, [image(), { type: 'file', mediaType: 'text/markdown', data: Buffer.from('# queued brief').toString('base64') }, { type: 'text', text: 'also verify the queue' }]),
    ).not.toBeNull();

    let delivered:
      | {
          prompt: string;
          images: ContentBlock[];
          persistedImages: ContentBlock[];
          persistedAttachments: Array<{ name: string; url: string; path: string }>;
        }
      | undefined;
    internals.runContinuation = async (
      _runId,
      _stepId,
      _sessionId,
      _backend,
      prompt,
      images,
      persistedImages,
      persistedAttachments,
    ) => {
      delivered = { prompt, images, persistedImages, persistedAttachments };
    };
    await runInternals(manager).line.pump();

    expect(delivered?.prompt).toBe(
      'restart recovery\n\nCurrent task and queued updates:\n\n' +
        'amended recovery goal\n\nalso verify the queue',
    );
    expect(delivered?.images).toEqual([]);
    expect(delivered?.persistedImages).toEqual([image()]);
    expect(delivered?.persistedAttachments).toEqual([
      {
        name: 'pasted-1.png',
        url: `/api/v1/runs/${r.id}/images/pasted-1.png`,
        path: join(imagesDir(r.id), 'pasted-1.png'),
      },
      { name: 'pasted-2.md', url: `/api/v1/runs/${r.id}/images/pasted-2.md`, path: join(imagesDir(r.id), 'pasted-2.md') },
    ]);
    expect(readdirSync(imagesDir(r.id)).sort()).toEqual(['pasted-1.png', 'pasted-2.md']);
    expect(runInternals(manager).line.pendingContinuations.has(r.id)).toBe(false);
    expect(manager.editTask(r.id, 'too late')).toBe(false);
  });

  it('refuses every mutation once the run has been dequeued', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, text('while queued'))!;
    dequeue(r.id);

    expect(manager.enqueueMessage(r.id, text('too late'))).toBeNull();
    expect(manager.editQueuedMessage(r.id, msg.id, { text: 'too late' })).toBeNull();
    expect(manager.removeQueuedMessage(r.id, msg.id)).toBe(false);
    expect(manager.editTask(r.id, 'too late')).toBe(false);
    // …and the stack is untouched by the refused calls.
    expect(store.getRun(r.id)?.queuedMessages?.map((m) => m.text)).toEqual(['while queued']);
  });

  it('edits a message in place, keeping its id and createdAt', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, text('typo here'))!;
    const edited = manager.editQueuedMessage(r.id, msg.id, { text: 'fixed now' })!;
    expect(edited.id).toBe(msg.id);
    expect(edited.createdAt).toBe(msg.createdAt);
    expect(store.getRun(r.id)?.queuedMessages).toEqual([edited]);
  });

  it('keeps existing attachments when an edit only changes the text', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image(), { type: 'text', text: 'typo' }])!;
    const file = join(imagesDir(r.id), 'pasted-1.png');

    const edited = manager.editQueuedMessage(r.id, msg.id, { text: 'fixed' })!;

    expect(edited.images).toEqual(msg.images);
    expect(existsSync(file)).toBe(true);
  });

  it('returns null when the message id is unknown', () => {
    const r = seedQueued();
    expect(manager.editQueuedMessage(r.id, 'nope', { text: 'x' })).toBeNull();
    expect(manager.removeQueuedMessage(r.id, 'nope')).toBe(false);
  });

  it('removes a message and unlinks its orphaned images', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image()])!;
    const file = join(imagesDir(r.id), 'pasted-1.png');
    expect(existsSync(file)).toBe(true);

    expect(manager.removeQueuedMessage(r.id, msg.id)).toBe(true);
    expect(store.getRun(r.id)?.queuedMessages).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  /** Never delete a file another entry still points at. */
  it('keeps an image that a surviving message still references', () => {
    const r = seedQueued();
    const first = manager.enqueueMessage(r.id, [image()])!;
    const shared = first.images![0]!;
    // A second entry deliberately pointing at the same file.
    const second = manager.enqueueMessage(r.id, text('see above'))!;
    store.updateRun(r.id, {
      queuedMessages: store
        .getRun(r.id)!
        .queuedMessages!.map((m) => (m.id === second.id ? { ...m, images: [shared] } : m)),
    });

    manager.removeQueuedMessage(r.id, first.id);
    expect(existsSync(join(imagesDir(r.id), 'pasted-1.png'))).toBe(true);
  });

  /** Same rule against the initial prompt's own attachments. */
  it('keeps an image still referenced by taskImages', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image()])!;
    store.updateRun(r.id, { taskImages: [msg.images![0]!] });

    manager.removeQueuedMessage(r.id, msg.id);
    expect(existsSync(join(imagesDir(r.id), 'pasted-1.png'))).toBe(true);
  });

  it('edits the task and re-derives the heuristic title and refs', () => {
    const r = seedQueued('fix the thing');
    expect(manager.editTask(r.id, 'fix the login bug in issue #123')).toBe(true);
    const updated = store.getRun(r.id)!;
    expect(updated.task).toBe('fix the login bug in issue #123');
    expect(updated.title).not.toBe('t');
    expect(updated.issueNumber).toBe(123);
  });

  /** Hand-edited titles always win (#389). */
  it('leaves a user-owned title alone when the task is edited', () => {
    const r = seedQueued('fix the thing');
    store.updateRun(r.id, { titleSummary: 'My own title', titleOrigin: 'user' });
    manager.editTask(r.id, 'completely different task now');
    expect(store.getRun(r.id)?.titleSummary).toBe('My own title');
    expect(store.getRun(r.id)?.title).toBe('t');
  });

  it('defers a message only while the run is starting up', () => {
    const r = seedQueued();
    const starting = runInternals(manager).line.starting;

    // Not starting yet → the ladder falls through to 409.
    expect(manager.deferMessage(r.id, text('nope'))).toBe(false);

    starting.add(r.id);
    expect(manager.deferMessage(r.id, text('buffer me'))).toBe(true);
    expect(
      runInternals(manager).queuedInput.deferredMessages.get(
        r.id,
      ),
    ).toHaveLength(1);
  });

  /**
   * The sub-window that `starting` alone misses: `execute()` drops the run from
   * `starting` as soon as it builds the ActiveRun, seconds before the backend is
   * spawned. A message arriving there must still buffer, not 409.
   */
  it('still defers after `starting` is cleared but before the session opens', () => {
    const r = seedQueued();
    (manager as unknown as { active: Map<string, unknown> }).active.set(r.id, {
      cancelled: false,
      sessionEverOpened: undefined,
    });
    expect(manager.deferMessage(r.id, text('mid-spawn'))).toBe(true);
  });

  /**
   * Review fix: `flushDeferred` used to drop its buffer before sending, so a message the
   * session refused was silently lost — precisely the failure `deferMessage` exists to
   * prevent. Anything unsent must stay buffered for the next session that opens.
   */
  it('re-buffers a deferred message the session refuses, instead of dropping it', () => {
    const r = seedQueued();
    const starting = runInternals(manager).line.starting;
    const buffer = runInternals(manager).queuedInput.deferredMessages;

    starting.add(r.id);
    manager.deferMessage(r.id, text('buffer me'));
    expect(buffer.get(r.id)).toHaveLength(1);

    // Flush with no open session — `sendMessage` refuses.
    ;runInternals(manager).queuedInput.flushDeferred(r.id);
    expect(buffer.get(r.id)).toHaveLength(1);

    // Now a session that accepts it: the buffer drains.
    const delivered: ContentBlock[][] = [];
    (manager as unknown as { sendMessage(id: string, c: ContentBlock[]): boolean }).sendMessage = (
      _id,
      content,
    ) => {
      delivered.push(content);
      return true;
    };
    ;runInternals(manager).queuedInput.flushDeferred(r.id);
    expect(delivered).toHaveLength(1);
    expect(buffer.has(r.id)).toBe(false);
  });

  it('stops deferring once a session has opened (a closed session is a real 409)', () => {
    const r = seedQueued();
    (manager as unknown as { active: Map<string, unknown> }).active.set(r.id, {
      cancelled: false,
      sessionEverOpened: true,
    });
    expect(manager.deferMessage(r.id, text('too late'))).toBe(false);
  });
});
