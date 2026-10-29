import { runInternals } from './run-internals.testkit.ts';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { WAIT_LIMIT, type Wait } from '@open-mercato/cezar-contract/waits';
import type { CiWait, CiWaitResult } from '@open-mercato/cezar-contract';
import { controlledWire, manager, parent, root, restart, semaphore, store, until, worker, waitOf, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { timed, type TimedWait } from './waits.testkit.ts';
import { readPersistedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { ciWatchRequest, waitResultText } from './waits.ts';

// Tool transport is exercised by adapter parity; lifecycle tests control only external resources.
const externalResource = vi.hoisted(() => ({ supervisor: {} }));
vi.mock('../ci-wait/resources.ts', () => ({ acquireCiResources: () => ({
  supervisor: externalResource.supervisor, controller: async () => undefined, release() {},
}) }));

const pr = 'https://github.com/acme/repo/pull/12';
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
const success = (): CiWaitResult => ({ outcome: 'passed', headSha: identity.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: true });

// hearsay-tools/cezarion#1233: CI waits live in the run's wait list; a parked one is an open wait
// on a `waiting` run.
const ciWaitOf = (id: string) => store.getRun(id)?.waits?.find(entry => entry.kind === 'pr');
const lastCiWaitOf = (id: string) => [...(store.getRun(id)?.lastWaits ?? [])].reverse().find(entry => entry.kind === 'pr');
const parked = (id: string) => ciWaitOf(id)?.phase === 'open' && store.getRun(id)?.status === 'waiting';

/** Control only external GitHub; RunManager, store, scheduler and runner wire stay real. */
function github() {
  let settle!: (result: CiWaitResult) => void;
  let signal: AbortSignal | undefined;
  const result = new Promise<CiWaitResult>(resolve => { settle = resolve; });
  const supervisor = { resolve: async () => identity, watch: async (_wait: CiWait, abort: AbortSignal) => { signal = abort; return result; }, close() {} };
  externalResource.supervisor = supervisor;
  Object.assign(manager, { ciSupervisor: supervisor });
  return { settle, aborted: () => signal?.aborted };
}

async function register(id: string) {
  const state = (manager as unknown as { active: Map<string, { ciGeneration: string }> }).active.get(id)!;
  return timed(await manager.registerWait(id, { kind: 'pr', pr, timeout_seconds: 30 }, 'cezar_wait', state.ciGeneration));
}

describe('CI wait lifecycle through real runner turns', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('rejects registration outside an active run without writing a receipt', async () => {
    github();
    await expect(Promise.resolve().then(() => manager.registerWait('absent', { kind: 'pr', pr, timeout_seconds: 30 }, 'cezar_wait', 'old')))
      .rejects.toMatchObject({ code: 'run_missing' });
    expect(store.listRuns()).toEqual([]);
  });

  it('persists registration while executing, then parks marker-free without nudges or timed wakes', async () => {
    const external = github();
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent();
    await until(wire.initialReceived);
    const receipt = await register(run.id);
    expect(receipt.phase).toBe('open');
    const persisted = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; waits?: Wait[] }>;
    expect(persisted.find(row => row.id === run.id)?.waits?.find(entry => entry.kind === 'pr')?.id).toBe(receipt.id);
    writeFileSync(gate, 'end');
    await until(() => parked(run.id));
    expect(store.getRun(run.id)?.waits?.some(entry => entry.kind === 'timer')).toBeFalsy();
    expect(semaphore.busy()).toBe(0); // its slot is a monitoring slot
    expect(runInternals(manager).line.monitoring.has(run.id)).toBe(true);
    expect(external.aborted()).toBe(false);
  });

  it('queues early completion until turn boundary and acknowledges exactly one lifecycle input', async () => {
    const external = github();
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const receipt = await register(run.id);
    external.settle(success());
    await until(() => ciWaitOf(run.id)?.phase === 'resolved');
    expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === receipt.id)?.deliveredAt).toBeUndefined();
    writeFileSync(gate, 'end');
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(ciWaitOf(run.id)).toBeUndefined();
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === receipt.id)).toHaveLength(1);
    expect(store.getRun(run.id)?.status).not.toBe('done');
  });

  // Exhaustive native-wire regression matrix for #494. A new runner must supply
  // its own adapter; no normalized event injection or backend-only exemption.
  it('CI retry matrix covers every runner with a native hold scenario', () => {
    for (const runner of RUNNER_IDS) {
      expect(HARNESS_ADAPTERS[runner].mockBin).toBeTruthy();
      expect(HARNESS_ADAPTERS[runner].scenarios.hold).toBeDefined();
    }
  });

  it.each(RUNNER_IDS)('%s retries a refused settled CI observation without human input', async runner => {
    const external = github();
    process.env.CEZ_DRY_RUN = '0';
    const adapter = HARNESS_ADAPTERS[runner];
    process.env[adapter.binEnv] = adapter.mockBin;
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: adapter.scenarios.hold!, runner });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    const receipt = await register(run.id);
    const engine = runInternals(manager);
    const session = engine.active.get(run.id)!.session!;
    const send = vi.spyOn(session, 'sendAgentMessage').mockReturnValueOnce(false);
    external.settle(success());
    await until(() => send.mock.calls.length > 0);
    expect.soft(runInternals(manager).line.monitoring.has(run.id)).toBe(true);
    expect.soft(store.getRun(run.id)?.status).toBe('waiting');
    expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === receipt.id)?.deliveredAt).toBeUndefined();
    expect.soft(semaphore.busy()).toBe(0); // The park's monitoring slot carries the wake.
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(ciWaitOf(run.id)).toBeUndefined();
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === receipt.id)).toHaveLength(1);
    expect(store.readEvents(run.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  });

  // A park beside a pending question holds no slot, so its wake waits for admission
  // (hearsay-tools/cezarion#1233); a CI or timer park is admitted at once instead.
  it('requeues a settled wake dequeued after losing its turn boundary', async () => {
    const external = github();
    const gate = join(root, 'ask-boundary'); controlledWire({ firstResultGate: gate });
    const run = await parent('mock:ask');
    await register(run.id);
    writeFileSync(gate, 'end');
    await until(() => store.getRun(run.id)?.status === 'waiting' && store.readEvents(run.id).some(event => event.type === 'ask.requested'));
    const engine = runInternals(manager);
    const state = engine.active.get(run.id)!;
    // Hold scheduler capacity until the observation is queued, then lose the
    // boundary before admission (a backend can resume autonomously).
    const capacity = vi.spyOn(semaphore, 'busy').mockReturnValue(1);
    external.settle(success());
    await until(() => runInternals(manager).line.waitWakeQueuedAt.has(run.id));
    state.atTurnBoundary = undefined;
    capacity.mockRestore();
    await runInternals(manager).line.pump();
    expect.soft(runInternals(manager).line.queue).toContain(run.id);
    state.atTurnBoundary = state.session;
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
  });

  it('keeps an accepted CI wake parked and charged until acknowledgement', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    const engine = runInternals(manager);
    const session = engine.active.get(run.id)!.session!;
    const original = session.sendAgentMessage.bind(session);
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const send = vi.spyOn(session, 'sendAgentMessage').mockImplementation((...args) => {
      const accepted = original(...args);
      return accepted && accepted.then(() => ack);
    });
    try {
      external.settle(success());
      await until(() => send.mock.calls.length === 1);
      // Native activity and turn-end happen before the held transport ACK.
      await until(() => store.readEvents(run.id).filter(event => event.type === 'turn-end').length === 2);
      expect(runInternals(manager).line.monitoring.has(run.id)).toBe(true);
      expect(store.getRun(run.id)?.status).toBe('waiting');
      expect(semaphore.busy()).toBe(0);
      expect(ciWaitOf(run.id)?.phase).toBe('resolved');
      acknowledge();
      await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
      // Nothing left open: the boundary parks for the user and gives the pool slot back.
      await until(() => !runInternals(manager).line.monitoring.has(run.id) && store.getRun(run.id)?.status === 'waiting');
    } finally { acknowledge(); }
  });

  it('stops refused CI retries on cancel', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const wait = await register(run.id);
    const engine = runInternals(manager);
    const send = vi.spyOn(engine.active.get(run.id)!.session!, 'sendAgentMessage').mockReturnValue(false);
    external.settle(success());
    await until(() => send.mock.calls.length >= 2);
    expect(manager.cancel(run.id)).toBe(true);
    expect(runInternals(manager).retries.wakeRetries.has(run.id)).toBe(false);
    expect(ciWaitOf(run.id)).toBeUndefined();
    expect(store.getRun(run.id)?.agentInputs?.some(input => input.id === wait.id)).toBe(false);
  });

  // hearsay-tools/cezarion#1233: a park beyond `maxMonitoringSessions` keeps its regular slot, so
  // both wake at once; neither waits in the line.
  it('wakes every CI park at once when the pool is smaller than the parks', async () => {
    const external = github();
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(1);
    const first = await parent(); await until(() => store.getRun(first.id)?.status === 'waiting');
    await register(first.id);
    const second = await parent(); await until(() => store.getRun(second.id)?.status === 'waiting');
    await register(second.id);
    expect(semaphore.busy()).toBe(1); // one pool slot, one regular slot
    const queue = vi.spyOn(runInternals(manager).line.queue, 'push');
    external.settle(success());
    await until(() => !!lastCiWaitOf(first.id)?.deliveredAt && !!lastCiWaitOf(second.id)?.deliveredAt);
    expect(queue.mock.calls.flat()).not.toContain(first.id);
    expect(queue.mock.calls.flat()).not.toContain(second.id);
  });

  it.each(RUNNER_IDS)('%s resumes on native activity before CI admission', async runner => {
    github();
    process.env.CEZ_DRY_RUN = '0';
    const adapter = HARNESS_ADAPTERS[runner];
    process.env[adapter.binEnv] = adapter.mockBin;
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: adapter.scenarios.hold!, runner });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    const engine = runInternals(manager);
    // Counted from here: the no-wait nudge's turn came before the park (hearsay-tools/cezarion#1234).
    const started = () => store.readEvents(run.id).filter(event => event.type === 'turn.started').length;
    const before = started();
    // Resume the backend itself, bypassing the manager's human-input path.
    // Native frames resume the run; it works in the monitoring slot its park kept
    // (hearsay-tools/cezarion#1233), so no regular slot is charged.
    expect(engine.active.get(run.id)!.session!.sendMessage([{ type: 'text', text: adapter.scenarios.hold! }])).toBe(true);
    await until(() => started() > before);
    expect(store.getRun(run.id)?.status).toBe('running');
    expect(semaphore.busy()).toBe(0);
    expect(ciWaitOf(run.id)?.phase).toBe('open');
  });

  it('deduplicates matching registrations without extending the deadline', async () => {
    github();
    const gate = join(root, 'turn-boundary'); controlledWire({ firstResultGate: gate });
    const run = await parent();
    const first = await register(run.id); const second = await register(run.id);
    expect(second.id).toBe(first.id); expect(second.deadline).toBe(first.deadline);
    writeFileSync(gate, 'end');
  });

  it('does not require worker delegation permissions', async () => {
    github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    store.updateRun(run.id, { delegation: undefined });
    const receipt = await register(run.id);
    expect(receipt.phase).toBe('open');
    expect(parked(run.id)).toBe(true);
    expect(store.getRun(run.id)?.delegation).toBeUndefined();
  });

  // hearsay-tools/cezarion#1233: the park keeps its slot, so its result does not wait for the
  // run holding the only regular one.
  it('delivers a completed wait while another run holds the only regular slot', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const receipt = await register(run.id);
    const blockerGate = join(root, 'blocker-gate'); controlledWire({ firstResultGate: blockerGate });
    const blocker = await parent();
    await until(() => semaphore.busy() === 1);
    try {
      external.settle(success());
      await until(() => !!store.getRun(run.id)?.agentInputs?.find(input => input.id === receipt.id)?.deliveredAt);
      expect(store.getRun(blocker.id)?.status).toBe('running');
    } finally { writeFileSync(blockerGate, 'end'); }
    expect(store.getRun(blocker.id)?.status).not.toBe('cancelled');
  });

  it('resumes a monitor that already holds a charged slot with the exemption disabled', async () => {
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    expect(semaphore.busy()).toBe(1);
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(ciWaitOf(run.id)).toBeUndefined();
  });

  it('rebuilds a parked wait after restart without launching a model before settlement', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const receipt = await register(run.id);
    await restart();
    expect(manager.isActive(run.id)).toBe(false);
    expect(ciWaitOf(run.id)?.id).toBe(receipt.id);
    expect(store.getRun(run.id)?.status).toBe('waiting');
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === receipt.id)).toHaveLength(1);
  });

  // hearsay-tools/cezarion#1425: recovery re-arms a merge wait as a merge wait, with no live session.
  it('rebuilds a parked merge wait after restart and delivers its merged result once', async () => {
    let settle!: (result: CiWaitResult) => void;
    const watched: CiWait[] = [];
    const supervisor = { resolve: async () => identity, watch: (wait: CiWait) => { watched.push(wait); return new Promise<CiWaitResult>(done => { settle = done; }); }, close() {} };
    externalResource.supervisor = supervisor;
    Object.assign(manager, { ciSupervisor: supervisor });
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const state = (manager as unknown as { active: Map<string, { ciGeneration: string }> }).active.get(run.id)!;
    const receipt = await manager.registerWait(run.id, { kind: 'pr', pr, until: 'merge', wake_on_conflict: false, timeout_seconds: 30 }, 'cezar_wait', state.ciGeneration);
    await restart();
    expect(manager.isActive(run.id)).toBe(false);
    expect(watched.at(-1)).toMatchObject({ id: receipt.id, until: 'merge', wakeOnConflict: false });
    // The committed row at the wake boundary already holds the result and its input.
    let committed: { waits?: Wait[]; agentInputs?: Array<{ id: string; text: string }> } | undefined;
    const engine = runInternals(manager).wakeAdmission;
    const queue = engine.queueWaitWake.bind(engine);
    const wake = vi.spyOn(engine, 'queueWaitWake').mockImplementation(id => { if (id === run.id) committed = readPersistedRuns(join(root, '.ai/cezar')).find(row => row.id === id); queue(id); });
    settle({ outcome: 'merged', headSha: identity.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false, mergedAt: '2026-10-23T09:00:00Z' });
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(wake).toHaveBeenCalled();
    expect(committed?.waits?.find(wait => wait.id === receipt.id)).toMatchObject({ phase: 'resolved', until: 'merge', result: { outcome: 'merged' } });
    expect(committed?.agentInputs?.find(input => input.id === receipt.id)?.text).toContain('(until merge)');
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === receipt.id)).toHaveLength(1);
  });

  it('cancellation retires the wait and never reopens the run on late completion', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    expect(manager.cancel(run.id)).toBe(true);
    await until(() => !manager.isActive(run.id));
    external.settle(success());
    await Promise.resolve();
    expect(store.getRun(run.id)?.status).toBe('cancelled');
    expect(ciWaitOf(run.id)).toBeUndefined();
  });

  // hearsay-tools/cezarion#1233: a human message aborts nothing; a lookup that outlives its turn
  // is still refused.
  it('keeps a registration whose lookup resolves after a human message in the same turn', async () => {
    github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    let resolve!: (value: typeof identity) => void;
    const deferred = new Promise<typeof identity>(done => { resolve = done; });
    Object.assign(manager, { ciSupervisor: { resolve: () => deferred, watch: () => new Promise(() => {}), close() {} } });
    const registration = register(run.id);
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'mock:hold new instruction' }])).toBe(true);
    resolve(identity);
    await expect(registration).resolves.toMatchObject({ phase: 'open' });
    expect(ciWaitOf(run.id)?.phase).toBe('open');
  });

  it('coalesces concurrent identical registration requests', async () => {
    github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const [first, second] = await Promise.all([register(run.id), register(run.id)]);
    expect(first.id).toBe(second.id);
    expect(first.deadline).toBe(second.deadline);
  });

  // hearsay-tools/cezarion#1233 drops the human-ask refusals: a newer ask no longer refuses CI.
  it('accepts CI during an executing approval and after a newer human ask', async () => {
    github(); const release = join(root, 'ci-answer');
    const wire = controlledWire({ humanAnswerGate: release });
    const p = await parent('mock:ask');
    await until(() => store.readEvents(p.id).some(event => event.type === 'ask.requested'));
    await restart();
    expect(manager.continueRun(p.id, { text: 'human answer mock:hold' }).ok).toBe(true);
    await until(() => wire.received() === 1);
    try {
      const wait = await register(p.id);
      expect(wait.phase).toBe('open');
      expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      store.appendEvent(p.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{ header: 'New', question: 'Approve?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
      await expect(register(p.id)).resolves.toMatchObject({ id: wait.id });
    } finally { writeFileSync(release, 'go'); }
  });

  // hearsay-tools/cezarion#1235 phase 3a (design § Registration and cancel): "A CI wait is already
  // active" is a removed refusal. Worker and request waits are list entries beside CI.
  it('registers worker and request waits beside a registered CI wait, which stays open', async () => {
    github(); const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const ci = await register(p.id);
    const now = new Date().toISOString();
    const request = { id: randomUUID(), senderRunId: p.id, recipientRunId: w.id, kind: 'request' as const, text: 'Which module?', createdAt: now,
      deadline: new Date(Date.now() + 600_000).toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const };
    store.commitConversation(p.id, { messages: [request], outcomes: [] }, { recipientRunId: w.id,
      input: { id: request.id, source: 'agent', parentRunId: p.id, text: request.text, createdAt: now, conversation: { senderRunId: p.id, recipientRunId: w.id, kind: 'request' } } });
    const workers = manager.registerWorkerWait(p.id, { workerIds: [w.id], timeoutSeconds: 30 });
    const requests = manager.registerRequestWait(p.id, { requestIds: [request.id], timeoutSeconds: 30 });
    expect([workers.phase, requests.phase]).toEqual(['registered', 'registered']);
    const waits = store.getRun(p.id)!.waits!;
    expect(waits.map(wait => [wait.id, wait.kind, wait.phase])).toEqual([[ci.id, 'pr', 'open'], [workers.id, 'worker', 'open'], [requests.id, 'worker', 'open']]);
    expect(waits.find(wait => wait.id === workers.id)).toMatchObject({ via: 'cez-worker-wait', workerIds: [w.id] });
    expect(waits.find(wait => wait.id === requests.id)).toMatchObject({ via: 'cez-worker-wait', requestIds: [request.id] });
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
  });

  // hearsay-tools/cezarion#1233: the ask leaves CI open; its result wakes the run and never
  // answers the question.
  it('a human ask at turn-end keeps CI open and its result leaves the question unanswered', async () => {
    const external = github();
    const gate = join(root, 'ask-boundary'); controlledWire({ firstResultGate: gate });
    const run = await parent('mock:ask');
    const wait = await register(run.id);
    writeFileSync(gate, 'end');
    await until(() => store.getRun(run.id)?.status === 'waiting' && hasPendingAsk(store, run.id) === true);
    expect(ciWaitOf(run.id)?.phase).toBe('open');
    expect(external.aborted()).toBe(false);
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    // This wire never echoes a consumed line, so the re-park itself is U3b's, on native wires.
    expect(hasPendingAsk(store, run.id)).toBe(true);
    expect(store.readEvents(run.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  });

  it('backend disconnect retains the bounded wait and recovers only after settlement', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    const state = (manager as unknown as { active: Map<string, { session: { end(): void } }> }).active.get(run.id)!;
    state.session.end();
    await until(() => !manager.isActive(run.id));
    expect(store.getRun(run.id)?.status).toBe('waiting');
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(lastCiWaitOf(run.id)?.result?.outcome).toBe('passed');
  });

  it('a CI wait keeps an earlier step open, and the step advances only on a done after the resumed turn', async () => {
    const external = github();
    const gate = join(root, 'nonfinal-boundary'); controlledWire({ firstResultGate: gate, replay: true });
    const run = manager.startRun({ name: 'ci-chain', source: 'built-in', steps: [
      { id: 'first', prompt: 'hold' }, { id: 'check', command: 'node -e "process.exit(0)"' },
    ] }, { task: 'CI chain', runner: 'claude' });
    await until(() => !!(manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(run.id)?.sessionEverOpened);
    await register(run.id); writeFileSync(gate, 'end');
    await until(() => parked(run.id));
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'check')?.status).toBe('pending');
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    // The wake turn signals nothing; the earlier step completes only on a done (hearsay-tools/cezarion#1620).
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'check')?.status).toBe('pending');
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'mock:done' }])).toBe(true);
    await until(() => !manager.isActive(run.id));
    expect(store.getRun(run.id)?.steps.map(step => step.status)).toEqual(['done', 'done']);
  });

  // hearsay-tools/cezarion#1233: one wake batch carries the observation first, then the conversations.
  // hearsay-tools/cezarion#1235 phase 3a (design § Resolution and waking, Transitions out): a
  // message alone is a wake of its own and leaves CI open; messages owed beside the CI result
  // still ride its one wake.
  it('batches worker conversations behind the CI observation in one wake without losing admission', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const wait = await register(run.id);
    await until(() => parked(run.id));
    const session = runInternals(manager).active.get(run.id)!.session!;
    const send = vi.spyOn(session, 'sendAgentMessage');
    const update = (n: number) => ({ id: randomUUID(), parentRunId: run.id, source: 'agent' as const, text: `worker update ${n}`,
      createdAt: new Date().toISOString(), conversation: { senderRunId: randomUUID(), recipientRunId: run.id, kind: 'progress' as const } });
    const inputOf = (id: string) => store.getRun(run.id)?.agentInputs?.find(input => input.id === id);
    // A message during the CI park wakes the run at once; CI stays open and re-parks it.
    const early = update(0);
    store.commitAgentInputs(run.id, [early]);
    const boundaries = store.readEvents(run.id).filter(event => event.type === 'turn-end').length;
    manager.deliverConversationInput(run.id);
    await until(() => !!inputOf(early.id)?.deliveredAt);
    expect(ciWaitOf(run.id)).toMatchObject({ id: wait.id, phase: 'open' });
    await until(() => store.readEvents(run.id).filter(event => event.type === 'turn-end').length > boundaries && parked(run.id));
    expect(waitOf(store.getRun(run.id))).toBeUndefined();
    send.mockClear();
    // Messages owed when the observation lands go in its one wake, after it.
    const messages = [1, 2, 3].map(update);
    store.commitAgentInputs(run.id, messages);
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    await until(() => messages.every(message => inputOf(message.id)?.deliveredAt));
    const delivered = store.getRun(run.id)!.agentInputs!;
    expect(delivered.find(input => input.id === wait.id)?.deliveredAt).toBeTruthy();
    const accepted = send.mock.calls.filter((_, i) => send.mock.results[i]?.value !== false);
    expect(accepted).toHaveLength(1);
    const batch = JSON.stringify(accepted[0]);
    for (const message of messages) expect(batch.indexOf(message.id)).toBeGreaterThan(batch.indexOf(wait.id));
    expect(new Set(messages.map(message => inputOf(message.id)?.deliveredAt)).size).toBe(1);
  });

  it('reconciles a settled CI wake after an owned worker execution finalizes', async () => {
    const external = github();
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const gate = join(root, 'worker-boundary'); controlledWire({ firstResultGate: gate });
    const child = await worker(p.id); manager.enqueueOwnedRun(child.id);
    await until(() => !!(manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(child.id)?.sessionEverOpened);
    await register(child.id);
    external.settle(success());
    await until(() => ciWaitOf(child.id)?.phase === 'resolved');
    const state = (manager as unknown as { active: Map<string, { session: { end(): void } }> }).active.get(child.id)!;
    // The session closes with the result owed: one failed delivery, retried after the wake backoff
    // (hearsay-tools/cezarion#1233), which the test need not wait out.
    runInternals(manager).retries.wakeRetryBackoff = { fastMs: 0, fastCount: 1, capMs: 0 };
    state.session.end(); writeFileSync(gate, 'end');
    await until(() => !!lastCiWaitOf(child.id)?.deliveredAt);
    expect(ciWaitOf(child.id)).toBeUndefined();
  });

});

