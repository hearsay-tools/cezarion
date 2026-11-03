import { runnerHook, run, GIT_ID, waitForProduct } from './run-fixture.testkit.ts';
import { handleRunnerUiEvent } from './run/session-events.ts';
import { beginUsageInvocation } from './run/usage-accounting.ts';
import { createActiveRun } from './active-run.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';
import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { RunStore, type StepState } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { parseTaskMarkers } from '../runs/task-markers.ts';
import { appendTurnText, trackTurnTail, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
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
