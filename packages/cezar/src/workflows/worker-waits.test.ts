import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerCancelWaitResultSchema, workerWaitResultSchema } from '@open-mercato/cezar-contract/delegation';
import type { Wait } from '@open-mercato/cezar-contract/waits';
import type { AgentSession } from '../core/agent-runner.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { RunStore } from '../runs/store.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import {
  collect, controlledWire, fixtureUpdateRun, manager, parent, restart, root, store, until, useWorkerWaitFixture, waitOf, worker,
} from './worker-wait.testkit.ts';

/**
 * Worker waits in the wait list (hearsay-tools/cezarion#1235 phase 3a): `cezar_wait({ kind:
 * 'worker' })` and `cez worker wait` open one `worker` entry each, beside CI, timer and human
 * waits; it resolves through `resolveWait`, is cancelled through the list, and answers the legacy
 * `WorkerWait` shape to the CLI.
 */

const pr = 'https://github.com/acme/repo/pull/12';
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };

type Engine = { active: Map<string, { ciGeneration?: string }> };
const engine = () => manager as unknown as Engine;
const handlers = (runId: string) => manager.cezarToolHandlers(runId, engine().active.get(runId)!.ciGeneration!);
const entryOf = (runId: string, waitId: string): Wait | undefined => store.getRun(runId)?.waits?.find(wait => wait.id === waitId);
const settledOf = (runId: string, waitId: string): Wait | undefined => store.getRun(runId)?.lastWaits?.find(wait => wait.id === waitId);
const inputOf = (runId: string, id: string) => store.getRun(runId)?.agentInputs?.find(input => input.id === id);

/** A parent whose first turn is held until `release()`: registrations happen mid-turn. */
async function heldParent() {
  const gate = join(root, `release-${randomUUID()}`);
  const wire = controlledWire({ firstResultGate: gate });
  const run = await parent(); await until(wire.initialReceived);
  return { run, release: () => writeFileSync(gate, 'release') };
}

/** A stopped and collected worker: settled, so it blocks no finish, and a wait on it resolves at once. */
async function settledWorker(parentId: string) {
  const w = await worker(parentId);
  manager.requestWorkerStop(w.id);
  // bound: real process termination, the same budget the worker-wait suites use.
  expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
  await collect(w.id);
  return w;
}

function destroyed(workerId: string) {
  const delegation = store.getRun(workerId)!.delegation;
  if (delegation?.role !== 'worker') throw Error('worker fixture');
  store.commitDelegation([{ id: workerId, delegation: { ...delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'complete', remaining: [] } } }]);
}

