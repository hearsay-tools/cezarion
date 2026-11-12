import { observationClock } from '../core/observation-clock.testkit.ts';
import * as runners from '../core/runner-factory.ts';
import type { AgentSession, SessionOptions } from '../core/agent-runner.ts';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { WAIT_LIMIT, type SubagentWaitEntry, type Wait } from '@open-mercato/cezar-contract/waits';
import { makePeerWait, RUN_STATUS, SUBAGENT_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { ToolStatus, UiEvent, UiToolItem } from '../core/ui-events.ts';
import { IDLE_TIMEOUT_MS, MAX_AUTO_CONTINUES } from './run.ts';
import { stateOf } from './run-states.ts';
import { NO_WAIT_NUDGE_NOTE } from './turn-end.ts';
import { controlledWire, manager, parent, restart, root, store, semaphore, work, toolGenerationOf, worker, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';

/**
 * Squawk's wait on native subagents (hearsay-tools/cezarion#2431): one test per `waiting:subagents`
 * row of its Transitions out table, on the controlled Claude wire. The runner's own mapping of a
 * backgrounded child is the parity cells' (`waits-subagents-parity-cells.testkit.ts` U30–U37); here the
 * child's UI events reach the engine through the same handler the runners feed.
 */

let idleClock: ReturnType<typeof observationClock>;
const callbacks = new Map<string, SessionOptions>();
const sessions = new Map<string, AgentSession>();
function useSubagentFixture(options: Parameters<typeof useWorkerWaitFixture>[0]) {
  useWorkerWaitFixture(options);
  beforeEach(() => {
    callbacks.clear();
    sessions.clear();
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
    idleClock = observationClock(delay => delay === IDLE_TIMEOUT_MS && /armIdleTimer/.test(new Error().stack ?? ''));
    const create = runners.createRunner;
    vi.spyOn(runners, 'createRunner').mockImplementation((...args) => {
      const runner = create(...args);
      const start = runner.startSession.bind(runner);
      vi.spyOn(runner, 'startSession').mockImplementation((spec, event, options) => {
        callbacks.set(spec.env!.CEZ_TASK_ID!, options ?? {});
        const session = start(spec, event, options);
        sessions.set(spec.env!.CEZ_TASK_ID!, session);
        return session;
      });
      return runner;
    });
  });
  afterEach(() => { idleClock.restore(); vi.restoreAllMocks(); });
}
async function noIdleClose(id: string) {
  await idleClock.advance(IDLE_TIMEOUT_MS);
  expect(manager.isActive(id)).toBe(true);
  expect(sessions.get(id)?.open).toBe(true);
}
async function besideWait(runId: string, kind: 'peer' | 'worker') {
  if (kind === 'worker') {
    const child = await worker(runId);
    manager.registerWorkerListWait(runId, { workerIds: [child.id], timeoutSeconds: 600 }, 'cezar_wait');
  } else {
    const peer = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', steps: [], runner: 'claude' });
    const result = await manager.squawkToolHandlers(runId, toolGenerationOf(runId)).registerWait({ kind: WAIT_KIND.peer, peer_ids: [peer.id] }, 'cezar_wait', new AbortController().signal);
    expect(result.answer.ok).toBe(true);
  }
}
const entryOf = (runId: string, waitId: string): Wait | undefined => store.getRun(runId)?.waits?.find(wait => wait.id === waitId);
const settledOf = (runId: string, waitId: string): Wait | undefined => store.getRun(runId)?.lastWaits?.filter(wait => wait.id === waitId).at(-1);
const subagentWait = (runId: string): SubagentWaitEntry | undefined =>
  store.getRun(runId)?.waits?.find((wait): wait is SubagentWaitEntry => wait.kind === WAIT_KIND.subagent && wait.phase === WAIT_PHASE.open);
const turnEnds = (runId: string) => store.readEvents(runId).filter(event => event.type === 'turn-end').length;
/** Wakes the waits spent: the record's count less the no-wait nudges, which the controlled wire's
 *  markerless reply to a wake earns as any turn end without a wait does. */
const nudges = (runId: string) => store.readEvents(runId).filter(event => event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE)).length;
const wakes = (runId: string) => (store.getRun(runId)?.automaticWakes ?? 0) - nudges(runId);
const inputsNaming = (runId: string, text: string) => (store.getRun(runId)?.agentInputs ?? []).filter(input => input.text.includes(text));

/** The background children's `item.completed` events: id, status, title and step. */
const backgroundEnds = (runId: string) => store.readEvents(runId).filter(event => event.type === 'item.completed' && (event.item as UiToolItem | undefined)?.background === true)
  .map(event => [(event.item as UiToolItem).id, (event.item as UiToolItem).status, (event.item as UiToolItem).title, event.stepId]);
/** The step a child's `item.started` was recorded under. */
const startStep = (runId: string, childId: string) => store.readEvents(runId).find(event => event.type === 'item.started' && (event.item as UiToolItem | undefined)?.id === childId)?.stepId;

/** A backgrounded native subagent's root task item, as a runner mapper marks it. */
const child = (id: string, status: ToolStatus, background = true): UiToolItem => ({
  kind: 'tool', id, name: 'Agent', toolKind: 'task', title: `Background research ${id}`, status, ...(background ? { background: true as const } : {}),
});

/** One UI event, through the handler every runner's `onUiEvent` reaches. */
function emitUi(runId: string, event: UiEvent): void {
  const callback = callbacks.get(runId)?.onUiEvent;
  if (!callback) throw new Error(`No runner callback for ${runId}`);
  callback(event);
}
const startChild = (runId: string, id: string) => emitUi(runId, { type: 'item.started', item: child(id, 'running') });
const endChild = (runId: string, id: string, status: ToolStatus = 'completed') => emitUi(runId, { type: 'item.completed', item: child(id, status, false) });

/** A parent whose first turn is held until `release()`: children start inside it. */
async function heldParent(humanAnswerGate?: string, task?: string) {
  const gate = join(root, `release-${randomUUID()}`);
  const wire = controlledWire({ firstResultGate: gate, replay: true, ...(humanAnswerGate ? { humanAnswerGate } : {}) });
  const run = await parent(task); await until(wire.initialReceived);
  return { run, release: () => writeFileSync(gate, 'release') };
}

/** A parent parked on the subagent wait for `children` running native subagents. */
async function parkedOnSubagents(children = ['toolu_bg_01'], beforeRelease?: (runId: string) => Promise<void>, humanAnswerGate?: string) {
  const { run, release } = await heldParent(humanAnswerGate);
  for (const id of children) startChild(run.id, id);
  await beforeRelease?.(run.id);
  release();
  await until(() => store.getRun(run.id)?.status === RUN_STATUS.waiting && subagentWait(run.id) !== undefined);
  return { id: run.id, wait: subagentWait(run.id)! };
}

describe('the subagent wait (hearsay-tools/cezarion#2431)', () => {
  useSubagentFixture({ subagentGraceMs: 50 });

  it('running → waiting:subagents: the turn end parks on the subagent wait with no timer and no wake spent', async () => {
    const { id, wait } = await parkedOnSubagents();
    const run = store.getRun(id)!;
    expect(stateOf(run)).toBe('waiting:subagents');
    expect(deriveAttention(run)).toMatchObject({ rung: 'waiting-on-subagents', label: 'waiting for 1 subagent', pulse: false, shape: 'workers' });
    expect(wait).toMatchObject({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['native-subagents'], children: [{ id: 'toolu_bg_01', status: SUBAGENT_STATUS.running }] });
    expect(run.waits?.filter(entry => entry.kind === WAIT_KIND.timer)).toEqual([]);
    expect(wakes(id)).toBe(0);
    // It keeps its session and a monitoring slot, so the idle close never applies.
    expect(semaphore.busy()).toBe(1);
    await noIdleClose(id);
    expect(store.readEvents(id).some(event => event.type === 'note' && String(event.message).startsWith('no wait or done'))).toBe(false);
  });

  for (const kind of ['peer', 'worker'] as const) {
    it(`a ${kind} wait beside the subagent wait still keeps the session and its slot, with no idle close`, async () => {
      const { id } = await parkedOnSubagents(['toolu_bg_01'], async runId => {
        await besideWait(runId, kind);
      });
      // The other wait ranks first for display; the native child still needs this session.
      expect(semaphore.busy()).toBe(1);
      await noIdleClose(id);
      expect(sessions.get(id)?.open).toBe(true);
    });
  }

  it('the last child ending wakes the parent once after the grace and spends no wake', async () => {
    const { id, wait } = await parkedOnSubagents(['toolu_bg_01', 'toolu_bg_02']);
    expect(deriveAttention(store.getRun(id)!).label).toBe('waiting for 2 subagents');
    const turns = turnEnds(id);
    endChild(id, 'toolu_bg_01');
    // One child still runs: the wait saves the end, reads 1, and stays open.
    expect(entryOf(id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open, children: [{ id: 'toolu_bg_02', status: SUBAGENT_STATUS.running }, { id: 'toolu_bg_01', status: SUBAGENT_STATUS.completed }] });
    expect(deriveAttention(store.getRun(id)!).label).toBe('waiting for 1 subagent');
    endChild(id, 'toolu_bg_02');
    await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.delivered && turnEnds(id) > turns && store.getRun(id)?.status === RUN_STATUS.waiting);
    expect(settledOf(id, wait.id)).toMatchObject({ result: { reason: 'settled' } });
    expect(inputsNaming(id, `Subagent wait ${wait.id}`)).toEqual([expect.objectContaining({ deliveredAt: expect.any(String) })]);
    expect(inputsNaming(id, `Subagent wait ${wait.id}`)[0]!.text).toContain('toolu_bg_01 completed, toolu_bg_02 completed');
    // The wake turn, and the reply to the nudge its markerless end earns.
    expect(turnEnds(id)).toBe(turns + 1 + nudges(id));
    expect(wakes(id)).toBe(0);
  });

  for (const [status, reads] of [['failed', 'failed'], ['declined', 'cancelled']] as const) {
    it(`a child that ends ${reads} wakes the parent once and spends no wake`, async () => {
      const { id, wait } = await parkedOnSubagents();
      endChild(id, 'toolu_bg_01', status);
      await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.delivered);
      expect(settledOf(id, wait.id)).toMatchObject({ result: { reason: 'settled' }, children: [{ id: 'toolu_bg_01', status: reads }] });
      expect(inputsNaming(id, `Subagent wait ${wait.id}`)[0]!.text).toContain(`toolu_bg_01 ${reads}`);
      expect(wakes(id)).toBe(0);
    });
  }

  it('a child that starts during the grace voids it, and its own end gets a full grace', async () => {
    const { id, wait } = await parkedOnSubagents();
    endChild(id, 'toolu_bg_01');
    await new Promise(resolve => setTimeout(resolve, 30)); // bound: part of the 50 ms grace passes before the next child
    startChild(id, 'toolu_bg_02');
    endChild(id, 'toolu_bg_02');
    const lastEnd = Date.now();
    await until(() => settledOf(id, wait.id)?.resolvedAt !== undefined);
    // A timer can fire late under load, never early: the wake waits a full grace after the last end.
    expect(Date.parse(settledOf(id, wait.id)!.resolvedAt!) - lastEnd).toBeGreaterThanOrEqual(45);
  });

  it('a parent turn that starts in the grace sees the ends itself: no settled wake, its turn end cancels the wait', async () => {
    const gate = join(root, `human-${randomUUID()}`);
    const { id, wait } = await parkedOnSubagents(['toolu_bg_01'], undefined, gate);
    endChild(id, 'toolu_bg_01');
    expect(manager.sendMessage(id, [{ type: 'text', text: 'human answer mock:hold' }])).toBe(true);
    await until(() => store.getRun(id)?.status === RUN_STATUS.running);
    await new Promise(resolve => setTimeout(resolve, 150)); // bound: outlasts the 50 ms grace while the human's turn is held
    expect(entryOf(id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open });
    writeFileSync(gate, 'release');
    await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.cancelled);
    expect(inputsNaming(id, `Subagent wait ${wait.id}`)).toEqual([]);
  });

  it('a child end whose checkpoint fails starts no grace, so no wake settles a stale snapshot', async () => {
    const deadline = observationClock(() => /WaitEngine\.armWait/.test(new Error().stack ?? ''));
    const { id, wait } = await parkedOnSubagents();
    const commit = vi.spyOn(store, 'commitWait').mockImplementationOnce(() => { throw Error('injected: disk full'); });
    endChild(id, 'toolu_bg_01');
    expect(commit).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 150)); // bound: outlasts the 50 ms grace
    // The saved wait still reads the child running; its armed deadline is the fallback.
    expect(entryOf(id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open, children: [{ id: 'toolu_bg_01', status: SUBAGENT_STATUS.running }] });
    expect(deadline.pending).toBe(1);
    expect(inputsNaming(id, 'Subagent wait')).toEqual([]);
  });

  it('a runner resume whose cancellation fails keeps every wait open and armed', async () => {
    const deadline = observationClock(() => /WaitEngine\.armWait/.test(new Error().stack ?? ''));
    const { id, wait } = await parkedOnSubagents();
    const real = store.commitOutcome.bind(store);
    const commit = vi.spyOn(store, 'commitOutcome').mockImplementation((runId, outcome, ...rest) => {
      if (!Array.isArray(outcome) && (outcome as { kind?: string }).kind === 'cancelled') throw Error('injected: disk full');
      return real(runId, outcome, ...rest);
    });
    emitUi(id, { type: 'turn.started', turnId: 'turn_runner' });
    expect(commit.mock.calls.some(([, outcome]) => !Array.isArray(outcome) && (outcome as { kind?: string }).kind === 'cancelled')).toBe(true);
    commit.mockRestore();
    expect(entryOf(id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open });
    expect(deadline.pending).toBe(1);
  });

  it('a question asked while the subagent wait is open keeps the session and its slot, with no idle close', async () => {
    const { id, wait } = await parkedOnSubagents();
    const turns = turnEnds(id);
    expect(manager.sendMessage(id, [{ type: 'text', text: 'mock:cezar-ask which one?' }])).toBe(true);
    await until(() => turnEnds(id) > turns && store.getRun(id)?.status === RUN_STATUS.waiting);
    expect(store.getRun(id)?.waits?.some(entry => entry.kind === WAIT_KIND.human && entry.phase === WAIT_PHASE.open)).toBe(true);
    expect(entryOf(id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open });
    expect(semaphore.busy()).toBe(1);
    await noIdleClose(id);
    expect(sessions.get(id)?.open).toBe(true);
  });

  it('a first turn that asks with children running opens the wait beside the question and keeps the session and slot', async () => {
    const { run, release } = await heldParent(undefined, 'mock:cezar-ask which one?');
    startChild(run.id, 'toolu_bg_01');
    release();
    await until(() => store.getRun(run.id)?.status === RUN_STATUS.waiting);
    // The question ranks first for the user; the wait carries the children's deadline and restart.
    expect(deriveAttention(store.getRun(run.id)!).rung).toBe('needs-you');
    expect(subagentWait(run.id)).toMatchObject({ children: [{ id: 'toolu_bg_01', status: SUBAGENT_STATUS.running }] });
    expect(semaphore.busy()).toBe(1);
    await noIdleClose(run.id);
  });

  it('a child end beside the question wakes the parent once; its park keeps the question and gives the slot back', async () => {
    const { run, release } = await heldParent(undefined, 'mock:cezar-ask which one?');
    startChild(run.id, 'toolu_bg_01');
    release();
    await until(() => store.getRun(run.id)?.status === RUN_STATUS.waiting);
    const wait = subagentWait(run.id)!;
    const turns = turnEnds(run.id);
    endChild(run.id, 'toolu_bg_01');
    await until(() => settledOf(run.id, wait.id)?.phase === WAIT_PHASE.delivered && turnEnds(run.id) > turns);
    const parked = store.getRun(run.id)!;
    expect(deriveAttention(parked).rung).toBe('needs-you');
    expect(parked.waits?.map(entry => [entry.kind, entry.phase])).toEqual([[WAIT_KIND.human, WAIT_PHASE.open]]);
    expect(inputsNaming(run.id, `Subagent wait ${wait.id}`)).toEqual([expect.objectContaining({ deliveredAt: expect.any(String) })]);
    expect(semaphore.busy()).toBe(0);
    expect(idleClock.pending).toBe(1);
    expect(wakes(run.id)).toBe(0);
  });

  it('past the child bound the saved wait keeps the latest ends, so a new child\'s end is never dropped', async () => {
    const ids = Array.from({ length: 33 }, (_, index) => `toolu_bg_${String(index).padStart(2, '0')}`);
    const { id, wait } = await parkedOnSubagents(ids);
    for (const child of ids.slice(0, 32)) endChild(id, child, 'failed');
    endChild(id, 'toolu_bg_32', 'failed');
    await until(() => settledOf(id, wait.id)?.phase !== undefined && settledOf(id, wait.id)?.phase !== WAIT_PHASE.open);
    const saved = (settledOf(id, wait.id) as SubagentWaitEntry).children.map(child => child.id);
    expect(saved).toHaveLength(32);
    expect(saved.at(-1)).toBe('toolu_bg_32');
    expect(saved).not.toContain('toolu_bg_00');
  });

  it('a duplicate child end changes nothing and wakes nothing', async () => {
    const { id, wait } = await parkedOnSubagents();
    const turns = turnEnds(id);
    endChild(id, 'toolu_bg_01');
    endChild(id, 'toolu_bg_01');
    await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.delivered && turnEnds(id) > turns && store.getRun(id)?.status === RUN_STATUS.waiting);
    const run = store.getRun(id)!;
    endChild(id, 'toolu_bg_01');
    expect(store.getRun(id)).toEqual(run);
    expect(inputsNaming(id, 'Subagent wait')).toHaveLength(1);
    expect(turnEnds(id)).toBe(turns + 1 + nudges(id));
  });

  it('a parent turn the runner starts closes the subagent wait and every timer, and takes no wake', async () => {
    let timerId = '';
    const { id, wait } = await parkedOnSubagents(['toolu_bg_01'], async runId => {
      const handlers = manager.squawkToolHandlers(runId, toolGenerationOf(runId));
      const registered = await handlers.registerWait({ kind: WAIT_KIND.timer, seconds: 600, note: 'beside the subagents' }, 'cezar_wait', new AbortController().signal);
      if (!('wait' in registered)) throw new Error('timer not registered');
      timerId = registered.wait.id;
    });
    // The subagents outrank the timer, so the park reads them.
    expect(deriveAttention(store.getRun(id)!).rung).toBe('waiting-on-subagents');
    const inputs = store.getRun(id)?.agentInputs?.length ?? 0;
    endChild(id, 'toolu_bg_01');
    emitUi(id, { type: 'turn.started', turnId: 'turn_runner' });
    expect(store.getRun(id)?.status).toBe(RUN_STATUS.running);
    expect(settledOf(id, wait.id)).toMatchObject({ phase: WAIT_PHASE.cancelled, result: { reason: 'superseded' } });
    expect(settledOf(id, timerId)).toMatchObject({ phase: WAIT_PHASE.cancelled });
    expect(store.getRun(id)?.waits ?? []).toEqual([]);
    // Past the grace no wake goes: the runner's own turn is the only one.
    await new Promise(resolve => setTimeout(resolve, 200)); // bound: proves the cancelled grace never fires
    expect(store.getRun(id)?.agentInputs?.length ?? 0).toBe(inputs);
    expect(wakes(id)).toBe(0);
  });

  it('a human message keeps the subagent wait and its timers open, and the turn end parks on it again', async () => {
    let timerId = '';
    const { id, wait } = await parkedOnSubagents(['toolu_bg_01'], async runId => {
      const handlers = manager.squawkToolHandlers(runId, toolGenerationOf(runId));
      const registered = await handlers.registerWait({ kind: WAIT_KIND.timer, seconds: 600, note: 'beside the subagents' }, 'cezar_wait', new AbortController().signal);
      if (!('wait' in registered)) throw new Error('timer not registered');
      timerId = registered.wait.id;
    });
    const turns = turnEnds(id);
    // Claude starts the turn inside Squawk's own write: that turn is the human's, not the runner's.
    expect(manager.sendMessage(id, [{ type: 'text', text: 'how is it going?' }])).toBe(true);
    await until(() => turnEnds(id) > turns && store.getRun(id)?.status === RUN_STATUS.waiting);
    expect(entryOf(id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open });
    expect(entryOf(id, timerId)).toMatchObject({ phase: WAIT_PHASE.open });
    expect(stateOf(store.getRun(id)!)).toBe('waiting:subagents');
  });

  it('children that all end before the turn ends open no wait', async () => {
    const { run, release } = await heldParent();
    startChild(run.id, 'toolu_bg_01');
    endChild(run.id, 'toolu_bg_01');
    const turns = turnEnds(run.id);
    release();
    await until(() => turnEnds(run.id) > turns);
    expect([...store.getRun(run.id)?.waits ?? [], ...store.getRun(run.id)?.lastWaits ?? []].some(entry => entry.kind === WAIT_KIND.subagent)).toBe(false);
  });

  it('a nested child item never counts as a background child', async () => {
    const { run, release } = await heldParent();
    emitUi(run.id, { type: 'item.started', item: { ...child('nested', 'running'), parentItemId: 'toolu_parent' } });
    const turns = turnEnds(run.id);
    release();
    await until(() => turnEnds(run.id) > turns);
    expect([...store.getRun(run.id)?.waits ?? [], ...store.getRun(run.id)?.lastWaits ?? []].some(entry => entry.kind === WAIT_KIND.subagent)).toBe(false);
  });

  it('a restart ends every running child in the transcript, past the wait\'s child bound', async () => {
    const ids = Array.from({ length: 33 }, (_, index) => `toolu_bg_${String(index).padStart(2, '0')}`);
    const { id, wait } = await parkedOnSubagents(ids);
    await restart();
    await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.delivered);
    expect(backgroundEnds(id).map(([child, status]) => [child, status])).toEqual(ids.map(child => [child, 'declined']));
  });

  it('a restart ends the children of a question park and resolves its subagent wait interrupted', async () => {
    const { run, release } = await heldParent(undefined, 'mock:cezar-ask which one?');
    startChild(run.id, 'toolu_bg_01');
    release();
    await until(() => store.getRun(run.id)?.status === RUN_STATUS.waiting);
    const wait = subagentWait(run.id)!;
    await restart();
    const now = () => entryOf(run.id, wait.id) ?? settledOf(run.id, wait.id);
    await until(() => backgroundEnds(run.id).length > 0 && now()?.phase !== WAIT_PHASE.open);
    expect(now()).toMatchObject({ result: { reason: 'interrupted' } });
    expect(backgroundEnds(run.id)).toEqual([['toolu_bg_01', 'declined', 'Background research toolu_bg_01', startStep(run.id, 'toolu_bg_01')]]);
  });

  it('a restart with no session resolves the wait interrupted and continues the run once, free', async () => {
    const { id, wait } = await parkedOnSubagents(['toolu_bg_01', 'toolu_bg_02']);
    await restart();
    await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.delivered && store.getRun(id)?.status === RUN_STATUS.waiting);
    expect(settledOf(id, wait.id)).toMatchObject({ result: { reason: 'interrupted' } });
    const [input, ...more] = inputsNaming(id, `Subagent wait ${wait.id}`);
    expect(more).toEqual([]);
    expect(input!.text).toContain('Cezar restarted, and the 2 native subagents still running in your last session stopped with it.');
    expect(wakes(id)).toBe(0);
    // The transcript ends each stopped child, so the activity view no longer shows it running.
    const ends = backgroundEnds(id);
    expect(ends).toEqual([['toolu_bg_01', 'declined', 'Background research toolu_bg_01', startStep(id, 'toolu_bg_01')], ['toolu_bg_02', 'declined', 'Background research toolu_bg_02', startStep(id, 'toolu_bg_02')]]);
    expect(startStep(id, 'toolu_bg_01')).toEqual(expect.any(String));
  });
});

