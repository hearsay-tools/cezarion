import { AttachmentWriter } from './run/attachment-writer.ts';
import { QueuedInput } from './run/queued-input.ts';
import { TurnBookkeeper } from './run/turn-bookkeeping.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { setRunStatus, crashStore } from '../runs/run-store.testkit.ts';
import { runnerHook, run, GIT_ID, waitForProduct, TURN_TEXT, setupMonitoringFixture, FINISHED_RUN_STATUSES } from './run-fixture.testkit.ts';
import { beginUsageInvocation, recordUsageUiEvent } from './run/usage-accounting.ts';
import { createActiveRun } from './active-run.ts';
import { createFixtureManager, drainFixtureManagers, unused, fixtureWork } from './fixture-cleanup.testkit.ts';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, afterAll, beforeAll } from 'vitest';
import { type AgentRunResult, type AgentRunSpec, type AgentSession, type ContentBlock } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { type UiEvent } from '../core/ui-events.ts';
import { RunStore, type StepState, type RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { parseTaskMarkers } from '../runs/task-markers.ts';
import { appendTurnText, trackTurnTail, RunManager } from './run.ts';
import { type WorkflowDef } from './types.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_VIA, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createWorktree } from '../git-worktree.ts';
import { resolveAttachmentPath } from './attachment-path.ts';
import { monitoringTimerWait, monitoringWakeOf } from './waits.testkit.ts';
import { registerRunProcess, unregisterRunProcess } from '../core/process-usage.ts';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { asksQuestion } from '@open-mercato/cezar-contract/waits';
import { fileURLToPath } from 'node:url';

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
    runnerHook.runner = undefined;
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
    return { run, state };
  }

  it('deduplicates starts and completions while summing multiple turns in one invocation', () => {
    const { run, state } = fixture();
    beginUsageInvocation(store, run.id, state, 'work');
    const started: UiEvent = { type: 'turn.started', turnId: 'turn_1' };
    recordUsageUiEvent(store, run.id, state, started);
    recordUsageUiEvent(store, run.id, state, started);
    const completed: UiEvent = {
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 10, output: 2, total: 12 },
    };
    recordUsageUiEvent(store, run.id, state, completed);
    recordUsageUiEvent(store, run.id, state, completed);
    recordUsageUiEvent(store, run.id, state, { type: 'turn.started', turnId: 'turn_2' });
    recordUsageUiEvent(store, run.id, state, {
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
    const { run, state } = fixture();
    beginUsageInvocation(store, run.id, state, 'work');
    // The first startSession attempt fails before emitting turn.started.
    beginUsageInvocation(store, run.id, state, 'work');
    recordUsageUiEvent(store, run.id, state, { type: 'turn.started', turnId: 'turn_1' });
    recordUsageUiEvent(store, run.id, state, {
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

  it('writes each completeness checkpoint before launching or forwarding its boundary event', async () => {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'base');
    await run('git', ['add', 'a.txt'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    manager.dispose();
    manager = createFixtureManager(store, repoRoot);
    const persistedAtSink: StepState[] = [];
    store.on('event', ({ runId, event }) => {
      if (event.type !== 'turn.started' && event.type !== 'turn.completed') return;
      const persisted = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true }).getRun(runId)?.steps[0];
      expect(persisted).toMatchObject(event.type === 'turn.started'
        ? { usageInvocationsObserved: 1, usageTurnsStarted: 1 }
        : { usageTurnsRecorded: 1, inputTokens: 8, outputTokens: 2 });
      persistedAtSink.push(persisted!);
    });
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => undefined,
      startSession: (_spec, _onEvent, options) => {
        const persisted = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true }).getRun(record.id)?.steps[0];
        expect(persisted).toMatchObject({ usageInvocationsStarted: 1 });
        options?.onUiEvent?.({ type: 'turn.started', turnId: 'turn_1' });
        options?.onUiEvent?.({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn', usage: { input: 8, output: 2, total: 10 } });
        return { result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
          sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => undefined,
          holdsHumanInput: () => false, end: () => undefined, interrupt: () => undefined, open: false };
      },
    };
    const record = manager.startRun({ name: 'usage', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}' }] }, { task: 'usage', worktree: false });
    await waitForProduct(manager, store, () => persistedAtSink.length === 2 && !manager.isActive(record.id));
    expect(persistedAtSink).toHaveLength(2);
  });

  it('tracks an unmetered turn without recording it and ignores a completion that never started', () => {
    const { run, state } = fixture();
    beginUsageInvocation(store, run.id, state, 'work');
    recordUsageUiEvent(store, run.id, state, {
      type: 'turn.completed',
      turnId: 'ghost',
      stopReason: 'end_turn',
      usage: { input: 99, output: 9, total: 108 },
    });
    recordUsageUiEvent(store, run.id, state, { type: 'turn.started', turnId: 'turn_1' });
    recordUsageUiEvent(store, run.id, state, {
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
    const tools = new Map<string, ReturnType<RunManager['cezarToolHandlers']>>();
    const handlers = manager.cezarToolHandlers.bind(manager);
    vi.spyOn(manager, 'cezarToolHandlers').mockImplementation((id, generation) => {
      const result = handlers(id, generation); tools.set(id, result); return result;
    });
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
          await tools.get(record.id)!.finishTurn({}, new AbortController().signal);
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

describe('TurnBookkeeper.recordTurnEnd', () => {
  const savedAutoname = process.env.CEZ_AUTONAME;
  beforeAll(() => {
    process.env.CEZ_AUTONAME = '0';
  });
  afterAll(() => {
    if (savedAutoname === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoname;
  });
  let repoRoot: string;
  let store: RunStore;
  let bookkeeper: TurnBookkeeper;

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-turnend-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\ntwo\nthree\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    bookkeeper = new TurnBookkeeper({ store, repoRoot, dataDir: join(repoRoot, '.ai/cezar'),
      work: new TrackedWork(), semaphore: new WorkspaceSemaphore(), disposed: () => false,
    }, unused<ConstructorParameters<typeof TurnBookkeeper>[1]>('TurnBookkeeper.host', { isDisposedDelegatedRun: () => false }));
  });

  afterAll(async () => {
    await drainFixtureManagers(repoRoot);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A run with a real worktree forked off main, holding an edit + a new file. */
  async function makeWorktreeRun(): Promise<RunRecord> {
    const record = store.createRun({ title: 'fix the login bug', workflow: 'quick-task', task: 'fix the login bug', steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    store.updateRun(record.id, { worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch });
    writeFileSync(join(wt.path, 'a.txt'), 'one\nTWO\nthree\n'); // 1 add, 1 del
    writeFileSync(join(wt.path, 'new.txt'), 'x\ny\n'); // 2 adds, untracked
    return store.getRun(record.id) as RunRecord;
  }

  it('computes a real diffStat and never derives a title from turn text', async () => {
    const record = await makeWorktreeRun();
    await bookkeeper.recordTurnEnd(record.id, TURN_TEXT);

    const after = store.getRun(record.id);
    // The agent's words are not a title source (they produced "Reading the
    // handoff…"-class titles) — naming is the namer's job, or the user's.
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.diffStat).toEqual({ adds: 3, dels: 1, files: 2 });

    // Second turn: the diff stat keeps refreshing.
    writeFileSync(join(store.getRun(record.id)!.worktreePath!, 'more.txt'), 'z\n');
    await bookkeeper.recordTurnEnd(record.id, 'Now I rewrote everything from scratch with a different approach.');
    const later = store.getRun(record.id);
    expect(later?.titleSummary).toBeUndefined();
    expect(later?.diffStat).toEqual({ adds: 4, dels: 1, files: 3 });
  });

  /**
   * #751: `recordTurnEnd` is the ONE place `RunRecord.diffStat` is written, so it
   * is also the one place `run.branch` has to reach `worktreeShortstat` — without
   * it, a review/QA run that checked another branch out into its worktree stores
   * that branch's whole diff as this task's work.
   */
  it('stores only the uncommitted diff when the agent repointed the worktree HEAD', async () => {
    const record = await makeWorktreeRun();
    const wt = record.worktreePath as string;

    // A branch with real commits on it, checked out into the task's worktree —
    // exactly what a `review/pr-NNN` or QA run does.
    await run('git', ['checkout', '-q', '-b', 'someone-elses-branch'], { cwd: wt });
    writeFileSync(join(wt, 'theirs.txt'), 'a\nb\nc\nd\ne\nf\n'); // 6 lines that are NOT this task's
    await run('git', ['add', '-A'], { cwd: wt });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'their work'], { cwd: wt });
    writeFileSync(join(wt, 'mine.txt'), 'z\n'); // the 1 line this task produced

    await bookkeeper.recordTurnEnd(record.id, TURN_TEXT);

    // 1 uncommitted line, flagged — not the 6 committed ones the foreign branch carries
    // (which, with `a.txt`'s edit and `new.txt`, would have read `+10 −1 / 4 files`).
    expect(store.getRun(record.id)?.diffStat).toEqual({
      adds: 1,
      dels: 0,
      files: 1,
      repointed: true,
    });
  });

  it('drops the repointed flag again once HEAD returns to the task branch', async () => {
    const record = await makeWorktreeRun();
    const wt = record.worktreePath as string;
    await run('git', ['checkout', '-q', '-b', 'a-detour'], { cwd: wt });
    await bookkeeper.recordTurnEnd(record.id, TURN_TEXT);
    expect(store.getRun(record.id)?.diffStat?.repointed).toBe(true);

    // `updateRun` replaces `diffStat` wholesale, so a stale `repointed: true` can
    // never outlive the repoint that caused it.
    await run('git', ['checkout', '-q', record.branch as string], { cwd: wt });
    await bookkeeper.recordTurnEnd(record.id, TURN_TEXT);
    const after = store.getRun(record.id);
    expect(after?.diffStat).toEqual({ adds: 3, dels: 1, files: 2 });
    expect(after?.diffStat).not.toHaveProperty('repointed');
  });

  it('never overwrites a user-edited title (PATCH sets titleSummary too)', async () => {
    const record = await makeWorktreeRun();
    // What PATCH /api/v1/runs/:id does on a rename:
    store.updateRun(record.id, { title: 'My name', titleSummary: 'My name', titleOrigin: 'user' });
    await bookkeeper.recordTurnEnd(record.id, TURN_TEXT);
    expect(store.getRun(record.id)?.titleSummary).toBe('My name');
  });

  it('skips diffStat for a worktree-less run, and never throws', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'do the thing', steps: [] });
    await expect(bookkeeper.recordTurnEnd(record.id, TURN_TEXT)).resolves.toBeUndefined();
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.diffStat).toBeUndefined();
  });

  it('is a quiet no-op for an unknown run', async () => {
    await expect(bookkeeper.recordTurnEnd('nope', TURN_TEXT)).resolves.toBeUndefined();
  });

  it('applies in-band CEZ markers from the turn text (spec 2026-07-18-task-ref-markers)', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'implement comment threads', steps: [] });
    await bookkeeper.recordTurnEnd(
      record.id,
      'Progress so far.\nCEZ:PR=500\nCEZ:ISSUE=433\nCEZ:TITLE=implementing comment threads\nMore to come.',
    );
    const after = store.getRun(record.id);
    expect(after?.prNumber).toBe(500);
    expect(after?.issueNumber).toBe(433);
    expect(after?.markerRefs).toEqual({ pr: 500, issue: 433 });
    // The declared title lands number-prefixed, marker-owned.
    expect(after?.titleSummary).toBe('500: implementing comment threads');
    expect(after?.titleOrigin).toBe('marker');
  });

  it('a marker title never overwrites a user rename — but the numbers still land', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.updateRun(record.id, { title: 'My name', titleSummary: 'My name', titleOrigin: 'user' });
    await bookkeeper.recordTurnEnd(record.id, 'CEZ:PR=500\nCEZ:TITLE=implementing comment threads');
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBe('My name');
    expect(after?.titleOrigin).toBe('user');
    expect(after?.prNumber).toBe(500);
  });

  it('a junk CEZ:TITLE never blanks the title', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    await bookkeeper.recordTurnEnd(record.id, 'CEZ:PR=500\nCEZ:TITLE=...');
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.titleOrigin).toBeUndefined();
    expect(after?.prNumber).toBe(500); // the number still lands
  });

  it('prose that merely mentions a marker changes nothing', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    await bookkeeper.recordTurnEnd(record.id, 'I will emit CEZ:PR=442 once the PR exists.');
    const after = store.getRun(record.id);
    expect(after?.markerRefs).toBeUndefined();
    expect(after?.prNumber).toBeUndefined();
    expect(after?.titleSummary).toBeUndefined();
  });
});

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