describe('worker waits in the wait list', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('cezar_wait worker registers an entry beside an open ci wait', async () => {
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
    const { run: p, release } = await heldParent();
    try {
      const w = await worker(p.id);
      const tools = handlers(p.id);
      const ci = await tools.registerWait({ kind: 'ci', pr, timeout_seconds: 600 }, 'cezar_wait');
      expect(ci.answer).toMatchObject({ ok: true, kind: 'ci' });
      const answer = (await tools.registerWait({ kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 }, 'cezar_wait')).answer;
      expect(answer).toMatchObject({ ok: true, kind: 'worker' });
      if (!answer.ok) throw Error('refused');
      expect(answer.open_waits.map(wait => wait.kind).sort()).toEqual(['ci', 'worker']);
      expect(entryOf(p.id, answer.wait_id)).toMatchObject({ kind: 'worker', via: 'cezar_wait', phase: 'open', workerIds: [w.id], outcomes: [], revisions: [{ workerId: w.id, revision: 0 }] });
      const delegation = store.getRun(p.id)?.delegation;
      expect(delegation?.role === 'root' ? delegation.wait : undefined).toBeUndefined();
    } finally { release(); }
  });

  it('same workers and mode return the same wait id', async () => {
    const { run: p, release } = await heldParent();
    try {
      const a = await worker(p.id); const b = await worker(p.id);
      const first = manager.registerWorkerListWait(p.id, { workerIds: [a.id, b.id], timeoutSeconds: 600 }, 'cez-worker-wait');
      const again = manager.registerWorkerListWait(p.id, { workerIds: [b.id, a.id], mode: 'any', timeoutSeconds: 30 }, 'cezar_wait');
      expect(again.id).toBe(first.id);
      const all = manager.registerWorkerListWait(p.id, { workerIds: [a.id, b.id], mode: 'all', timeoutSeconds: 600 }, 'cezar_wait');
      expect(all.id).not.toBe(first.id);
      expect(store.getRun(p.id)?.waits?.filter(wait => wait.kind === 'worker')).toHaveLength(2);
    } finally { release(); }
  });

  it('a 17th wait is refused with capacity', async () => {
    const { run: p, release } = await heldParent();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await worker(p.id)).id);
      // Sixteen distinct subsets of five workers: sixteen different waits.
      const subsets = Array.from({ length: 31 }, (_, mask) => ids.filter((_, bit) => (mask + 1) & (1 << bit)));
      for (const subset of subsets.slice(0, 16)) manager.registerWorkerListWait(p.id, { workerIds: subset, timeoutSeconds: 600 }, 'cezar_wait');
      expect(store.getRun(p.id)?.waits?.filter(wait => wait.phase === 'open')).toHaveLength(16);
      expect(() => manager.registerWorkerListWait(p.id, { workerIds: subsets[16]!, timeoutSeconds: 600 }, 'cezar_wait'))
        .toThrow(expect.objectContaining({ code: 'capacity_limit' }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const answer = (await handlers(p.id).registerWait({ kind: 'worker', worker_ids: subsets[17]!, timeout_seconds: 600 }, 'cezar_wait')).answer;
      expect(answer).toMatchObject({ ok: false, code: 'capacity' });
      expect(warn).toHaveBeenCalledExactlyOnceWith('[cez] wait registration refused: capacity');
      // A repeat of an open wait is not a new one, and is still answered at capacity.
      expect(manager.registerWorkerListWait(p.id, { workerIds: subsets[0]!, timeoutSeconds: 600 }, 'cezar_wait').phase).toBe('open');
    } finally { release(); }
  });

  it('resolves mid-turn and delivers at the boundary', async () => {
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait');
    fixtureUpdateRun(w.id, { status: 'done' });
    manager.reconcileWorkerWaits();
    expect(entryOf(p.id, entry.id)).toMatchObject({ phase: 'resolved', result: { reason: 'outcome' }, outcomes: [{ workerId: w.id, status: 'done' }] });
    // Owed, not delivered: the turn in progress takes nothing until its own end.
    expect(inputOf(p.id, entry.id)).toMatchObject({ source: 'lifecycle' });
    expect(inputOf(p.id, entry.id)?.text).toContain(`Worker wait ${entry.id} (terminal outcome)`);
    expect(inputOf(p.id, entry.id)?.deliveredAt).toBeUndefined();
    release();
    await until(() => settledOf(p.id, entry.id)?.phase === 'delivered');
    expect(inputOf(p.id, entry.id)?.deliveredAt).toBeDefined();
    expect(store.readEvents(p.id).filter(event => event.type === 'worker-outcome')).toHaveLength(1);
  });

  it('an outcome whose resolution write fails resolves once storage recovers, with no further family events', async () => {
    const { run: p, release } = await heldParent();
    try {
      const w = await worker(p.id);
      const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const commit = vi.spyOn(store, 'commitWait').mockImplementationOnce(() => { throw Error('injected: disk full'); });
      // The unfixed engine lets the failed write escape the observation that triggered it.
      try { fixtureUpdateRun(w.id, { status: 'done' }); } catch { /* recorded by the assertions below */ }
      expect(commit).toHaveBeenCalled();
      expect(entryOf(p.id, entry.id)?.phase).toBe('open');
      // Storage has recovered (the fault was one write), and nothing else touches the family.
      await until(() => entryOf(p.id, entry.id)?.phase === 'resolved');
      expect(entryOf(p.id, entry.id)).toMatchObject({ result: { reason: 'outcome' }, outcomes: [{ workerId: w.id, status: 'done' }] });
      expect(warn).toHaveBeenCalledExactlyOnceWith('[cez] worker wait checkpoint failed; retrying in 1 second');
    } finally { release(); }
  });

  it('a destroyed worker resolves a parked wait and cancels a live-turn wait', async () => {
    const { run: p, release } = await heldParent();
    const live = await worker(p.id);
    const during = manager.registerWorkerListWait(p.id, { workerIds: [live.id], timeoutSeconds: 600 }, 'cezar_wait');
    // Settled first, so its result is owed, then destroyed while the turn still runs.
    fixtureUpdateRun(live.id, { status: 'done' });
    expect(entryOf(p.id, during.id)?.phase).toBe('resolved');
    destroyed(live.id);
    manager.reconcileWorkerWaits();
    // The executing turn can move on: nothing is left to await, and no wake is owed.
    expect(entryOf(p.id, during.id)).toBeUndefined();
    expect(settledOf(p.id, during.id)?.phase).toBe('cancelled');
    expect(inputOf(p.id, during.id)).toBeUndefined();
    release();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const parked = await worker(p.id);
    const later = manager.registerWorkerListWait(p.id, { workerIds: [parked.id], timeoutSeconds: 600 }, 'cezar_wait');
    await until(() => store.getRun(p.id)?.status === 'waiting');
    fixtureUpdateRun(parked.id, { status: 'done' }); destroyed(parked.id);
    manager.reconcileWorkerWaits();
    // A parked parent still wakes for it.
    await until(() => settledOf(p.id, later.id)?.phase === 'delivered');
    expect(inputOf(p.id, later.id)?.deliveredAt).toBeDefined();
  });

  it('root finish pending refuses registration and cancels on settle', async () => {
    const { run: p, release } = await heldParent();
    try {
      // A settled, collected worker: nothing blocks the finish, and its wait resolves at once (owed).
      const w = await settledWorker(p.id);
      const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait');
      expect(entryOf(p.id, entry.id)?.phase).toBe('resolved');
      // The intent a Finish on the parked root commits (`commitRootFinishIntent`), written mid-turn.
      const delegation = store.getRun(p.id)!.delegation;
      if (delegation?.role !== 'root') throw Error('root fixture');
      store.commitDelegation([{ id: p.id, delegation: { ...delegation, finishRequestedAt: new Date().toISOString() } }]);
      expect(() => manager.registerWorkerListWait(p.id, { workerIds: [w.id], mode: 'all', timeoutSeconds: 600 }, 'cezar_wait'))
        .toThrow(expect.objectContaining({ code: 'incompatible_state', message: expect.stringContaining('finish is pending') }));
      // The finish settles the root (`settleRequestedRootFinish` → `settleSuccess`); its terminal
      // status is what cancels every wait it still holds.
      store.updateRun(p.id, { status: 'done' });
      expect(entryOf(p.id, entry.id)).toBeUndefined();
      expect(settledOf(p.id, entry.id)?.phase).toBe('cancelled');
      expect(inputOf(p.id, entry.id)).toBeUndefined();
    } finally { release(); }
  });

  it('cez worker wait answers the legacy shape', async () => {
    const { run: p, release } = await heldParent();
    try {
      const w = await worker(p.id);
      const wait = manager.registerWorkerWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 });
      expect(workerWaitResultSchema.parse({ wait, instruction: 'End your turn.' }).wait)
        .toEqual({ id: wait.id, workerIds: [w.id], revisions: [{ workerId: w.id, revision: 0 }], deadline: wait.deadline, phase: 'registered', outcomes: [], wakeId: wait.id });
      expect(entryOf(p.id, wait.id)).toMatchObject({ kind: 'worker', via: 'cez-worker-wait', phase: 'open', timeoutSeconds: 600 });
      // `cez worker wait` and `cezar_wait` land in the same list.
      expect(manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 }, 'cezar_wait').id).toBe(wait.id);
    } finally { release(); }
  });

  it('cez worker cancel-wait cancels the entry into lastWaits and answers the legacy shape', async () => {
    const { run: p, release } = await heldParent();
    try {
      const w = await worker(p.id);
      const wait = manager.registerWorkerWait(p.id, { workerIds: [w.id], timeoutSeconds: 600 });
      const cancelled = workerCancelWaitResultSchema.parse({ wait: manager.cancelWorkerWait(p.id, wait.id) }).wait;
      expect(cancelled).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'cancelled', wakeId: wait.id });
      expect(entryOf(p.id, wait.id)).toBeUndefined();
      expect(settledOf(p.id, wait.id)?.phase).toBe('cancelled');
      // A cancelled wait wakes nothing.
      expect(store.getRun(p.id)?.agentInputs ?? []).toEqual([]);
      expect(manager.cancelWorkerWait(p.id, wait.id)).toEqual(cancelled);
      expect(() => manager.cancelWorkerWait(p.id, randomUUID())).toThrow(expect.objectContaining({ code: 'incompatible_state' }));
    } finally { release(); }
  });

  it('deadline resolves with timeout and the lifecycle text says deadline reached', async () => {
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const entry = manager.registerWorkerListWait(p.id, { workerIds: [w.id], timeoutSeconds: 1 }, 'cezar_wait');
    release();
    await until(() => settledOf(p.id, entry.id)?.phase === 'delivered');
    expect(settledOf(p.id, entry.id)).toMatchObject({ result: { reason: 'timeout' } });
    expect(inputOf(p.id, entry.id)?.text).toContain(`Worker wait ${entry.id} (deadline reached)`);
    expect(store.getRun(w.id)?.status).toBe('queued');
  });

  it('a timer resolving beside an agent worker wait wakes the run and the worker wait stays open', async () => {
    const { run: p, release } = await heldParent();
    const w = await worker(p.id);
    const tools = handlers(p.id);
    const workers = (await tools.registerWait({ kind: 'worker', worker_ids: [w.id], timeout_seconds: 600 }, 'cezar_wait')).answer;
    const timer = (await tools.registerWait({ kind: 'timer', seconds: 60, note: 'beside workers' }, 'cezar_wait')).answer;
    if (!workers.ok || !timer.ok) throw Error('refused');
    release();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    (manager as unknown as { waitTimers: Map<string, { timer: { _onTimeout(): void } }> }).waitTimers.get(timer.wait_id)!.timer._onTimeout();
    await until(() => settledOf(p.id, timer.wait_id)?.phase === 'delivered' && store.getRun(p.id)?.status === 'waiting');
    expect(inputOf(p.id, timer.wait_id)?.deliveredAt).toBeDefined();
    expect(entryOf(p.id, workers.wait_id)).toMatchObject({ kind: 'worker', phase: 'open', workerIds: [w.id] });
    expect(inputOf(p.id, workers.wait_id)).toBeUndefined();
    expect(store.getRun(w.id)?.status).toBe('queued');
  });

  it('cezar_done is not refused by an agent worker wait and cancels it', async () => {
    const { run: p, release } = await heldParent();
    // A reviewing, collected worker blocks no finish; a request to it stays unanswered, so the wait
    // on its reply stays open.
    const w = await worker(p.id);
    fixtureUpdateRun(w.id, { status: 'review' });
    await collect(w.id);
    const request = { id: randomUUID(), senderRunId: p.id, recipientRunId: w.id, kind: 'request' as const, text: 'one more thing?',
      createdAt: new Date().toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const };
    store.commitConversation(p.id, { messages: [request], outcomes: [] });
    const entry = manager.registerWorkerListWait(p.id, { requestIds: [request.id], timeoutSeconds: 600 }, 'cezar_wait');
    expect(entryOf(p.id, entry.id)?.phase).toBe('open');
    expect(await handlers(p.id).finishTurn({})).toMatchObject({ ok: true, finishes: 'at_turn_end' });
    release();
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.waits ?? []).toEqual([]);
    expect(settledOf(p.id, entry.id)?.phase).toBe('cancelled');
    expect(inputOf(p.id, entry.id)).toBeUndefined();
  });
});