// hearsay-tools/cezarion#1233: the wait list holds several CI and timer waits at once; each
// resolves, is cancelled or is recovered on its own.
const generationOf = (id: string) => (manager as unknown as { active: Map<string, { ciGeneration: string }> }).active.get(id)!.ciGeneration;
const prUrl = (n: number) => `https://github.com/acme/repo/pull/${n}`;
const registerPr = async (id: string, n: number, timeout = 30) =>
  timed(await manager.registerWait(id, { kind: 'pr', pr: prUrl(n), timeout_seconds: timeout }, 'cezar_wait', generationOf(id)));
const registerTimer = async (id: string, seconds = 60, note?: string) =>
  timed(await manager.registerWait(id, { kind: 'timer', seconds, ...(note === undefined ? {} : { note }) }, 'cezar_wait', generationOf(id)));
const waitById = (id: string, waitId: string) => store.getRun(id)?.waits?.find((entry): entry is TimedWait => entry.id === waitId && entry.kind !== 'human');
const settledById = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(entry => entry.id === waitId);
const inputsFor = (id: string, waitId: string) => store.getRun(id)?.agentInputs?.filter(input => input.id === waitId) ?? [];
const fireTimer = (waitId: string) => runInternals(manager).waitWatches.waitTimers.get(waitId)!.timer._onTimeout();
/** This suite's sessions have no cezar tool controller (`controller: async () => undefined`), so a
 *  timer wakes them in the marker wording (hearsay-tools/cezarion#1234). */