describe('RunSettlement.settleSuccess — optional review gate', () => {
  const savedGate = process.env.CEZ_REVIEW_GATE;
  const savedAutoname = process.env.CEZ_AUTONAME;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeAll(async () => {
    process.env.CEZ_AUTONAME = '0';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-reviewgate-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\ntwo\nthree\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterAll(async () => {
    await drainFixtureManagers(repoRoot);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedGate === undefined) delete process.env.CEZ_REVIEW_GATE;
    else process.env.CEZ_REVIEW_GATE = savedGate;
    if (savedAutoname === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoname;
  });

  afterEach(() => {
    delete process.env.CEZ_REVIEW_GATE;
    // Reset the config file each test so config.reviewGate never leaks across cases.
    rmSync(join(repoRoot, '.ai/cezar', 'config.json'), { force: true });
  });

  /** A fresh run + worktree holding a real diff (edit + new file) vs main. */
  async function changedRun(autonomous?: boolean): Promise<RunRecord> {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', autonomous, steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    // settleSuccess runs at a live turn's end, never on a queued run (hearsay-tools/cezarion#1804).
    setRunStatus(store, record.id, RUN_STATUS.running, { worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch });
    writeFileSync(join(wt.path, 'a.txt'), 'one\nTWO\nthree\n');
    writeFileSync(join(wt.path, 'new.txt'), 'x\n');
    return store.getRun(record.id) as RunRecord;
  }

  /** A fresh run + worktree with no changes vs main (empty diff). */
  async function cleanRun(): Promise<RunRecord> {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    setRunStatus(store, record.id, RUN_STATUS.running, { worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch });
    return store.getRun(record.id) as RunRecord;
  }

  const settle = async (id: string) => {
    store.addStep(id, { id: 'task', name: 'Task', kind: STEP_KIND.agent });
    store.updateStep(id, 'task', { status: STEP_STATUS.waiting });
    setRunStatus(store, id, RUN_STATUS.waiting, { currentStepId: 'task' });
    expect(manager.finishBlockedReason(id)).toBeUndefined();
    expect(manager.finish(id)).toBe(true);
    await waitForProduct(manager, store, () => FINISHED_RUN_STATUSES.has(store.getRun(id)!.status));
  };

  it('gate off (default) + changes → done, diff left in the worktree', async () => {
    const record = await changedRun();
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  });

  it('gate on (env) + non-autonomous + changes → review', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const record = await changedRun();
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('review');
  });

  it('gate on + autonomous + changes → done (autonomous wins — the #489 fix)', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const record = await changedRun(true);
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  });

  it('gate on + no changes → done (the diff check stays first)', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const record = await cleanRun();
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  });
});