/**
 * Messages are not waits (hearsay-tools/cezarion#1235 phase 3a): a worker or parent message wakes
 * the run on its own, beside any open wait and beside a pending question, and ends no wait. The
 * old `reason: 'message'` stand-in in `delegation.wait` is written only on a completion park.
 */
describe('messages wake without being waits', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  const sessionOf = (runId: string) => (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(runId)!.session;
  const eventsOf = (runId: string, type: string) => store.readEvents(runId).filter(event => event.type === type);
  const answered = (runId: string) => eventsOf(runId, 'human-input-delivered').filter(event => event.source === 'parent');
  const delivered = (runId: string, id: string) => !!inputOf(runId, id)?.deliveredAt;

  /** Every `delegation.wait` a message stand-in wrote while the spy ran. */
  function standIns() {
    const commits = vi.spyOn(store, 'commitDelegation');
    return () => commits.mock.calls.flatMap(([updates]) => updates.flatMap(update =>
      update.delegation.role !== 'invalid' && update.delegation.wait?.reason === 'message' ? [update.delegation.wait] : []));
  }

  /** A steering parent and a parked worker, with a service to message between them. */
  async function conversing(parentTask = 'mock:hold', workerTask = 'mock:hold') {
    process.env.CEZ_DELEGATION = '1';
    const p = await parent(parentTask);
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('root fixture');
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, permissions: [...delegation.permissions, 'steer'] } }]);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, workerTask);
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    return { p, w, ...callers(p.id, w.id) };
  }
  let credentials: CredentialRegistry | undefined;
  afterEach(() => { credentials?.close(); credentials = undefined; });
  function callers(parentId: string, workerId: string) {
    credentials?.close();
    credentials = new CredentialRegistry();
    const [parentCaller, workerCaller] = [parentId, workerId].map(id => credentials!.authenticate(credentials!.issue('project', id, randomUUID()))!);
    const service = new DelegationService();
    service.registerProject({ id: 'project', root, store, manager });
    return { service, parentCaller: parentCaller!, workerCaller: workerCaller! };
  }
  const say = (f: ReturnType<typeof callers>, from: 'parent' | 'worker', to: string, kind: 'progress' | 'request', text: string, id = randomUUID()) =>
    f.service.send(from === 'parent' ? f.parentCaller : f.workerCaller, { id, recipientRunId: to, kind, text, timeoutSeconds: 600 }).then(() => id);

  /** The parent parked on an agent worker wait for `f.w`. */
  async function parkedOnWorker(f: Awaited<ReturnType<typeof conversing>>) {
    const entry = manager.registerWorkerListWait(f.p.id, { workerIds: [f.w.id], timeoutSeconds: 600 }, 'cezar_wait');
    await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
    return entry;
  }

  // Ticket criterion 2.
  it('a worker message wakes the parent and the worker wait stays open', async () => {
    const f = await conversing();
    const entry = await parkedOnWorker(f);
    const written = standIns();
    const send = vi.spyOn(sessionOf(f.p.id), 'sendAgentMessage');
    const id = await say(f, 'worker', f.p.id, 'progress', 'Still working mock:hold');
    await until(() => delivered(f.p.id, id));
    // The wake turn lists the wait that stays open.
    expect(JSON.stringify(send.mock.calls)).toContain(`Still open: worker wait ${entry.id}`);
    await until(() => store.getRun(f.p.id)?.status === 'waiting');
    expect(entryOf(f.p.id, entry.id)).toMatchObject({ kind: 'worker', phase: 'open', workerIds: [f.w.id] });
    expect(written()).toEqual([]);
  });

  // Review Focus 2: a reply resolves only the request wait that names it.
  it('an unrelated reply wakes and the request wait stays open', async () => {
    const f = await conversing();
    const awaited = await say(f, 'parent', f.w.id, 'request', 'First check mock:hold');
    const other = await say(f, 'parent', f.w.id, 'request', 'Second check mock:hold');
    const entry = manager.registerWorkerListWait(f.p.id, { requestIds: [awaited], timeoutSeconds: 600 }, 'cezar_wait');
    await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
    const written = standIns();
    const reply = randomUUID();
    await f.service.send(f.workerCaller, { id: reply, recipientRunId: f.p.id, kind: 'reply', requestId: other, text: 'Second result mock:hold', timeoutSeconds: 600 });
    await until(() => delivered(f.p.id, reply));
    await until(() => store.getRun(f.p.id)?.status === 'waiting');
    expect(entryOf(f.p.id, entry.id)).toMatchObject({ phase: 'open', requestIds: [awaited] });
    expect(written()).toEqual([]);
  });

  it("the parent's answer to a worker question leaves the worker's earlier wait open", async () => {
    const f = await conversing('mock:hold', 'mock:ask');
    await until(() => eventsOf(f.w.id, 'worker-question-routed').length === 1 && store.getRun(f.w.id)?.status === 'waiting');
    const question = String(eventsOf(f.w.id, 'worker-question-routed')[0]!.messageId);
    const own = await say(f, 'worker', f.p.id, 'request', 'Which module? mock:hold');
    const entry = manager.registerWorkerListWait(f.w.id, { requestIds: [own], timeoutSeconds: 600 }, 'cezar_wait');
    const written = standIns();
    await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: question, text: 'mock:agent-echo Use the parser', timeoutSeconds: 600 });
    await until(() => answered(f.w.id).length === 1);
    await until(() => store.readEvents(f.w.id).some(event => event.type === 'text' && String(event.text).includes('Use the parser')));
    expect(entryOf(f.w.id, entry.id)).toMatchObject({ phase: 'open', requestIds: [own] });
    expect(written()).toEqual([]);
  });

  it('a human message leaves an agent worker wait open', async () => {
    const f = await conversing();
    const entry = await parkedOnWorker(f);
    const written = standIns();
    expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'mock:agent-echo human update' }])).toBe(true);
    await until(() => store.readEvents(f.p.id).some(event => event.type === 'text' && String(event.text).includes('human update')));
    await until(() => store.getRun(f.p.id)?.status === 'waiting');
    expect(entryOf(f.p.id, entry.id)).toMatchObject({ phase: 'open', workerIds: [f.w.id] });
    expect(written()).toEqual([]);
  });

  it('a worker message reaches a parent with a pending cezar_ask card beside it; the card stays answerable', async () => {
    const f = await conversing('mock:ask');
    await until(() => store.getRun(f.p.id)?.hasPendingHumanAsk === true);
    const askSeq = eventsOf(f.p.id, 'ask.requested')[0]!.seq;
    const send = vi.spyOn(sessionOf(f.p.id), 'sendAgentMessage');
    const id = await say(f, 'worker', f.p.id, 'progress', 'Still working');
    await until(() => delivered(f.p.id, id));
    expect(send.mock.calls.find(call => call[1]?.includes(id))?.[2]).toEqual({ besideQuestion: true });
    // The card is still the one the human answers, with its askSeq.
    await until(() => store.getRun(f.p.id)?.hasPendingHumanAsk === true && store.getRun(f.p.id)?.status === 'waiting');
    expect(eventsOf(f.p.id, 'ask.requested')).toHaveLength(1);
    expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
    await until(() => eventsOf(f.p.id, 'human-input-delivered').some(event => event.askSeq === askSeq));
  });

  it('a worker with a routed question receives an unrelated parent message beside it', async () => {
    const f = await conversing('mock:hold', 'mock:ask');
    await until(() => eventsOf(f.w.id, 'worker-question-routed').length === 1 && store.getRun(f.w.id)?.status === 'waiting');
    const question = String(eventsOf(f.w.id, 'worker-question-routed')[0]!.messageId);
    const send = vi.spyOn(sessionOf(f.w.id), 'sendAgentMessage');
    const id = await say(f, 'parent', f.w.id, 'progress', 'Also lint');
    await until(() => delivered(f.w.id, id));
    expect(send.mock.calls.find(call => call[1]?.includes(id))?.[2]).toEqual({ besideQuestion: true });
    // A message is not the answer: the question is still the parent's to answer.
    expect(answered(f.w.id)).toEqual([]);
    await until(() => store.getRun(f.w.id)?.status === 'waiting');
    await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: question, text: 'mock:agent-echo Use the parser', timeoutSeconds: 600 });
    await until(() => answered(f.w.id).length === 1);
  });

  it('a message to a closed-session parked parent reopens it through the scheduler continuation', async () => {
    const f = await conversing();
    // A worker that never starts: a restart neither settles it nor its wait (the live one is settled).
    const idle = await worker(f.p.id);
    const entry = manager.registerWorkerListWait(f.p.id, { workerIds: [idle.id], timeoutSeconds: 600 }, 'cezar_wait');
    await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
    await restart();
    await until(() => store.getRun(f.p.id)?.status === 'waiting' && !manager.isActive(f.p.id));
    const written = standIns();
    const resumed = vi.spyOn(manager, 'continueRun');
    // A message from the idle worker, committed as `DelegationService.send` commits one.
    const id = randomUUID(); const now = new Date().toISOString();
    const delegation = store.getRun(f.p.id)!.delegation;
    if (delegation?.role !== 'root') throw Error('root fixture');
    const conversation = delegation.conversation ?? { messages: [], outcomes: [] };
    store.commitConversation(f.p.id, { ...conversation, messages: [...conversation.messages, { id, senderRunId: idle.id, recipientRunId: f.p.id,
      kind: 'progress', text: 'Still working mock:hold', createdAt: now, requestHash: 'b'.repeat(64), state: 'accepted' }] }, { recipientRunId: f.p.id,
      input: { id, source: 'agent', parentRunId: f.p.id, text: 'Still working mock:hold', createdAt: now, conversation: { senderRunId: idle.id, recipientRunId: f.p.id, kind: 'progress' } } });
    manager.deliverConversationInput(f.p.id);
    await until(() => delivered(f.p.id, id));
    expect(resumed).toHaveBeenCalledWith(f.p.id, { text: 'Resume to receive queued messages. End this opening turn so Cezar can deliver them.', waitWake: true }, true);
    await until(() => store.getRun(f.p.id)?.status === 'waiting');
    expect(entryOf(f.p.id, entry.id)).toMatchObject({ phase: 'open', workerIds: [idle.id] });
    expect(written()).toEqual([]);
  });

  // Guard (passes before and after): the completion gate keeps today's engine until phase 3b.
  it('a completion-parked parent: a non-progress message still ends the completion wait', async () => {
    const f = await conversing();
    manager.sendMessage(f.p.id, [{ type: 'text', text: 'mock:done' }]);
    await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
    const completion = waitOf(store.getRun(f.p.id))!;
    const id = await say(f, 'worker', f.p.id, 'request', 'Need a decision mock:hold');
    await until(() => delivered(f.p.id, id));
    await until(() => {
      const delegation = store.getRun(f.p.id)?.delegation;
      return delegation?.role === 'root' && delegation.wait?.id !== completion.id && delegation.lastWait?.id === completion.id;
    });
    const delegation = store.getRun(f.p.id)?.delegation;
    expect(delegation?.role === 'root' ? delegation.lastWait : undefined).toMatchObject({ id: completion.id, reason: 'message', wakeId: id });
  });
});