const timerFired = (waitId: string, note: string) =>
  `Timer ${waitId} fired: ${note}. Continue toward the task goal. If the watched work is still pending, end your final message with CEZ:MONITORING.`;
const flushMicrotasks = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };

/** External GitHub per PR number: each watch settles on its own; a gate holds every lookup. */
function githubByPr(lookupGate?: Promise<void>) {
  const watches = new Map<number, { settle(result: CiWaitResult): void; signal: AbortSignal }>();
  const supervisor = {
    resolve: async (url: string) => { await lookupGate; return { ...identity, prUrl: url, prNumber: Number(url.split('/').pop()) }; },
    watch: (wait: CiWait, signal: AbortSignal) => new Promise<CiWaitResult>(resolve => { watches.set(wait.prNumber, { settle: resolve, signal }); }),
    close() {},
  };
  externalResource.supervisor = supervisor;
  Object.assign(manager, { ciSupervisor: supervisor });
  return { settle: (n: number) => watches.get(n)!.settle(success()), aborted: (n: number) => watches.get(n)?.signal.aborted };
}

/** A root parked on Cezar's no-wait human wait: its turn took the no-wait nudge and answered it in
 *  plain text, one automatic wake (hearsay-tools/cezarion#1234). The agent's first wait replaces it. */