describe('a chain of 2 selected skills runs BOTH steps, in order (#410)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-410-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterAll(async () => {
    await drainFixtureManagers(repoRoot);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('runs both skill steps to completion, and the second step\'s prompt carries the chain guard', async () => {
    // Exactly the shape `githubRunBody` / `skillChainSteps` build for 2
    // selected skills: one agent step per skill, every step's prompt just
    // `{{task}}` — no per-step differentiation from the GUI side.
    const workflow: WorkflowDef = {
      name: '(planned)',
      source: 'built-in',
      steps: [
        { id: 'om-auto-review-pr', name: 'om-auto-review-pr', skill: 'om-auto-review-pr', prompt: '{{task}}' },
        { id: 'om-auto-verify-pr-ui', name: 'om-auto-verify-pr-ui', skill: 'om-auto-verify-pr-ui', prompt: '{{task}}' },
      ],
    };
    // `mock:cezar-done` makes the mock's turn call cezar_done — needed so the
    // last (interactive) step closes itself and the run reaches a terminal
    // status instead of parking at `waiting` for a real reply.
    const record = manager.startRun(workflow, { task: 'mock:cezar-done fix the PR', worktree: false });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    await waitForProduct(manager, store, () => terminal.has(store.getRun(record.id)?.status ?? '') && !manager.isActive(record.id), 20_000);

    const finished = store.getRun(record.id);
    expect(finished?.worktree).toBe(false);
    expect(finished?.worktreePath).toBeUndefined();
    expect(finished?.baseBranch).toMatch(/^[0-9a-f]{40}$/);
    // Neither step failed or was skipped — the reported bug looked exactly
    // like this from the RunRecord's point of view (both `done`) while the
    // second step's session had done nothing; the assertion below on
    // `notes.md` is what actually distinguishes a real run from a no-op one.
    expect(finished?.steps.map((s) => ({ id: s.id, status: s.status }))).toEqual([
      { id: 'om-auto-review-pr', status: STEP_STATUS.done },
      { id: 'om-auto-verify-pr-ui', status: STEP_STATUS.done },
    ]);

    // The mock leaves a `notes.md` trace on its first turn, once per spawned
    // session (`scripts/mock-claude.mjs`) — one line per step that actually
    // ran, in order, holding the head of that step's userText.
    //
    // Assert only on the note's opening sentence: it proves the guard reached
    // the right step's prompt with the right numbering, and stays inside the
    // mock's fixed userText slice however the wording grows later. The note's
    // full text is pinned in `test/unit/workflow-types.test.ts`.
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    expect(notes.length).toBe(2);
    expect(notes[0]).toContain('you are running step 1 of 2');
    expect(notes[1]).toContain('you are running step 2 of 2');
  }, 30_000);
});

describe('a single agent step plus a check step gets NO chain note (#410)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-410-single-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterAll(async () => {
    await drainFixtureManagers(repoRoot);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("leaves the lone agent step's prompt untouched", async () => {
    // README.md's documented workflow, with a check that passes so the run
    // reaches a terminal state without looping back.
    const workflow: WorkflowDef = {
      name: 'implement-verify',
      source: 'file',
      steps: [
        { id: 'implement', skill: 'project-conventions', prompt: '{{task}}' },
        { id: 'verify', command: 'true', onFail: { retry: 'implement', max: 2 } },
      ],
    };
    const record = manager.startRun(workflow, { task: 'mock:cezar-done fix the login bug', worktree: false });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    await waitForProduct(manager, store, () => terminal.has(store.getRun(record.id)?.status ?? '') && !manager.isActive(record.id), 20_000);

    expect(store.getRun(record.id)?.steps.map((s) => ({ id: s.id, status: s.status }))).toEqual([
      { id: 'implement', status: STEP_STATUS.done },
      { id: 'verify', status: STEP_STATUS.done },
    ]);

    // One session ran, and its userText is the task text alone — no chain
    // note, no "an earlier step" premise, no skill named as the step's goal.
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('mock:cezar-done fix the login bug');
    expect(notes[0]).not.toContain('chain of');
    expect(notes[0]).not.toContain('earlier step');
    expect(notes[0]).not.toContain('project-conventions');
  }, 30_000);
});

describe('RunManager monitoring turns', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('nested Codex subagent items after park do not unpark monitoring (#121)', async () => {
    fixture.manager.dispose();
    const semaphore = new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: 0.01 } });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot, { semaphore });
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup keep going', runner: 'claude', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(monitoringWakeOf(r)));

    const wakeTimer = monitoringTimerWait(fixture.store.getRun(record.id));
    const deadline = monitoringWakeOf(fixture.store.getRun(record.id));
    const inject = runnerHook.uiEvent;

    inject({
      type: 'item.completed',
      item: { kind: 'message', id: 'compact-1', role: 'assistant', text: 'Compacted context' },
    });
    inject({
      type: 'item.started',
      item: {
        kind: 'tool',
        id: 'child-bash',
        name: 'commandExecution',
        toolKind: 'execute',
        title: 'Ran ls',
        status: RUN_STATUS.running,
        parentItemId: 'task6',
      },
    });
    inject({
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 'child-bash',
        name: 'commandExecution',
        toolKind: 'execute',
        title: 'Ran ls',
        status: 'completed',
        parentItemId: 'task6',
      },
    });
    inject({
      type: 'item.started',
      item: { kind: 'reasoning', id: 'child-think', text: 'working', parentItemId: 'task6' },
    });
    inject({
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 'task6',
        name: 'subAgentActivity',
        toolKind: 'task',
        title: 'task6',
        status: 'completed',
      },
    });

    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.waiting });
    expect(monitoringWakeOf(fixture.store.getRun(record.id))).toBe(deadline);
    expect(monitoringTimerWait(fixture.store.getRun(record.id))).toEqual(wakeTimer);
    expect(semaphore.busy()).toBe(0);

    await waitFor(record.id, () => {
      const events = readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8');
      return events.includes('automatic monitoring wake-up (1/40)');
    });
  }, 30_000);

  it('parent turn.started after park still unparks monitoring (#61, #121)', async () => {
    fixture.manager.dispose();
    const semaphore = new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: 0.02 } });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot, { semaphore });
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup keep going', runner: 'claude', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(monitoringWakeOf(r)));

    runnerHook.uiEvent({ type: 'turn.started', turnId: 'turn_parent_resume' });

    // hearsay-tools/cezarion#1233: the resumed turn keeps its pool slot until its own turn end.
    // hearsay-tools/cezarion#2431 (owner decision 4): a parent turn the runner starts itself closes
    // every open timer, so the timer cannot wake a second turn after it. The turn's own end decides
    // what it waits on next: a new monitoring line or wait, else the no-wait nudge.
    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.running });
    expect(monitoringWakeOf(fixture.store.getRun(record.id))).toBeUndefined();
    expect(monitoringTimerWait(fixture.store.getRun(record.id))).toBeUndefined();
    expect(fixture.store.getRun(record.id)?.lastWaits?.filter(wait => wait.kind === WAIT_KIND.timer).map(wait => wait.phase)).toEqual([WAIT_PHASE.cancelled]);
    expect(semaphore.busy()).toBe(0);
  }, 30_000);

  it('a markerless turn-end still parks as waiting with no activity', async () => {
    const clock = fixture.observeIdleTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'just do the thing', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(clock.pending).toBe(1);
    clock.fire(clock.captured - 1);
    await waitFor(record.id, () => !fixture.manager.isActive(record.id));
    expect(fixture.store.getRun(record.id)?.status).toBe(RUN_STATUS.waiting);
    expect(fixture.store.getRun(record.id)?.finishedAt).toBeUndefined();
    expect(monitoringTimerWait(fixture.store.getRun(record.id))).toBeUndefined();
  }, 30_000);
});