/**
 * A human message beside an owed wait of any kind (hearsay-tools/cezarion#1235): withdrawing
 * nothing, it is accepted durably, and on a queued wake continuation it becomes the human's opening
 * while the wake's text stays, so the owed result still reaches the agent.
 */
describe('human messages beside an owed timer wait', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  /** A parent whose timer came due during a restart, queued behind a worker that holds the one slot. */
  async function queuedTimerWake() {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const blocker = await worker(p.id, 'mock:slow');
    const answer = (await handlers(p.id).registerWait({ kind: 'timer', seconds: 60, note: 'owed' }, 'cezar_wait')).answer;
    if (!answer.ok) throw Error('refused');
    const timer = entryOf(p.id, answer.wait_id)!;
    store.commitWait(p.id, { ...timer, deadline: new Date().toISOString() });
    await restart();
    await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(blocker.id)?.sessionEverOpened === true);
    expect(store.getRun(p.id)?.status).toBe('queued');
    expect(entryOf(p.id, timer.id)?.phase).toBe('resolved');
    return { p, blocker, timer };
  }

  it('a queued human message opens the timer wake as the human\'s, durably, and the timer result still arrives', async () => {
    const { p, blocker, timer } = await queuedTimerWake();
    const opening = store.getRun(p.id)?.continuationMessage;
    expect(opening).toMatchObject({ origin: 'lifecycle' });
    expect(manager.enqueueMessage(p.id, [{ type: 'text', text: 'human update beside the timer' }])).toBeTruthy();
    expect(store.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'human', text: opening!.text });
    expect(entryOf(p.id, timer.id)?.phase).toBe('resolved');
    store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('human update beside the timer');
    expect(reopened.getRun(p.id)?.continuationMessage?.origin).toBe('human'); reopened.flush();
    manager.cancel(blocker.id);
    await until(() => store.readEvents(p.id).some(event => event.type === 'user-message' && String(event.text).includes('human update beside the timer')));
    await until(() => settledOf(p.id, timer.id)?.phase === 'delivered');
  });

  it('a startup human message beside an owed timer wait survives a crash before its delivery', async () => {
    const { p, blocker, timer } = await queuedTimerWake();
    const engine = manager as unknown as { agentEnvForStep(id: string, ...args: unknown[]): Promise<unknown> };
    const real = engine.agentEnvForStep.bind(manager);
    let release!: () => void; let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    engine.agentEnvForStep = async (id, ...args) => {
      if (id === p.id) { entered = true; await gate; }
      return real(id, ...args);
    };
    manager.cancel(blocker.id); await until(() => entered);
    let checkpoint: unknown[];
    try {
      expect(manager.deferMessage(p.id, [{ type: 'text', text: 'startup update beside the timer' }])).toBe(true);
      expect(entryOf(p.id, timer.id)?.phase).toBe('resolved');
      expect(store.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('startup update beside the timer');
      store.flush(); checkpoint = readPersistedRuns(join(root, '.ai/cezar'));
    } finally { release(); }
    await until(() => store.readEvents(p.id).some(event => event.type === 'user-message' && String(event.text).includes('startup update beside the timer')));
    const eventStart = store.readEvents(p.id).length;
    await restart(false, checkpoint!);
    // Replayed exactly once from the durable record.
    await until(() => store.readEvents(p.id).slice(eventStart).some(event => event.type === 'user-message' && String(event.text).includes('startup update beside the timer')));
    expect(store.readEvents(p.id).slice(eventStart).filter(event => event.type === 'user-message')
      .flatMap(event => String(event.text).match(/startup update beside the timer/g) ?? [])).toHaveLength(1);
  });
});