async function waitingParent() {
  const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
  return run;
}

describe('wait list through RunManager (hearsay-tools/cezarion#1233)', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('two CI waits for different PRs and a timer are open at once and resolve independently', async () => {
    const external = githubByPr();
    const run = await waitingParent();
    const first = await registerPr(run.id, 12);
    const second = await registerPr(run.id, 13);
    const timer = await registerTimer(run.id, 60, 'check the deploy');
    expect(store.getRun(run.id)?.waits?.map(wait => [wait.id, wait.phase])).toEqual([[first.id, 'open'], [second.id, 'open'], [timer.id, 'open']]);
    expect(store.getRun(run.id)?.status).toBe('waiting');
    external.settle(13);
    await until(() => settledById(run.id, second.id)?.phase === 'delivered');
    expect(inputsFor(run.id, second.id).map(input => input.text)).toEqual([expect.stringContaining(prUrl(13))]);
    expect([waitById(run.id, first.id)?.phase, waitById(run.id, timer.id)?.phase]).toEqual(['open', 'open']);
    fireTimer(timer.id);
    await until(() => settledById(run.id, timer.id)?.phase === 'delivered');
    expect(inputsFor(run.id, timer.id).map(input => input.text)).toEqual([timerFired(timer.id, 'check the deploy')]);
    expect(waitById(run.id, first.id)?.phase).toBe('open');
    external.settle(12);
    await until(() => settledById(run.id, first.id)?.phase === 'delivered');
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    for (const wait of [first, second, timer]) expect(inputsFor(run.id, wait.id)).toHaveLength(1);
  });

  it('identical CI registration returns the existing wait id; a different timeout on the same PR is still identical', async () => {
    githubByPr();
    const run = await waitingParent();
    const wait = await registerPr(run.id, 12, 30);
    const again = await manager.registerWait(run.id, { kind: 'pr', pr: 'https://github.com/Acme/Repo/pull/12', timeout_seconds: 600 }, 'cezar_wait', generationOf(run.id));
    expect(again).toMatchObject({ id: wait.id, deadline: wait.deadline, timeoutSeconds: 30, until: 'checks' as const, wakeOnConflict: true });
    const timer = await registerTimer(run.id, 120, 'deploy');
    expect((await registerTimer(run.id, 120, 'deploy')).id).toBe(timer.id);
    expect((await registerTimer(run.id, 180, 'deploy')).id).not.toBe(timer.id);
    expect(store.getRun(run.id)?.waits).toHaveLength(3);
  });

  it('a timer registered with seconds=120 resolves at +120s with its note and enqueues one lifecycle input with the wait id', async () => {
    const run = await waitingParent();
    const charged = store.getRun(run.id)?.automaticWakes ?? 0;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const wait = await registerTimer(run.id, 120, 'check the deploy');
      expect(Date.parse(wait.deadline!) - Date.parse(wait.registeredAt)).toBe(120_000);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(waitById(run.id, wait.id)?.phase).toBe('open');
      expect(inputsFor(run.id, wait.id)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(inputsFor(run.id, wait.id)).toMatchObject([{ source: 'lifecycle', text: timerFired(wait.id, 'check the deploy') }]);
      await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
      expect(inputsFor(run.id, wait.id)).toHaveLength(1);
      // A timer expiry is a self-generated wake: its admitted turn counts against the session's budget.
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && event.message === `automatic timer wake-up (${charged + 1}/40)`)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('cancelWait on an open CI wait aborts its watch and no observation is ever enqueued, even when the watcher settles afterwards', async () => {
    const external = githubByPr();
    const run = await waitingParent();
    const wait = await registerPr(run.id, 12);
    const kept = await registerTimer(run.id, 600);
    expect(manager.cancelWait(run.id, wait.id, generationOf(run.id))).toEqual({ cancelled: true });
    expect(external.aborted(12)).toBe(true);
    expect(settledById(run.id, wait.id)?.phase).toBe('cancelled');
    external.settle(12);
    await flushMicrotasks();
    expect(inputsFor(run.id, wait.id)).toEqual([]);
    expect(manager.cancelWait(run.id, wait.id, generationOf(run.id))).toEqual({ cancelled: false, code: 'not_found' });
    expect(waitById(run.id, kept.id)?.phase).toBe('open');
    // The tool answer lists what is still open.
    const answer = await manager.cezarToolHandlers(run.id, generationOf(run.id)).cancelWait({ wait_id: kept.id }, new AbortController().signal);
    expect(answer).toEqual({ cancelled: true, wait_id: kept.id, open_waits: [] });
    expect(runInternals(manager).waitWatches.waitTimers.has(kept.id)).toBe(false);
  });

  it('two concurrent cezar_wait ci calls for different PRs both register', async () => {
    let release!: () => void;
    githubByPr(new Promise<void>(resolve => { release = resolve; }));
    const run = await waitingParent();
    const pending = Promise.all([registerPr(run.id, 12), registerPr(run.id, 13)]);
    await until(() => runInternals(manager).waitRegistry.ciRegistrations.size === 2);
    release();
    const [first, second] = await pending;
    expect(first.id).not.toBe(second.id);
    expect(store.getRun(run.id)?.waits?.map(wait => wait.kind === 'pr' ? wait.prNumber : undefined)).toEqual([12, 13]);
  });

  it('cancelWait on a resolved, undelivered wait answers already_resolved and the result is still delivered', async () => {
    const external = githubByPr();
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const wait = await registerPr(run.id, 12);
    external.settle(12);
    await until(() => waitById(run.id, wait.id)?.phase === 'resolved');
    expect(manager.cancelWait(run.id, wait.id, generationOf(run.id))).toEqual({ cancelled: false, code: 'already_resolved' });
    expect(waitById(run.id, wait.id)?.phase).toBe('resolved');
    writeFileSync(gate, 'end');
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id)).toMatchObject([{ deliveredAt: expect.any(String) }]);
  });

  it('timer refuses timers_disabled when the interval is null; an open timer keeps its deadline when the interval changes', async () => {
    githubByPr();
    const run = await waitingParent();
    const interval = vi.spyOn(semaphore, 'monitoringWakeIntervalMinutes').mockReturnValue(null);
    await expect(registerTimer(run.id)).rejects.toMatchObject({ code: 'timers_disabled' });
    const answer = await manager.cezarToolHandlers(run.id, generationOf(run.id)).registerWait({ kind: 'timer', seconds: 60 }, 'cezar_wait', new AbortController().signal);
    expect(answer.answer).toMatchObject({ ok: false, code: 'timers_disabled', open_waits: [] });
    // A refused registration registers nothing, so Cezar's own wait stays.
    expect(store.getRun(run.id)?.waits?.map(wait => wait.via)).toEqual(['no-wait']);
    // CI is an external event: Park until resumed does not refuse it.
    await expect(registerPr(run.id, 12)).resolves.toMatchObject({ kind: 'pr' });
    interval.mockReturnValue(5);
    const wait = await registerTimer(run.id, 600);
    interval.mockReturnValue(1);
    await (runInternals(manager).line).pump();
    expect(waitById(run.id, wait.id)?.deadline).toBe(wait.deadline);
    interval.mockReturnValue(null);
    await (runInternals(manager).line).pump();
    expect(waitById(run.id, wait.id)).toMatchObject({ phase: 'open', deadline: wait.deadline });
    expect(runInternals(manager).waitWatches.waitTimers.has(wait.id)).toBe(true);
  });

  it('timer refuses wake_budget_spent once the run spent its automatic wakes', async () => {
    githubByPr();
    const run = await waitingParent();
    store.updateRun(run.id, { automaticWakes: 40 });
    await expect(registerTimer(run.id)).rejects.toMatchObject({ code: 'wake_budget_spent' });
    await expect(registerPr(run.id, 12)).resolves.toMatchObject({ kind: 'pr' });
  });

  it('registration refuses capacity at 16 open waits', async () => {
    githubByPr();
    const run = await waitingParent();
    const opened: Wait[] = [];
    for (let n = 0; n < WAIT_LIMIT; n++) opened.push(await registerTimer(run.id, 60 + n));
    await expect(registerTimer(run.id, 600)).rejects.toMatchObject({ code: 'capacity' });
    await expect(registerPr(run.id, 12)).rejects.toMatchObject({ code: 'capacity' });
    const answer = await manager.cezarToolHandlers(run.id, generationOf(run.id)).registerWait({ kind: 'timer', seconds: 600 }, 'cezar_wait', new AbortController().signal);
    expect(answer.answer).toMatchObject({ ok: false, code: 'capacity' });
    expect(answer.answer.open_waits).toHaveLength(WAIT_LIMIT);
    // Only open waits count, as the store counts them: a resolved one frees its place.
    fireTimer(opened[0]!.id);
    await until(() => waitById(run.id, opened[0]!.id)?.phase !== 'open');
    await expect(registerPr(run.id, 12)).resolves.toMatchObject({ kind: 'pr' });
  });

  it('restart: an open timer re-arms from its stored deadline and resolves through a continuation', async () => {
    const run = await waitingParent();
    const wait = await registerTimer(run.id, 600);
    await restart();
    expect(manager.isActive(run.id)).toBe(false);
    expect(store.getRun(run.id)?.status).toBe('waiting');
    expect(waitById(run.id, wait.id)).toMatchObject({ phase: 'open', deadline: wait.deadline });
    expect(runInternals(manager).waitWatches.waitTimers.has(wait.id)).toBe(true);
    fireTimer(wait.id);
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id)).toHaveLength(1);
  });

  it('restart: an overdue timer resolves at once and is delivered exactly once', async () => {
    const run = await waitingParent();
    const wait = await registerTimer(run.id, 600);
    store.flush();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; waits?: Wait[] }>;
    const row = disk.find(entry => entry.id === run.id)!;
    row.waits = row.waits!.map(entry => ({ ...entry, deadline: new Date(Date.now() - 1_000).toISOString() }));
    await restart(false, disk);
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id)).toHaveLength(1);
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
  });

  it('restart: a resolved v3-upgraded CI wait is delivered exactly once', async () => {
    githubByPr();
    const run = await waitingParent();
    const wait = await registerPr(run.id, 12);
    if (wait.kind !== 'pr') throw Error('expected a CI wait');
    store.flush();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<Record<string, unknown> & { id: string }>;
    const row = disk.find(entry => entry.id === run.id)!;
    const result = success();
    const resolved = { ...wait, phase: 'resolved' as const, resolvedAt: result.observedAt, result };
    // A schema-3 row: `ciWait` wake-pending, its observation queued under the wait id.
    delete row.waits;
    Object.assign(row, { status: 'running', activity: 'monitoring', ciWait: { ...ciWatchRequest(wait), phase: 'wake-pending', result, wakeId: wait.id },
      agentInputs: [{ id: wait.id, parentRunId: run.id, source: 'lifecycle', createdAt: result.observedAt, text: waitResultText(resolved) }] });
    await restart(false, disk);
    await until(() => settledById(run.id, wait.id)?.phase === 'delivered');
    expect(inputsFor(run.id, wait.id)).toMatchObject([{ deliveredAt: expect.any(String) }]);
    expect(store.getRun(run.id)?.lastWaits?.filter(entry => entry.id === wait.id)).toHaveLength(1);
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
  });

  it('restart: recovery cancels the waits of a terminal row without arming them', async () => {
    githubByPr();
    const run = await waitingParent();
    const ci = await registerPr(run.id, 12);
    const timer = await registerTimer(run.id, 600);
    store.flush();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<Record<string, unknown> & { id: string }>;
    Object.assign(disk.find(entry => entry.id === run.id)!, { status: 'review' });
    await restart(false, disk);
    await until(() => (store.getRun(run.id)?.waits ?? []).length === 0);
    expect([settledById(run.id, ci.id)?.phase, settledById(run.id, timer.id)?.phase]).toEqual(['cancelled', 'cancelled']);
    expect([runInternals(manager).waitWatches.waitTimers.size, runInternals(manager).waitWatches.ciWatches.size]).toEqual([0, 0]);
    expect(store.getRun(run.id)?.agentInputs ?? []).toEqual([]);
  });

  it.each(['cancel', 'finish', 'delete'] as const)('%s cancels open waits without waking the agent', async action => {
    const external = githubByPr();
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    const ci = await registerPr(run.id, 12);
    const timer = await registerTimer(run.id, 600);
    const turns = () => store.readEvents(run.id).filter(event => event.type === 'turn-end').length;
    const before = turns();
    if (action === 'cancel') expect(manager.cancel(run.id)).toBe(true);
    else if (action === 'finish') expect(manager.finish(run.id)).toBe(true);
    else {
      // Deletion takes an inactive run: a closed session keeps its waits (R72).
      (manager as unknown as { active: Map<string, { session: { end(): void } }> }).active.get(run.id)!.session!.end();
      await until(() => !manager.isActive(run.id));
      expect(store.deleteRun(run.id)).toBe(true);
    }
    expect(external.aborted(12)).toBe(true);
    expect([runInternals(manager).waitWatches.waitTimers.size, runInternals(manager).waitWatches.ciWatches.size]).toEqual([0, 0]);
    if (action !== 'delete') {
      expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
      expect([settledById(run.id, ci.id)?.phase, settledById(run.id, timer.id)?.phase]).toEqual(['cancelled', 'cancelled']);
      await until(() => !manager.isActive(run.id));
      external.settle(12);
      await flushMicrotasks();
      expect(store.getRun(run.id)?.agentInputs ?? []).toEqual([]);
      expect(turns()).toBe(before);
    }
  });

  it('the wait delivery outcome runs on the provider ACK of a batch containing several resolved waits', async () => {
    const external = githubByPr();
    const gate = join(root, 'turn-boundary');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const first = await registerPr(run.id, 12);
    const second = await registerPr(run.id, 13);
    const timer = await registerTimer(run.id, 60);
    // Resolutions are ordered by their millisecond `resolvedAt`; each waits for the clock to move on
    // so the three never tie and fall back to registration order.
    const resolve = async (id: string, act: () => void) => {
      act(); await until(() => waitById(run.id, id)?.phase === 'resolved');
      const at = Date.parse(waitById(run.id, id)!.resolvedAt!); await until(() => Date.now() > at);
    };
    await resolve(first.id, () => external.settle(12));
    await resolve(timer.id, () => fireTimer(timer.id));
    await resolve(second.id, () => external.settle(13));
    const session = runInternals(manager).active.get(run.id)!.session!;
    const send = vi.spyOn(session, 'sendAgentMessage');
    writeFileSync(gate, 'end');
    const ids = [first.id, timer.id, second.id];
    await until(() => ids.every(id => settledById(run.id, id)?.phase === 'delivered'));
    // The no-wait nudge after the batch's turn is a send of its own (hearsay-tools/cezarion#1234).
    const accepted = send.mock.calls.filter((call, i) => send.mock.results[i]?.value !== false && ids.some(id => JSON.stringify(call).includes(id)));
    expect(accepted).toHaveLength(1);
    const batch = JSON.stringify(accepted[0]);
    // Oldest resolution first.
    expect(ids.map(id => batch.indexOf(id))).toEqual([...ids.map(id => batch.indexOf(id))].sort((a, b) => a - b));
    expect(ids.every(id => batch.includes(id))).toBe(true);
    expect(new Set(ids.map(id => inputsFor(run.id, id)[0]?.deliveredAt)).size).toBe(1);
  });
});
