import { testHome } from '../home/test-home.testkit.ts';
import { runnerHook, run, GIT_ID, waitForProduct, setupMonitoringFixture, FINISHED_RUN_STATUSES } from './run-fixture.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentRunResult, type AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { type WorkflowDef } from './types.ts';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { monitoringTimerWait, monitoringWakeOf } from './waits.testkit.ts';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { fileURLToPath } from 'node:url';

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
        task: 'mock:request-error', runner: 'claude', worktree: false,
      });
      await waitForProduct(manager, store, () => store.getRun(record.id)?.status === 'failed');
      expect(store.getRun(record.id)?.costUsd).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = previous;
    }
  }, 30_000);
});

describe('RunManager monitoring turns', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('nested Codex subagent items after park do not unpark monitoring (#121)', async () => {
    fixture.manager.dispose();
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxMonitoringSessions: 1, monitoringWakeIntervalMinutes: 0.01 } });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot, { home: testHome(), semaphore });
    const clock = fixture.observeWakeTimers();
    const competing = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup competing park', runner: 'claude' });
    await waitFor(competing.id, (r) => r?.status === 'waiting' && Boolean(monitoringWakeOf(r)));
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
    expect(semaphore.busy()).toBe(1);

    clock.fire(clock.captured - 1);
    await waitFor(record.id, () => {
      const events = readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8');
      return events.includes('automatic monitoring wake-up (1/40)');
    });
    fixture.manager.cancel(competing.id);
  }, 30_000);

  it('parent turn.started after park still unparks monitoring (#61, #121)', async () => {
    fixture.manager.dispose();
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxMonitoringSessions: 1, monitoringWakeIntervalMinutes: 0.02 } });
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot, { home: testHome(), semaphore });
    fixture.observeWakeTimers();
    const competing = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup competing park', runner: 'claude' });
    await waitFor(competing.id, (r) => r?.status === 'waiting' && Boolean(monitoringWakeOf(r)));
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:schedule-wakeup keep going', runner: 'claude', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(monitoringWakeOf(r)));

    expect(semaphore.busy()).toBe(1);
    runnerHook.uiEvent({ type: 'turn.started', turnId: 'turn_parent_resume' });
    fixture.manager.cancel(competing.id);
    await waitFor(competing.id, () => !fixture.manager.isActive(competing.id));

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