describe('the subagent wait deadline (hearsay-tools/cezarion#2431)', () => {
  useSubagentFixture({ subagentGraceMs: 50, subagentDeadlineMs: 1_000 });

  it('an interruption whose transcript write fails keeps the wait open and retries, so the wait never outruns the activity view', async () => {
    const { id, wait } = await parkedOnSubagents();
    const real = store.appendEvent.bind(store);
    let refuse = true;
    const append = vi.spyOn(store, 'appendEvent').mockImplementation((runId, event) => {
      if (refuse && event.type === 'item.completed') { refuse = false; throw Error('injected: disk full'); }
      return real(runId, event);
    });
    [...work.liveSessions][0]!.end();
    await until(() => append.mock.calls.some(([, event]) => event.type === 'item.completed'));
    // The end did not land, so the wait still reads its children as running.
    expect(entryOf(id, wait.id)).toMatchObject({ phase: WAIT_PHASE.open });
    expect(backgroundEnds(id)).toEqual([]);
    await until(() => entryOf(id, wait.id)?.phase !== WAIT_PHASE.open || settledOf(id, wait.id) !== undefined);
    append.mockRestore();
    expect(backgroundEnds(id).map(([child, status]) => [child, status])).toEqual([['toolu_bg_01', 'declined']]);
    expect(entryOf(id, wait.id) ?? settledOf(id, wait.id)).toMatchObject({ result: { reason: 'interrupted' } });
  });

  /** A parent with its first turn held and a full wait list, so no subagent wait fits. */
  async function fullListParent() {
    const { run, release } = await heldParent();
    startChild(run.id, 'toolu_bg_01');
    for (let index = 0; index < WAIT_LIMIT; index += 1) store.commitWait(run.id, makePeerWait({ turnId: 'full' }));
    release();
    await until(() => store.getRun(run.id)?.status === RUN_STATUS.waiting);
    expect(subagentWait(run.id)).toBeUndefined();
    return run.id;
  }

  it('a full wait list leaves no room for the subagent wait, yet the park keeps the session and slot until the last child ends', async () => {
    const id = await fullListParent();
    expect(semaphore.busy()).toBe(1);
    await noIdleClose(id);
    endChild(id, 'toolu_bg_01');
    expect(semaphore.busy()).toBe(0);
    expect(idleClock.pending).toBe(1);
  });

  it('a worker-led park whose subagent wait closed early still gives its slot back when the last child ends', async () => {
    const { id, wait } = await parkedOnSubagents(['toolu_bg_01'], async runId => {
      await besideWait(runId, 'worker');
    });
    expect(semaphore.busy()).toBe(1);
    store.commitOutcome(id, { kind: 'cancelled', waitIds: [wait.id] });
    endChild(id, 'toolu_bg_01');
    expect(semaphore.busy()).toBe(0);
    expect(idleClock.pending).toBe(1);
  });

  it('a lost continuation session with no subagent wait retries a failed transcript end', async () => {
    const first = await heldParent();
    first.release();
    // bound: Continue requires the first turn to park and its runner session to close.
    await until(() => store.getRun(first.run.id)?.status === RUN_STATUS.waiting);
    sessions.get(first.run.id)!.end();
    // bound: session teardown removes the first execution before Continue can start.
    await until(() => !manager.isActive(first.run.id));
    rmSync(join(root, 'first-input-received'));
    const gate = join(root, `continue-${randomUUID()}`);
    const wire = controlledWire({ firstResultGate: gate, replay: true });
    const id = first.run.id;
    expect(manager.continueRun(id, { text: 'continue with background child' })).toMatchObject({ ok: true });
    // bound: the controlled continuation reports receiving its opening input before UI events.
    await until(wire.initialReceived);
    startChild(id, 'toolu_bg_01');
    for (let index = 0; index < WAIT_LIMIT; index += 1) store.commitWait(id, makePeerWait({ turnId: 'full' }));
    const turns = turnEnds(id);
    writeFileSync(gate, 'release');
    // bound: turn end is the public signal that the full list prevented a subagent wait.
    await until(() => turnEnds(id) > turns && store.getRun(id)?.status === RUN_STATUS.waiting);
    expect(subagentWait(id)).toBeUndefined();
    const retry = observationClock(() => /\bat SubagentWaits\.armRetry \(/.test(new Error().stack ?? ''));
    const real = store.appendEvent.bind(store);
    let refuse = true;
    const append = vi.spyOn(store, 'appendEvent').mockImplementation((runId, event) => {
      if (refuse && event.type === 'item.completed') { refuse = false; throw Error('injected: disk full'); }
      return real(runId, event);
    });
    sessions.get(id)!.end();
    // bound: dropActive runs the transcript-end attempt before removing its execution.
    await until(() => !manager.isActive(id));
    expect(refuse).toBe(false);
    expect(backgroundEnds(id)).toEqual([]);
    expect(retry.pending).toBe(1);
    retry.fire(0);
    expect(backgroundEnds(id).map(([child, status]) => [child, status])).toEqual([['toolu_bg_01', 'declined']]);
    expect(retry.pending).toBe(0);
    append.mockRestore();
  });

  it('the deadline wakes the parent and spends one wake', async () => {
    const { id, wait } = await parkedOnSubagents();
    await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.delivered && store.getRun(id)?.status === RUN_STATUS.waiting);
    expect(settledOf(id, wait.id)).toMatchObject({ result: { reason: 'timeout' } });
    expect(inputsNaming(id, `Subagent wait ${wait.id}`)[0]!.text).toContain('1 native subagent still running');
    expect(wakes(id)).toBe(1);
  });

  it('a child event moves the deadline', async () => {
    const { id, wait } = await parkedOnSubagents(['toolu_bg_01', 'toolu_bg_02']);
    await new Promise(resolve => setTimeout(resolve, 5)); // bound: the new deadline must fall on a later millisecond
    endChild(id, 'toolu_bg_01');
    expect(Date.parse((entryOf(id, wait.id) as SubagentWaitEntry).deadline)).toBeGreaterThan(Date.parse(wait.deadline));
  });

  it('the deadline with the budget spent opens the budget human wait', async () => {
    const { id, wait } = await parkedOnSubagents();
    store.commitOutcome(id, { kind: 'charged', automaticWakes: MAX_AUTO_CONTINUES });
    await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.cancelled);
    await until(() => stateOf(store.getRun(id)!) === 'waiting:human');
    expect(store.getRun(id)?.waits).toEqual([expect.objectContaining({ kind: WAIT_KIND.human, source: WAIT_SOURCE.cezar, via: WAIT_VIA.budget })]);
    expect(store.readEvents(id).some(event => event.type === 'note' && String(event.message).includes(`subagent wait ${wait.id} cancelled`))).toBe(true);
  });
});