describe('RunManager waiting recovery', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('does not Continue or Finish an inactive wait without durable idle-close proof', async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env.CEZ_CODEX_BIN = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs');
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', runner: 'codex', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    const surviving = [...fixtureWork(fixture.manager).liveSessions];
    fixture.manager.dispose();
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    expect(fixture.manager.finish(record.id)).toBe(false);
    expect(fixture.manager.continueRun(record.id, { text: 'resume' })).toEqual({ ok: false, error: 'cannot continue a waiting run' });
    surviving.forEach(session => session.end());
  }, 30_000);

  it('does not answer an inactive pending ask while its disposed session process is still registered', async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env.CEZ_CODEX_BIN = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs');
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', runner: 'codex', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.store.appendEvent(record.id, {
      type: 'ask.requested',
      requestId: 'persisted-question',
      questions: [{
        header: 'Choice',
        question: 'Which implementation?',
        options: [{ label: 'First' }, { label: 'Second' }],
      }],
    });
    const surviving = [...fixtureWork(fixture.manager).liveSessions];
    fixture.manager.dispose();
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    registerRunProcess(record.id, process.pid);

    expect(fixture.manager.continueRun(record.id, { text: 'answer' })).toEqual({
      ok: false,
      error: 'cannot continue a waiting run',
    });
    unregisterRunProcess(record.id);
    surviving.forEach(session => session.end());
  }, 30_000);

  it('opens a human wait at recovery for an unanswered ask the record has no wait for', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.manager.dispose();
    fixture.store.updateRun(record.id, { waits: undefined });
    const ask = fixture.store.appendEvent(record.id, { type: 'ask.requested', requestId: 'legacy-question',
      questions: [{ header: 'Choice', question: 'Which implementation?', options: [{ label: 'First' }, { label: 'Second' }] }] });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    const human = fixture.store.getRun(record.id)?.waits?.filter(wait => wait.kind === 'human' && wait.phase === 'open') ?? [];
    expect(human).toEqual([expect.objectContaining({ source: WAIT_SOURCE.agent, askSeq: ask.seq })]);
    expect(fixture.store.getRun(record.id)?.status).toBe('waiting');
    expect(deriveAttention(fixture.store.getRun(record.id)!).label).toBe('needs you');
    expect(fixture.store.readEvents(record.id).filter(event => event.type === 'ask.requested')).toHaveLength(1);
  }, 30_000);

  it('replaces an open Cezar human wait at recovery with the unanswered ask it was not replaced by', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.manager.dispose();
    const cezar = { id: '00000000-0000-4000-8000-0000000000ac', kind: WAIT_KIND.human, source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'],
      registeredAt: '2026-10-21T00:00:00.000Z', phase: WAIT_PHASE.open, turnId: 'no-wait' };
    fixture.store.updateRun(record.id, { waits: [cezar] });
    const ask = fixture.store.appendEvent(record.id, { type: 'ask.requested', requestId: 'crashed-question',
      questions: [{ header: 'Choice', question: 'Which implementation?', options: [{ label: 'First' }, { label: 'Second' }] }] });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    const human = fixture.store.getRun(record.id)?.waits?.filter(wait => wait.kind === 'human' && wait.phase === 'open') ?? [];
    expect(human).toEqual([expect.objectContaining({ source: WAIT_SOURCE.agent, askSeq: ask.seq })]);
    expect(asksQuestion(fixture.store.getRun(record.id)!)).toBe(true);
    expect(fixture.store.readEvents(record.id).filter(event => event.type === 'ask.requested')).toHaveLength(1);
  }, 30_000);

  it('settles an upgraded legacy human wait at recovery when the transcript holds its answer', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.manager.dispose();
    const ask = fixture.store.appendEvent(record.id, { type: 'ask.requested', requestId: 'answered-question',
      questions: [{ header: 'Choice', question: 'Which implementation?', options: [{ label: 'First' }, { label: 'Second' }] }] });
    fixture.store.appendEvent(record.id, { type: 'human-input-delivered', askSeq: ask.seq });
    const legacy = { id: '00000000-0000-4000-8000-0000000000aa', kind: WAIT_KIND.human, source: WAIT_SOURCE.agent, via: WAIT_VIA['ask-line'],
      registeredAt: '2026-10-21T00:00:00.000Z', phase: WAIT_PHASE.open, turnId: 'legacy' };
    fixture.store.updateRun(record.id, { waits: [legacy] });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    expect(fixture.store.getRun(record.id)?.waits?.filter(wait => wait.kind === 'human' && wait.phase === 'open') ?? []).toEqual([]);
    expect(fixture.store.getRun(record.id)?.lastWaits).toEqual(expect.arrayContaining([expect.objectContaining({ id: legacy.id })]));
    expect(fixture.store.readEvents(record.id).filter(event => event.type === 'ask.requested')).toHaveLength(1);
  }, 30_000);

  it('keeps an upgraded legacy human wait at recovery when the transcript facts cannot be read', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    fixture.manager.dispose();
    const legacy = { id: '00000000-0000-4000-8000-0000000000ab', kind: WAIT_KIND.human, source: WAIT_SOURCE.agent, via: WAIT_VIA['ask-line'],
      registeredAt: '2026-10-21T00:00:00.000Z', phase: WAIT_PHASE.open, turnId: 'legacy' };
    fixture.store.updateRun(record.id, { waits: [legacy] });
    const unreadable = vi.spyOn(fixture.store, 'knownTranscriptFacts').mockImplementation(() => undefined);
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    unreadable.mockRestore();
    expect(fixture.store.getRun(record.id)?.waits).toEqual([expect.objectContaining({ id: legacy.id, phase: WAIT_PHASE.open })]);
  }, 30_000);
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

