import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { manager, restart, root, semaphore, store, until, work } from './worker-wait.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import {
  pr,
  github,
  nativeWire,
  session,
  openWait,
  parkedOnTimers,
  fireTimer,
  turnStarted,
  turnEnds,
  waitById,
  settled,
  prompted,
  label,
  flushMicrotasks,
  notes,
  useWaitsWakeFixture,
} from './waits-wake.testkit.ts';

// hearsay-tools/cezarion#1233: the automatic-wake budget: one charge per batch, the cap, refusals and
// restarts. Shared setup: waits-wake.testkit.ts.

describe('wakes beside questions, footers and slots (hearsay-tools/cezarion#1233): automatic-wake budget', { timeout: 45_000 }, () => {
  useWaitsWakeFixture();

  it('claude two waits resolved before one boundary are delivered in one submission and charged once', async () => {
    nativeWire('claude');
    const release = join(root, 'turn-release');
    process.env.CEZ_MOCK_RELEASE_FILE = release;
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios['hold-gated']!, runner: 'claude' });
    await until(() => turnStarted(run.id));
    const first = await openWait(run.id, { kind: WAIT_KIND.timer, seconds: 60, note: 'first' });
    const second = await openWait(run.id, { kind: WAIT_KIND.timer, seconds: 60, note: 'second' });
    // Keep the wake reply parked on an unrelated wait, outside this batch's budget assertion.
    const later = await openWait(run.id, { kind: WAIT_KIND.timer, seconds: 7200, note: 'later' });
    fireTimer(first.id); fireTimer(second.id);
    await until(() => waitById(run.id, first.id)?.phase === 'resolved' && waitById(run.id, second.id)?.phase === 'resolved');
    writeFileSync(release, '');
    // The store marks the wake delivered before the mock records the prompt it read; wait for both.
    await until(() => settled(run.id, first.id)?.phase === 'delivered' && settled(run.id, second.id)?.phase === 'delivered'
      && prompted('claude', `Timer ${first.id} fired`).length > 0);
    await until(() => store.getRun(run.id)?.status === 'waiting');
    expect(waitById(run.id, later.id)?.phase).toBe('open');
    const wakes = prompted('claude', `Timer ${first.id} fired`);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(`Timer ${second.id} fired`);
    expect(wakes[0]!.indexOf(first.id)).toBeLessThan(wakes[0]!.indexOf(second.id));
    // One admitted automatic turn spends one wake of the budget, however many timers it carries.
    expect(store.getRun(run.id)?.automaticWakes).toBe(1);
    expect(notes(run.id, 'automatic timer wake-up (').map(event => event.message)).toEqual(['automatic timer wake-up (1/40)']);
  });

  it('claude staggered timers at 39 spent wakes: the first wakes at 40, the second is cancelled with the cap note and wakes nothing', async () => {
    nativeWire('claude');
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(1);
    const { run, waits: [first, second] } = await parkedOnTimers({ seconds: 60, note: 'first' }, { seconds: 120, note: 'second' });
    store.updateRun(run.id, { automaticWakes: 39 });
    const turns = turnEnds(run.id);
    fireTimer(first.id);
    await until(() => settled(run.id, first.id)?.phase === 'delivered');
    expect(notes(run.id, 'automatic timer wake-up (').map(event => event.message)).toEqual(['automatic timer wake-up (40/40)']);
    await until(() => turnEnds(run.id) > turns && store.getRun(run.id)?.status === 'waiting');
    expect(label(run.id)).toBe('monitoring');
    const parkedTurns = turnEnds(run.id);
    fireTimer(second.id);
    await until(() => settled(run.id, second.id)?.phase === 'cancelled');
    expect(notes(run.id, 'cap reached').map(event => event.message)).toEqual([`automatic timer wake-up cap reached (40); timer ${second.id} cancelled`]);
    await flushMicrotasks();
    expect(store.getRun(run.id)?.agentInputs?.some(input => input.id === second.id)).toBe(false);
    expect(prompted('claude', `Timer ${second.id} fired`)).toEqual([]);
    expect(turnEnds(run.id)).toBe(parkedTurns);
    expect(store.getRun(run.id)?.automaticWakes).toBe(40);
    // Nothing else open or resolved: the budget's human wait parks for the user and holds no slot
    // (hearsay-tools/cezarion#1234).
    expect(store.getRun(run.id)?.waits).toMatchObject([{ kind: WAIT_KIND.human, via: WAIT_VIA.budget, source: WAIT_SOURCE.cezar, phase: WAIT_PHASE.open }]);
    expect(label(run.id)).toBe('needs you');
    // A competing monitoring park takes the one pool exemption. If the capped run stayed
    // in the pool, these two live parks would hold one regular slot instead of none.
    const { run: competitor, waits: [competingWait] } = await parkedOnTimers({ seconds: 7200, note: 'competing park' });
    expect(waitById(competitor.id, competingWait.id)?.phase).toBe('open');
    await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([task]) => task));
    expect(semaphore.busy()).toBe(0);
  });

  it('claude a timer result still owed when the budget is spent is cancelled before its batch is sent; the CI result beside it is delivered', async () => {
    const external = github();
    nativeWire('claude');
    const release = join(root, 'turn-release');
    process.env.CEZ_MOCK_RELEASE_FILE = release;
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios['hold-gated']!, runner: 'claude' });
    await until(() => turnStarted(run.id));
    const timer = await openWait(run.id, { kind: WAIT_KIND.timer, seconds: 60, note: 'owed' });
    const ci = await openWait(run.id, { kind: WAIT_KIND.pr, pr, timeout_seconds: 600 });
    fireTimer(timer.id); external.settle();
    await until(() => waitById(run.id, timer.id)?.phase === 'resolved' && waitById(run.id, ci.id)?.phase === 'resolved');
    // The budget runs out between the timer's resolution and the boundary that would send it.
    store.updateRun(run.id, { automaticWakes: 40 });
    writeFileSync(release, '');
    await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted('claude', `CI wait observation ${ci.id}`).length > 0);
    expect(settled(run.id, timer.id)?.phase).toBe('cancelled');
    expect(notes(run.id, 'cap reached').map(event => event.message)).toEqual([`automatic timer wake-up cap reached (40); timer ${timer.id} cancelled`]);
    const wake = prompted('claude', `CI wait observation ${ci.id}`);
    expect(wake).toHaveLength(1);
    expect(wake[0]).not.toContain(`Timer ${timer.id} fired`);
    expect(store.getRun(run.id)?.automaticWakes).toBe(40);
    expect(notes(run.id, 'automatic timer wake-up (')).toEqual([]);
  });

  it('claude a refused timer batch gives its budget reservation back and is retried', async () => {
    nativeWire('claude');
    const { run, waits: [timer] } = await parkedOnTimers({ seconds: 60, note: 'refused' });
    const wire = session();
    store.updateRun(run.id, { automaticWakes: 39 });
    const send = wire.sendAgentMessage.bind(wire);
    let refusals = 0;
    vi.spyOn(wire, 'sendAgentMessage').mockImplementation((content, ids) => {
      if (refusals++ === 0) return false;
      return send(content, ids);
    });
    fireTimer(timer.id);
    await until(() => settled(run.id, timer.id)?.phase === 'delivered');
    // Reserved for each attempt, given back after the refusal, charged to the record on the acknowledgement.
    expect(refusals).toBe(2);
    expect(notes(run.id, 'cap reached')).toEqual([]);
    expect(store.getRun(run.id)?.automaticWakes).toBe(40);
    expect(notes(run.id, 'automatic timer wake-up (').map(event => event.message)).toEqual(['automatic timer wake-up (40/40)']);
  });

  // hearsay-tools/cezarion#1234: the budget and the failure count live on the run record.
  it('claude the automatic-wake budget survives a restart, a batch cut off by it is charged once, and a human message resets it', async () => {
    nativeWire('claude');
    // `later` stays open, so each delivered turn parks on it instead of taking the no-wait nudge.
    const { run, waits: [first, second] } = await parkedOnTimers({ seconds: 60, note: 'first' }, { seconds: 60, note: 'second' }, { seconds: 7200, note: 'later' });
    let turns = turnEnds(run.id);
    fireTimer(first.id);
    await until(() => settled(run.id, first.id)?.phase === 'delivered' && turnEnds(run.id) > turns && store.getRun(run.id)?.status === 'waiting');
    expect(store.getRun(run.id)?.automaticWakes).toBe(1);
    // The second wake reaches the wire; the process stops after the disk saw the batch and before
    // its acknowledgement did.
    const wire = session();
    const send = wire.sendAgentMessage.bind(wire);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(wire, 'sendAgentMessage').mockImplementation((content, ids) => {
      const ack = send(content, ids);
      return ack && ack.then(() => gate);
    });
    fireTimer(second.id);
    await until(() => prompted('claude', `Timer ${second.id} fired`).length === 1);
    expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === second.id)?.deliveredAt).toBeUndefined();
    store.flush();
    const beforeAck = readPersistedRuns(join(root, '.ai/cezar'));
    expect(beforeAck.find(row => row.id === run.id)?.automaticWakes).toBe(1);
    release();
    await restart(false, beforeAck);
    turns = turnEnds(run.id);
    expect(store.getRun(run.id)?.automaticWakes).toBe(1);
    expect(waitById(run.id, second.id)?.phase).toBe('resolved');
    // The continuation delivers the batch again and charges it once.
    await until(() => settled(run.id, second.id)?.phase === 'delivered');
    expect(store.getRun(run.id)?.automaticWakes).toBe(2);
    expect(notes(run.id, 'automatic timer wake-up (').map(event => event.message).at(-1)).toBe('automatic timer wake-up (2/40)');
    await until(() => turnEnds(run.id) > turns && store.getRun(run.id)?.status === 'waiting');
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'carry on' }])).toBe(true);
    expect(store.getRun(run.id)?.automaticWakes).toBe(0);
  });
});