describe('RunManager workflow remainder opening', () => {
  const fixture = setupMonitoringFixture();
  it('preserves startedAt when a resumed workflow remainder is held and requeued', async () => {
    const startedAt = '2026-09-01T00:00:00.000Z';
    const workflow: WorkflowDef = { name: 'held-remainder', source: 'file', steps: [
      { id: 'task', name: 'Task', prompt: '{{task}}' },
      { id: 'later', name: 'Later', command: 'true' },
    ] };
    const record = fixture.store.createRun({
      title: 'held remainder', task: 'task', workflow: workflow.name,
      steps: [
        { id: 'task', name: 'Task', kind: STEP_KIND.agent },
        { id: 'later', name: 'Later', kind: STEP_KIND.check },
      ],
    });
    fixture.currentId = record.id;
    fixture.store.updateRun(record.id, { startedAt });
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.done });
    fixture.store.updateRun(record.id, { workflowDef: workflow, worktree: false, runner: 'claude' });
    const pin = fixture.store.pin.bind(fixture.store);
    vi.spyOn(fixture.store, 'pin').mockImplementation((id, reason) => {
      pin(id, reason);
      if (id !== record.id || reason !== 'active') return;
      const hold = fixture.store.createRun({ title: 'account hold', task: 'hold', workflow: 'quick-task', runner: 'claude', steps: [] });
      setRunStatus(fixture.store, hold.id, RUN_STATUS.waiting, { autoResumeAt: new Date(Date.now() + 60_000).toISOString() });
    });
    await fixture.manager.recover();
    await waitForProduct(fixture.manager, fixture.store, () => fixture.store.readEvents(record.id).some(event =>
      event.type === 'note' && String(event.message).includes('held in the queue')));
    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.queued, startedAt });
  });

  it('delivers opening images when recovery resumes after checks but before the first agent', async () => {
    const openingImage: ContentBlock = {
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
    };
    let receivedImages: ContentBlock[] | undefined;
    runnerHook.runner = {
      backend: 'claude',
      specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: 'done', toolCalls: [], tokensUsed: 0 }),
      interrupt: async () => undefined,
      startSession: (spec) => {
        receivedImages = spec.images;
        return {
          result: Promise.resolve({ text: 'done', toolCalls: [], tokensUsed: 0 }),
          sendMessage: () => false,
          sendAgentMessage: () => false,
          discardQueuedMessages: () => undefined, holdsHumanInput: () => false,
          end: () => undefined,
          interrupt: () => undefined,
          open: false,
        };
      },
    };
    const workflow: WorkflowDef = { name: 'checks-before-agent', source: 'file', steps: [
      { id: 'preflight', name: 'Preflight', command: 'true' },
      { id: 'task', name: 'Task', prompt: '{{task}}' },
      { id: 'verify', name: 'Verify', command: 'true' },
    ] };
    const record = fixture.store.createRun({
      title: 'resume before agent', task: 'task', workflow: workflow.name,
      steps: [
        { id: 'preflight', name: 'Preflight', kind: STEP_KIND.check },
        { id: 'task', name: 'Task', kind: STEP_KIND.agent },
        { id: 'verify', name: 'Verify', kind: STEP_KIND.check },
      ],
    });
    fixture.currentId = record.id;
    fixture.store.updateStep(record.id, 'preflight', { status: STEP_STATUS.done, iterations: 1 });
    const imageDir = join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}-images`);
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, 'pasted-1.png'), Buffer.from('aW1hZ2U=', 'base64'));
    fixture.store.updateStep(record.id, 'task', { status: STEP_STATUS.pending });
    fixture.store.updateRun(record.id, { workflowDef: workflow, worktree: false, taskImages: [`/api/v1/runs/${record.id}/images/pasted-1.png`] });
    await fixture.manager.recover();
    await waitForProduct(fixture.manager, fixture.store, () => !fixture.manager.isActive(record.id));

    expect(receivedImages).toEqual([openingImage]);
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

describe('cezar_ask parks as waiting and emits ask.requested (#473)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-473-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
    currentId = undefined;
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    runnerHook.runner = undefined;
    if (currentId) manager.cancel(currentId);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 15_000) =>
    waitForProduct(manager, store, () => {
      const record = store.getRun(id);
      const terminal = record && FINISHED_RUN_STATUSES.has(record.status);
      return pred(record) && (!terminal || !manager.isActive(id));
    }, ms);

  const readEvents = (id: string): Array<Record<string, unknown>> =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('a cezar_ask turn-end parks the run as waiting (attention) and emits ask.requested', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:cezar-ask which library?', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    const parked = store.getRun(record.id);
    expect(parked?.status).toBe('waiting'); // attention — NOT running/monitoring
    const asks = readEvents(record.id).filter((e) => e.type === 'ask.requested');
    expect(asks).toHaveLength(1);
    expect(typeof asks[0]!.requestId).toBe('string');
    const questions = asks[0]!.questions as Array<{ header: string; options: unknown[] }>;
    expect(questions[0]!.header).toBe('Library');
    expect(questions[0]!.options).toHaveLength(2);
  }, 30_000);

  it('a markerless turn-end raises no ask.requested', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'just do the thing', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(readEvents(record.id).some((e) => e.type === 'ask.requested')).toBe(false);
  }, 30_000);

  it('a mid-turn follow-up does not resume past a cezar_ask park', async () => {
    savedEnv.CEZ_OPENCODE_BIN = process.env.CEZ_OPENCODE_BIN;
    process.env.CEZ_OPENCODE_BIN = join(
      dirname(fileURLToPath(import.meta.url)),
      '../core/__fixtures__/opencode/mock-opencode-serve.mjs',
    );
    delete process.env.CEZ_DRY_RUN;

    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:hold-cezar-ask choose',
      runner: 'opencode',
      worktree: false,
    });
    currentId = record.id;
    await waitFor(record.id, () => {
      try {
        return readEvents(record.id).some((e) => e.type === 'turn.started');
      } catch {
        return false;
      }
    });
    expect(manager.sendMessage(record.id, [{ type: 'text', text: 'just resolve it' }])).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'waiting');

    const events = readEvents(record.id);
    expect(events.filter((e) => e.type === 'ask.requested')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1);
  }, 30_000);

  // `runContinuation`'s turn end must raise the card as `runAgentStep`'s does: AGENTS.md's standing
  // warning that a lifecycle change applied to one of them ships half a fix.
  it('a cezar_ask on a continuation turn raises one card on the continuation step', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'do the first thing', worktree: false });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true); // continueRun only accepts a terminal run
    await waitFor(record.id, (r) => ['done', 'review'].includes(r?.status ?? ''));
    expect(manager.continueRun(record.id, { text: 'mock:cezar-ask choose' })).toEqual({ ok: true });
    await waitFor(record.id, (r) => r?.status === 'waiting' && readEvents(r.id).some((e) => e.type === 'ask.requested'));

    const asks = readEvents(record.id).filter((e) => e.type === 'ask.requested');
    expect(asks).toHaveLength(1); // the first turn asked nothing
    const questions = asks[0]!.questions as Array<{ header: string; options: unknown[] }>;
    expect(questions[0]!.header).toBe('Library');
    expect(questions[0]!.options).toHaveLength(2);
    expect(String(asks[0]!.stepId)).toMatch(/^continue-/); // the continuation handler, not the step one
    expect(deriveAttention(store.getRun(record.id)!).label).toBe('needs you');
  }, 40_000);
});

describe('AttachmentWriter.persistAttachment without a session (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let attachments: AttachmentWriter;
  const PNG = Buffer.from('fake-png-bytes').toString('base64');

  const persist = (id: string, prefix?: string) =>
    attachments.persistAttachment(id, 'image/png', PNG, prefix);
  const imagesDir = (id: string) => join(repoRoot, '.ai/cezar', 'runs', `${id}-images`);

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-persist-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    attachments = new AttachmentWriter({ store, repoRoot, dataDir: join(repoRoot, '.ai/cezar'),
      work: new TrackedWork(), semaphore: new WorkspaceSemaphore(), disposed: () => false,
    }, unused('AttachmentWriter.host'));
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('persists two attachments with no ActiveRun and gives them distinct names', () => {
    const first = persist('run-a', 'pasted');
    const second = persist('run-a', 'pasted');
    expect(first?.name).toBe('pasted-1.png');
    expect(second?.name).toBe('pasted-2.png');
    expect(first?.url).toBe('/api/v1/runs/run-a/images/pasted-1.png');
  });

  /** The count-based bug this replaces: one file on disk named `pasted-3.png` is a
   *  count of 1, so a counting seed would issue `pasted-2.png` — a number BELOW a
   *  live one. Seeding from the highest suffix yields 4. */
  it('seeds from the highest existing suffix, not the file count', () => {
    mkdirSync(imagesDir('run-b'), { recursive: true });
    writeFileSync(join(imagesDir('run-b'), 'pasted-3.png'), 'x');
    expect(persist('run-b', 'pasted')?.name).toBe('pasted-4.png');
  });

  /** `screenshot-*` and `pasted-*` share one numbering space. */
  it('shares one numbering space across screenshot- and pasted- prefixes', () => {
    mkdirSync(imagesDir('run-c'), { recursive: true });
    writeFileSync(join(imagesDir('run-c'), 'screenshot-7.png'), 'x');
    expect(persist('run-c', 'pasted')?.name).toBe('pasted-8.png');
  });

  /** A stale seed (in-memory map ahead of/behind disk) must never overwrite: the
   *  exclusive-create flag makes it retry onto the next free suffix. */
  it('retries past a pre-existing file rather than overwriting it', () => {
    mkdirSync(imagesDir('run-d'), { recursive: true });
    // Force a stale counter: the map says 0, but pasted-1 already exists.
    writeFileSync(join(imagesDir('run-d'), 'pasted-1.png'), 'original');
    attachments.queuedImageSeq.set('run-d', 0);

    const saved = persist('run-d', 'pasted');
    expect(saved?.name).toBe('pasted-2.png');
    expect(readFileSync(join(imagesDir('run-d'), 'pasted-1.png'), 'utf8')).toBe('original');
  });
});

describe('RunManager queued-stack mutators (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;
  let capacity = 0;
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
    const record = manager.startRun(WORKFLOW, { task, worktree: false });
    store.updateRun(record.id, { title: 't' });
    return store.getRun(record.id)!;
  };
  const dequeue = (id: string) => manager.cancel(id);
  const imagesDir = (id: string) => join(repoRoot, '.ai/cezar', 'runs', `${id}-images`);

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-stack-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base');
    await run('git', ['add', 'base.txt'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    capacity = 0;
    semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 0 }, load: async () => ({ maxParallel: capacity, memoryLimitMb: null }) });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, { semaphore });
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    runnerHook.runner = undefined;
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
    const r = store.createRun({ title: 'interrupted task', workflow: 'quick-task', task: 'original recovery goal',
      steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
    setRunStatus(store, r.id, RUN_STATUS.done, { worktree: false });
    store.updateStep(r.id, 'task', { sessionId: 'session-interrupted', backend: 'claude' });
    expect(manager.continueRun(r.id, { text: 'restart recovery' }, true)).toEqual({ ok: true });

    expect(manager.editTask(r.id, 'amended recovery goal')).toBe(true);
    expect(
      manager.enqueueMessage(r.id, [image(), { type: 'file', mediaType: 'text/markdown', data: Buffer.from('# queued brief').toString('base64') }, { type: 'text', text: 'also verify the queue' }]),
    ).not.toBeNull();

    let delivered: AgentRunSpec | undefined;
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => undefined,
      startSession: spec => {
        delivered = spec;
        return { result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
          sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => undefined,
          holdsHumanInput: () => false, end: () => undefined, interrupt: () => undefined, open: false };
      },
    };
    capacity = 1;
    await semaphore.refresh();
    await semaphore.release();
    await waitForProduct(manager, store, () => !!delivered);
    expect(delivered?.userPrompt).toContain(
      'restart recovery\n\nCurrent task and queued updates:\n\n' +
        'amended recovery goal\n\nalso verify the queue',
    );
    expect(delivered?.images).toEqual([image()]);
    expect(delivered?.userPrompt).toContain(join(imagesDir(r.id), 'pasted-1.png'));
    expect(delivered?.userPrompt).toContain(join(imagesDir(r.id), 'pasted-2.md'));
    expect(readdirSync(imagesDir(r.id)).sort()).toEqual(['pasted-1.png', 'pasted-2.md']);
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

  async function launchDeferred(record: RunRecord, beforeSession: () => void = () => undefined) {
    const delivered: ContentBlock[][] = [];
    let session!: AgentSession;
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => undefined,
      startSession: () => {
        beforeSession();
        let finish!: (result: AgentRunResult) => void;
        let open = true;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
        session = { result, sendMessage: content => { delivered.push(content); return true; },
          sendAgentMessage: async content => { delivered.push(content); },
          discardQueuedMessages: () => undefined, holdsHumanInput: () => false,
          end: close, interrupt: close, get open() { return open; } };
        return session;
      },
    };
    capacity = 1;
    await semaphore.refresh();
    await semaphore.release();
    await waitForProduct(manager, store, () => !!session && delivered.length === 1);
    expect(store.readEvents(record.id).some(event => event.type === 'user-message')).toBe(true);
    return { delivered, session };
  }

  it('defers a message only while the run is starting up', async () => {
    const r = seedQueued();
    expect(manager.deferMessage(r.id, text('nope'))).toBe(false);
    const pin = store.pin.bind(store);
    vi.spyOn(store, 'pin').mockImplementation((id, reason) => {
      pin(id, reason);
      if (id === r.id && reason === 'active') expect(manager.deferMessage(id, text('buffer me'))).toBe(true);
    });
    const { delivered } = await launchDeferred(r);
    expect(delivered).toEqual([text('buffer me')]);
  });

  it('still defers after starting is cleared but before the session opens', async () => {
    const r = seedQueued();
    const { delivered } = await launchDeferred(r, () => {
      expect(manager.deferMessage(r.id, text('mid-spawn'))).toBe(true);
    });
    expect(delivered).toEqual([text('mid-spawn')]);
  });

  it('re-buffers a deferred message the session refuses, instead of dropping it', () => {
    const r = seedQueued();
    let accepts = false;
    const delivered: Array<Parameters<RunManager['sendMessage']>[1]> = [];
    const queuedInput = new QueuedInput({ store, repoRoot, dataDir: join(repoRoot, '.ai/cezar'),
      work: new TrackedWork(), semaphore, disposed: () => false,
    }, unused<ConstructorParameters<typeof QueuedInput>[1]>('QueuedInput.host', {
      startingHas: () => true, activeGet: () => undefined,
      canProceedWithRun: (_id, run): run is RunRecord => run !== undefined,
      sendMessage: (_id, content) => { if (accepts) delivered.push(content); return accepts; },
    }));
    expect(queuedInput.deferMessage(r.id, text('buffer me'))).toBe(true);
    queuedInput.flushDeferred(r.id);
    expect(delivered).toEqual([]);
    accepts = true;
    queuedInput.flushDeferred(r.id);
    expect(delivered).toEqual([text('buffer me')]);
    queuedInput.flushDeferred(r.id);
    expect(delivered).toHaveLength(1);
  });

  it('stops deferring once a session has opened (a closed session is a real 409)', async () => {
    const r = seedQueued();
    const { session } = await launchDeferred(r, () => {
      expect(manager.deferMessage(r.id, text('opening message'))).toBe(true);
    });
    session.end();
    expect(manager.deferMessage(r.id, text('too late'))).toBe(false);
  });
});

describe('QueuedInput.hydrateQueuedInput (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let queuedInput: QueuedInput;

  const hydrate = (id: string, task: string) =>
    queuedInput.hydrateQueuedInput(id, { task });

  const stack = (id: string, ...messages: Array<{ text: string; images?: string[] }>) =>
    store.updateRun(id, {
      queuedMessages: messages.map((m, i) => ({
        id: `m${i}`,
        text: m.text,
        ...(m.images ? { images: m.images } : {}),
        createdAt: `2026-07-21T10:0${i}:00.000Z`,
      })),
    });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-hydrate-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    queuedInput = new QueuedInput({ store, repoRoot, dataDir: join(repoRoot, '.ai/cezar'),
      work: new TrackedWork(), semaphore: new WorkspaceSemaphore(), disposed: () => false,
    }, unused('QueuedInput.host'));
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('folds the task and every stacked message, in order, blank-line joined', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'build the thing', steps: [] });
    stack(r.id, { text: 'also update the changelog' }, { text: 'and bump the version' });

    expect(hydrate(r.id, r.task).task).toBe(
      'build the thing\n\nalso update the changelog\n\nand bump the version',
    );
  });

  it('leaves the input untouched when nothing is stacked', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'build the thing', steps: [] });
    expect(hydrate(r.id, r.task).task).toBe('build the thing');
  });

  /**
   * The compounding guard. Hydration composes from `run.task` + the stack and
   * never writes the folded string back, so a restart cannot re-append. Without
   * this rule every recovery would grow the prompt without bound.
   */
  it('never writes the folded prompt back to the record, and is idempotent', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'build the thing', steps: [] });
    stack(r.id, { text: 'also update the changelog' });

    const once = hydrate(r.id, r.task).task;
    const twice = hydrate(r.id, r.task).task;
    const thrice = hydrate(r.id, hydrate(r.id, r.task).task).task;

    expect(twice).toBe(once);
    // Even feeding an already-folded string back in yields the same result —
    // the helper reads `run.task`, not whatever `input.task` happens to hold.
    expect(thrice).toBe(once);
    // …and the record itself is byte-identical to what the user typed.
    expect(store.getRun(r.id)?.task).toBe('build the thing');
    expect(store.getRun(r.id)?.queuedMessages).toHaveLength(1);
  });

  it('re-encodes stacked attachments from disk into stackedImages', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'look at this', steps: [] });
    const dir = join(repoRoot, '.ai/cezar', 'runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pasted-1.png'), 'the-bytes');
    stack(r.id, { text: 'see the mock', images: [`/api/v1/runs/${r.id}/images/pasted-1.png`] });

    const images = hydrate(r.id, r.task).stackedImages;
    expect(images).toHaveLength(1);
    expect(images?.[0]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/png', data: Buffer.from('the-bytes').toString('base64') },
    });
  });

  it.each(['pasted-1.png', 'pasted-1.pdf'])('excludes outside symlinks from restart hydration: %s', (name) => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'keep text', steps: [] });
    const dir = join(repoRoot, '.ai/cezar/runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    const outside = join(repoRoot, 'outside');
    writeFileSync(outside, 'outside-secret');
    symlinkSync(outside, join(dir, name));
    store.updateRun(r.id, { taskImages: [`/api/v1/runs/${r.id}/images/${name}`] });
    const hydrated = hydrate(r.id, r.task);
    expect(hydrated.images).toBeUndefined();
    expect(hydrated.task).toBe('keep text');
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes(name))).toBe(true);
  });

  it('notes an unreadable document instead of advertising its path on recovery', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'keep text', steps: [] });
    const dir = join(repoRoot, '.ai/cezar/runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'pasted-1.pdf');
    // A directory is never a document, including for users that bypass file permissions.
    mkdirSync(path);
    expect(resolveAttachmentPath(join(repoRoot, '.ai/cezar'), r.id, 'pasted-1.pdf')).toBeNull();
    store.updateRun(r.id, { taskImages: [`/api/v1/runs/${r.id}/images/pasted-1.pdf`] });
    expect(hydrate(r.id, r.task).task).toBe('keep text');
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes('pasted-1.pdf'))).toBe(true);
  });

  it('re-encodes initial task images from disk after a queued-run restart (#612)', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'look at this', steps: [] });
    const dir = join(repoRoot, '.ai/cezar', 'runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pasted-1.png'), 'the-task-bytes');
    store.updateRun(r.id, { taskImages: [`/api/v1/runs/${r.id}/images/pasted-1.png`] });

    expect(hydrate(r.id, r.task).images).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('the-task-bytes').toString('base64'),
        },
      },
    ]);
  });

  /**
   * #950 — the re-read branches on the NAME, not on the list. A `.pdf` sitting in the same
   * `images` list as a screenshot must come back as a path only: re-encoding it into a base64
   * image block would compose a message no backend can accept, and would put the whole document
   * into the prompt on the one path (restart) where nobody is watching.
   */
  it('never re-encodes a non-image attachment into an image block on restart', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'read the brief', steps: [] });
    const dir = join(repoRoot, '.ai/cezar', 'runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pasted-1.png'), 'the-task-bytes');
    writeFileSync(join(dir, 'pasted-2.pdf'), '%PDF-1.4 the-document-bytes');
    store.updateRun(r.id, {
      taskImages: [
        `/api/v1/runs/${r.id}/images/pasted-1.png`,
        `/api/v1/runs/${r.id}/images/pasted-2.pdf`,
      ],
    });

    const images = hydrate(r.id, r.task).images;
    expect(images).toHaveLength(1);
    expect(images?.[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
    expect(JSON.stringify(images)).not.toContain(Buffer.from('%PDF-1.4 the-document-bytes').toString('base64'));
  });

  /** Degrade, never fail the boot (AGENTS.md). */
  it('skips an unreadable attachment, notes it, and still starts', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'look at this', steps: [] });
    stack(r.id, { text: 'see the mock', images: [`/api/v1/runs/${r.id}/images/gone-1.png`] });

    const hydrated = hydrate(r.id, r.task);
    expect(hydrated.task).toBe('look at this\n\nsee the mock');
    expect(hydrated.stackedImages).toBeUndefined();
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes('gone-1.png'))).toBe(true);
  });

  /** A file has no bytes to fail on — it is only ever `stat`ed — so it needs its own case: a
   *  deleted `.md` must be dropped and noted, not handed to the agent as a path to nothing. */
  it('notes a non-image attachment whose file is gone instead of naming a dead path', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'read the brief', steps: [] });
    stack(r.id, { text: 'see the brief', images: [`/api/v1/runs/${r.id}/images/pasted-7.md`] });

    const hydrated = hydrate(r.id, r.task);
    expect(hydrated.stackedImages).toBeUndefined();
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes('pasted-7.md'))).toBe(true);
  });
});

describe('queued stacking reaches the backend (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;
  const savedEnv: Record<string, string | undefined> = {};

  const WORKFLOW: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  };

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-472-e2e-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, { semaphore });
  });

  afterAll(async () => {
    await drainFixtureManagers(repoRoot);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('delivers the task plus every stacked message, with the edit applied', async () => {
    const first = manager.startRun(WORKFLOW, { task: 'mock:cezar-done occupy the slot', worktree: false });
    await waitForProduct(manager, store, () => store.getRun(first.id)?.status === RUN_STATUS.running && semaphore.busy() === 1);
    const second = manager.startRun(WORKFLOW, { task: 'mock:cezar-done original prompt', worktree: false });

    // Wait for the scheduler's owned capacity check, not only startRun's initial queued record.
    await waitForProduct(manager, store, () => ![...fixtureWork(manager).pending.values()].includes('pump'));

    // The second run is holding in the queue — amend it there.
    expect(store.getRun(second.id)?.status).toBe('queued');
    const typo = manager.enqueueMessage(second.id, [{ type: 'text', text: 'STACKEDONE with a typo' }]);
    expect(typo).not.toBeNull();
    manager.enqueueMessage(second.id, [{ type: 'text', text: 'STACKEDTWO' }]);
    // …and fix the first one before it starts.
    manager.editQueuedMessage(second.id, typo!.id, { text: 'STACKEDONE corrected' });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    await waitForProduct(manager, store, () => terminal.has(store.getRun(second.id)?.status ?? '') && !manager.isActive(second.id), 40_000);

    // The mock records the head of each session's userText, one line per spawned
    // session. The second run's line must carry the folded prompt.
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    const line = notes.find((n) => n.includes('original prompt'));
    expect(line).toBeDefined();
    expect(line).toContain('STACKEDONE corrected');
    expect(line).toContain('STACKEDTWO');
    // The typo never reached the backend.
    expect(line).not.toContain('with a typo');
    // Order is preserved: task, then the stack.
    expect(line!.indexOf('original prompt')).toBeLessThan(line!.indexOf('STACKEDONE corrected'));
    expect(line!.indexOf('STACKEDONE corrected')).toBeLessThan(line!.indexOf('STACKEDTWO'));

    // And the record still holds the two parts separately — never the folded string.
    expect(store.getRun(second.id)?.task).toBe('mock:cezar-done original prompt');
    expect(store.getRun(second.id)?.queuedMessages).toHaveLength(2);
  }, 60_000);
});

describe('recover() carries the queued stack exactly once (#472)', () => {
  let repoRoot: string;
  let store: RunStore;

  const WORKFLOW = {
    name: '(planned)',
    source: 'built-in' as const,
    steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base');
    await run('git', ['add', 'base.txt'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    runnerHook.runner = undefined;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('folds once across repeated recoveries', async () => {
    const r = store.createRun({ title: 't', workflow: '(planned)', task: 'the original task', steps: [] });
    setRunStatus(store, r.id, RUN_STATUS.queued, { workflowDef: WORKFLOW, worktree: false, queuedMessages: [
        { id: 'm1', text: 'the stacked bit', createdAt: '2026-07-21T10:00:00.000Z' },
      ] });

    const expected = 'the original task\n\nthe stacked bit';
    let capacity = 0;
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 0 }, load: async () => ({ maxParallel: capacity, memoryLimitMb: null }) });
    let delivered: AgentRunSpec | undefined;
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => undefined,
      startSession: spec => {
        delivered = spec;
        return { result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
          sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => undefined,
          holdsHumanInput: () => false, end: () => undefined, interrupt: () => undefined, open: false };
      },
    };
    let manager!: RunManager;
    // Two successive restarts, each re-adopting the same record.
    for (let restart = 0; restart < 2; restart += 1) {
      manager = createFixtureManager(store, repoRoot, { semaphore });
      // Keep each recovered task queued until both restarts have rebuilt its input.
      await manager.recover();
      expect(store.getRun(r.id)?.status).toBe(RUN_STATUS.queued);
      // The record is never rewritten — that is what stops the compounding.
      expect(store.getRun(r.id)?.task).toBe('the original task');
      if (restart === 0) manager.dispose();
    }
    capacity = 1;
    await semaphore.refresh();
    await semaphore.release();
    await waitForProduct(manager, store, () => !!delivered);
    expect(delivered?.userPrompt).toContain(expected);
    expect(delivered?.userPrompt?.split('the stacked bit')).toHaveLength(2);
    expect(store.getRun(r.id)?.task).toBe('the original task');
  });
});

describe('native Codex requestUserInput parks and resumes the run (#565)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedCodexBin = process.env.CEZ_CODEX_BIN;
  const workflow: WorkflowDef = {
    name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-565-'));
    delete process.env.CEZ_DRY_RUN;
    // Resolved from this file, not the cwd: the fixture is a sibling of the source under test,
    // so the path holds wherever vitest is invoked from and survives the tree moving.
    process.env.CEZ_CODEX_BIN = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs');
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
    if (runId) manager.cancel(runId);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN; else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedCodexBin === undefined) delete process.env.CEZ_CODEX_BIN; else process.env.CEZ_CODEX_BIN = savedCodexBin;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = (predicate: () => boolean, ms = 15_000) => waitForProduct(manager, store, predicate, ms);

  it('persists the ask, parks immediately, then routes the answer to the pending RPC', async () => {
    const record = manager.startRun(workflow, {
      task: 'mock:native-codex-ask choose a library', runner: 'codex', worktree: false,
    });
    runId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'waiting');
    const eventsPath = join(repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`);
    expect(readFileSync(eventsPath, 'utf8')).toContain('"type":"ask.requested"');
    expect(manager.sendMessage(record.id, [{ type: 'text', text: 'Library: Vitest' }])).toBe(true);
    // The native turn-end precedes the committed park (hearsay-tools/cezarion#1641).
    // Controlled ordering proof: .ai/specs/2026-10-27-native-codex-park-proof.md.
    await waitFor(() => readFileSync(eventsPath, 'utf8').includes('"type":"turn-end"')
      && store.getRun(record.id)?.status === RUN_STATUS.waiting);
    expect(store.getRun(record.id)?.status).toBe('waiting');
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
