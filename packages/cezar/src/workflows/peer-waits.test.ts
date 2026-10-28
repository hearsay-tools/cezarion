import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import type { PeerWaitEntry, Wait } from '@open-mercato/cezar-contract/waits';
import { RUN_STATUS, STEP_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../runs/store.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { MAX_AUTO_CONTINUES } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { stateOf } from './run-states.ts';
import { controlledWire, fixtureUpdateRun, manager, parent, restart, root, semaphore, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

/**
 * The `peer` wait (hearsay-tools/cezarion#1995), spec 2026-10-27-task-communication-protocol § 7:
 * one test per `waiting:peer` row of its Transitions out table (R9), on the controlled Claude wire.
 * A peer is a root task of the project; it needs no session to send, so it is a record here.
 */

type Internals = {
  active: Map<string, { ciGeneration?: string; idleTimer?: unknown; session?: { open: boolean } }>;
  monitoring: Set<string>;
};
const internals = () => manager as unknown as Internals;
const handlers = (runId: string) => manager.cezarToolHandlers(runId, internals().active.get(runId)!.ciGeneration!);
const entryOf = (runId: string, waitId: string): Wait | undefined => store.getRun(runId)?.waits?.find(wait => wait.id === waitId);
const settledOf = (runId: string, waitId: string): Wait | undefined => store.getRun(runId)?.lastWaits?.filter(wait => wait.id === waitId).at(-1);
const anyOf = (runId: string, waitId: string) => entryOf(runId, waitId) ?? settledOf(runId, waitId);
const notes = (runId: string) => store.readEvents(runId).filter(event => event.type === 'note').map(event => String(event.message));
const delivered = (runId: string, id: string) => !!store.getRun(runId)?.agentInputs?.find(input => input.id === id)?.deliveredAt;

/** A parent whose first turn is held until `release()`: registrations happen mid-turn. */
async function heldParent() {
  const gate = join(root, `release-${randomUUID()}`);
  const wire = controlledWire({ firstResultGate: gate, replay: true });
  const run = await parent(); await until(wire.initialReceived);
  return { run, release: () => writeFileSync(gate, 'release') };
}

/** The delegation service the peers send through, and a credential per run. */
function conversations() {
  process.env.CEZ_DELEGATION = '1';
  const service = new DelegationService();
  const detach = service.registerProject({ id: 'project', root, store, manager });
  const credentials = new CredentialRegistry();
  onTestFinished(() => { detach(); credentials.close(); });
  const callerFor = (runId: string) => credentials.authenticate(credentials.issue('project', runId, randomUUID()))!;
  const say = (from: string, to: string, text = 'peer update') => {
    const id = randomUUID();
    return service.send(callerFor(from), { id, recipientRunId: to, kind: 'progress', text, timeoutSeconds: 600 }).then(() => id);
  };
  return { service, callerFor, say };
}

/** Another root task of the project; `provisioned: false` is a top-level run with no delegation record. */
function peer(status: RunRecord['status'] = RUN_STATUS.running, provisioned = true): string {
  const run = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
  store.updateRun(run.id, { status, ...(provisioned ? { delegation: { role: 'root', permissions: ['spawn', 'wait', 'steer'], receipts: [] } } : {}) });
  return run.id;
}

/** `cezar_wait` kind `peer` from the run's live session. */
async function waitOnPeers(runId: string, peerIds: string[], timeoutSeconds = 600): Promise<PeerWaitEntry> {
  const registered = await handlers(runId).registerWait({ kind: WAIT_KIND.peer, peer_ids: peerIds, timeout_seconds: timeoutSeconds }, 'cezar_wait', new AbortController().signal);
  expect(registered.answer).toMatchObject({ ok: true, kind: WAIT_KIND.peer });
  if (!('wait' in registered)) throw new Error('peer wait not registered');
  return registered.wait as PeerWaitEntry;
}

/** A parent parked on a peer wait for one peer. */
async function parkedOnPeer(timeoutSeconds = 600) {
  const { run, release } = await heldParent();
  const b = peer();
  const entry = await waitOnPeers(run.id, [b], timeoutSeconds);
  release();
  await until(() => store.getRun(run.id)?.status === RUN_STATUS.waiting && entryOf(run.id, entry.id)?.phase === WAIT_PHASE.open);
  return { a: run.id, b, entry };
}

/** The run woke, took its input and parked on the wait again. */
async function parkedAgainOn(runId: string, waitId: string, inputId: string) {
  await until(() => delivered(runId, inputId));
  await until(() => store.getRun(runId)?.status === RUN_STATUS.waiting && stateOf(store.getRun(runId)!) === 'waiting:peer');
  expect(entryOf(runId, waitId)).toMatchObject({ phase: WAIT_PHASE.open });
}

describe('peer waits (R9)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('running → waiting:peer: the turn end parks on the peer wait with no slot, the idle timer armed, and reads waiting on 1 task', async () => {
    const { a, entry } = await parkedOnPeer();
    const run = store.getRun(a)!;
    expect(stateOf(run)).toBe('waiting:peer');
    expect(entry).toMatchObject({ kind: WAIT_KIND.peer, phase: WAIT_PHASE.open, timeoutSeconds: 600 });
    expect(internals().monitoring.has(a)).toBe(false);
    expect(semaphore.busy()).toBe(0);
    expect(internals().active.get(a)?.idleTimer).toBeDefined();
    expect(deriveAttention(run)).toMatchObject({ rung: 'waiting-on-workers', bucket: 'none', label: 'waiting on 1 task' });
  });

  it('a named peer\'s message resolves the wait as message and wakes the run with it', async () => {
    const { say } = conversations();
    const { a, b, entry } = await parkedOnPeer();
    const id = await say(b, a, 'Wave 2 is merged; start the migration.');
    await until(() => settledOf(a, entry.id)?.phase === WAIT_PHASE.delivered);
    expect(settledOf(a, entry.id)).toMatchObject({ result: { reason: 'message', peerRunId: b, messageId: id } });
    expect(delivered(a, id)).toBe(true);
    expect(notes(a)).toContain(`automatic peer wake-up (1/${MAX_AUTO_CONTINUES})`);
  });

  it('a message from a peer the wait does not name wakes the run and the wait stays open', async () => {
    const { say } = conversations();
    const { a, entry } = await parkedOnPeer();
    const id = await say(peer(), a, 'unrelated');
    await parkedAgainOn(a, entry.id, id);
  });

  it('a human message wakes the run and the wait stays open', async () => {
    const { a, entry } = await parkedOnPeer();
    expect(manager.sendMessage(a, [{ type: 'text', text: 'human update' }])).toBe(true);
    await until(() => store.readEvents(a).some(event => event.type === 'user-message'));
    await until(() => store.getRun(a)?.status === RUN_STATUS.waiting && stateOf(store.getRun(a)!) === 'waiting:peer');
    expect(entryOf(a, entry.id)).toMatchObject({ phase: WAIT_PHASE.open });
  });

  it('a message from its own worker wakes the run and the wait stays open', async () => {
    const { say } = conversations();
    const { a, entry } = await parkedOnPeer();
    const w = await worker(a);
    fixtureUpdateRun(w.id, { status: RUN_STATUS.running });
    const id = await say(w.id, a, 'family update');
    await parkedAgainOn(a, entry.id, id);
  });

  it.each([RUN_STATUS.review, RUN_STATUS.done, RUN_STATUS.failed, RUN_STATUS.cancelled])('a named peer that settles %s resolves the wait as settled', async status => {
    const { a, b, entry } = await parkedOnPeer();
    store.updateRun(b, { status });
    await until(() => anyOf(a, entry.id)?.phase !== WAIT_PHASE.open);
    expect(anyOf(a, entry.id)).toMatchObject({ result: { reason: 'settled', peerRunId: b } });
  });

  it('a named peer that is deleted resolves the wait as settled', async () => {
    const { run, release } = await heldParent();
    const b = peer(RUN_STATUS.waiting, false);
    const entry = await waitOnPeers(run.id, [b]);
    release();
    await until(() => store.getRun(run.id)?.status === RUN_STATUS.waiting);
    expect(store.deleteRun(b)).toBe(true);
    await until(() => anyOf(run.id, entry.id)?.phase !== WAIT_PHASE.open);
    expect(anyOf(run.id, entry.id)).toMatchObject({ result: { reason: 'settled', peerRunId: b } });
  });

  it('the deadline resolves the wait as timeout', async () => {
    const { a, entry } = await parkedOnPeer(1);
    await until(() => anyOf(a, entry.id)?.phase !== WAIT_PHASE.open);
    expect(anyOf(a, entry.id)).toMatchObject({ result: { reason: 'timeout' } });
  });

  it('another wait resolving beside it wakes the run and the peer wait stays open', async () => {
    const { a, entry } = await parkedOnPeer();
    const gone = spawnSync('true').pid;
    const { answer } = await handlers(a).registerWait({ kind: WAIT_KIND.process, pid: gone }, 'cezar_wait', new AbortController().signal);
    expect(answer.ok).toBe(true);
    const processWait = answer.ok ? answer.wait_id : '';
    await until(() => settledOf(a, processWait)?.phase === WAIT_PHASE.delivered);
    await until(() => store.getRun(a)?.status === RUN_STATUS.waiting && stateOf(store.getRun(a)!) === 'waiting:peer');
    expect(entryOf(a, entry.id)).toMatchObject({ phase: WAIT_PHASE.open });
  });

  it('a resolution with the wake budget spent is not admitted: the wait is cancelled and Cezar\'s budget question opens', async () => {
    const { say } = conversations();
    const { a, b, entry } = await parkedOnPeer();
    store.updateRun(a, { automaticWakes: MAX_AUTO_CONTINUES });
    const id = await say(b, a);
    await until(() => settledOf(a, entry.id)?.phase === WAIT_PHASE.cancelled);
    expect(notes(a)).toContain(`automatic peer wake-up cap reached (${MAX_AUTO_CONTINUES}); peer wait ${entry.id} cancelled`);
    await until(() => stateOf(store.getRun(a)!) === 'waiting:human');
    expect(deriveAttention(store.getRun(a)!).label).toBe('needs you');
    expect(delivered(a, id)).toBe(false);
  });

  it('Stop cancels the run and the wait', async () => {
    const { a, entry } = await parkedOnPeer();
    manager.cancel(a);
    await until(() => store.getRun(a)?.status === RUN_STATUS.cancelled);
    expect(settledOf(a, entry.id)).toMatchObject({ phase: WAIT_PHASE.cancelled });
  });

  it('a restart re-arms the wait, and a message committed before the crash resolves it on reconcile', async () => {
    const { say } = conversations();
    const { a, b, entry } = await parkedOnPeer();
    // The crash lands after the message commit and before anything resolved the wait.
    vi.spyOn(manager, 'deliverConversationInput').mockImplementation(() => {});
    const id = await say(b, a);
    expect(entryOf(a, entry.id)).toMatchObject({ phase: WAIT_PHASE.open });
    await restart();
    await until(() => anyOf(a, entry.id)?.phase !== WAIT_PHASE.open);
    expect(anyOf(a, entry.id)).toMatchObject({ result: { reason: 'message', peerRunId: b, messageId: id } });
  });

  // Recovery records an interrupted peer failed and then continues it: that is not a settlement.
  it('a restart that recovers an interrupted named peer leaves the wait open', async () => {
    const { run, release } = await heldParent();
    const b = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'peer task', runner: 'claude' });
    const entry = await waitOnPeers(run.id, [b.id]);
    release();
    // The waiter parks and frees the slot; the peer runs a turn of its own.
    await until(() => !!store.getRun(b.id)?.steps.some(step => step.sessionId) && store.getRun(b.id)?.status === RUN_STATUS.waiting);
    // The controller dies while the peer is mid-turn: recovery fails it as interrupted, then continues it.
    const midTurn = (row: RunRecord): RunRecord => ({ ...row, status: RUN_STATUS.running, waits: undefined, steps: row.steps.map(step => ({ ...step, status: STEP_STATUS.running })) });
    const disk = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).map(row => row.id === b.id ? midTurn(row) : row);
    await restart(false, disk);
    await until(() => /interrupted/.test(store.getRun(b.id)?.error ?? '') || store.readEvents(b.id).some(event => String(event.message ?? '').includes('cezar restarted')));
    expect(store.getRun(b.id)?.status).not.toBe(RUN_STATUS.failed);
    expect(entryOf(run.id, entry.id)).toMatchObject({ phase: WAIT_PHASE.open });
  });

  // The store reads an unreadable row as no record, as it reads a deleted one: that is not a settlement.
  it('a restart that cannot read the named peer\'s row leaves the wait open', async () => {
    const { a, b, entry } = await parkedOnPeer();
    const disk = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).map(row => row.id === b ? { ...row, status: 'unknown-status' } : row);
    await restart(false, disk);
    expect(store.isUnreadable(b)).toBe(true);
    expect(store.getRun(b)).toBeUndefined();
    expect(entryOf(a, entry.id)).toMatchObject({ phase: WAIT_PHASE.open });
  });

  it('a restart past the deadline resolves the wait as timeout', async () => {
    const { a, entry } = await parkedOnPeer();
    store.commitWait(a, { ...(entryOf(a, entry.id) as PeerWaitEntry), deadline: new Date(Date.now() - 1_000).toISOString() });
    await restart();
    await until(() => anyOf(a, entry.id)?.phase !== WAIT_PHASE.open);
    expect(anyOf(a, entry.id)).toMatchObject({ result: { reason: 'timeout' } });
  });
});

describe('peer wait registration', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('a peer already settled resolves the wait at once', async () => {
    const { run, release } = await heldParent();
    const b = peer(RUN_STATUS.done);
    const entry = await waitOnPeers(run.id, [b]);
    expect(anyOf(run.id, entry.id)).toMatchObject({ phase: WAIT_PHASE.resolved, result: { reason: 'settled', peerRunId: b } });
    release();
  });

  it('a message from a named peer that the run has not received resolves the wait at once', async () => {
    const { say } = conversations();
    const { run, release } = await heldParent();
    const b = peer();
    vi.spyOn(manager, 'deliverConversationInput').mockImplementation(() => {});
    const id = await say(b, run.id);
    const entry = await waitOnPeers(run.id, [b]);
    expect(anyOf(run.id, entry.id)).toMatchObject({ phase: WAIT_PHASE.resolved, result: { reason: 'message', peerRunId: b, messageId: id } });
    release();
  });

  it('naming a non-peer is refused with denied_scope: an unknown task, itself, or its own worker', async () => {
    const { run, release } = await heldParent();
    const w = await worker(run.id);
    for (const id of [randomUUID(), run.id, w.id]) {
      const { answer } = await handlers(run.id).registerWait({ kind: WAIT_KIND.peer, peer_ids: [peer(), id] }, 'cezar_wait', new AbortController().signal);
      expect(answer).toMatchObject({ ok: false, code: 'denied_scope' });
    }
    expect(store.getRun(run.id)?.waits ?? []).toEqual([]);
    release();
  });

  it('the same peers return the open wait', async () => {
    const { run, release } = await heldParent();
    const [b, c] = [peer(), peer()];
    const first = await waitOnPeers(run.id, [b, c]);
    expect((await waitOnPeers(run.id, [c, b], 30)).id).toBe(first.id);
    release();
  });

  it('cezar_wait kind request registers a request wait, and kind worker takes worker_ids only', async () => {
    const { service, callerFor } = conversations();
    const { run, release } = await heldParent();
    const b = peer();
    const request = randomUUID();
    await service.send(callerFor(run.id), { id: request, recipientRunId: b, kind: 'request', text: 'versions?', timeoutSeconds: 600 });
    const registered = await handlers(run.id).registerWait({ kind: 'request', request_ids: [request] }, 'cezar_wait', new AbortController().signal);
    expect(registered.answer).toMatchObject({ ok: true, kind: 'request' });
    expect('wait' in registered && registered.wait).toMatchObject({ kind: WAIT_KIND.worker, requestIds: [request] });
    // A request to a peer reads "waiting on replies" once the run parks on it.
    release();
    await until(() => store.getRun(run.id)?.status === RUN_STATUS.waiting);
    expect(deriveAttention(store.getRun(run.id)!).label).toBe('waiting on replies');
    // The tool server answers the shape refusal as invalid_request before this handler runs.
    await expect(handlers(run.id).registerWait({ kind: WAIT_KIND.worker, request_ids: [request] } as never, 'cezar_wait', new AbortController().signal)).rejects.toThrow();
  });

  it('cez message wait --peer and cez message cancel-wait answer the peer wait', async () => {
    const { service, callerFor } = conversations();
    const { run, release } = await heldParent();
    const b = peer();
    const registered = await service.waitPeers(callerFor(run.id), { peerIds: [b], timeoutSeconds: 600 });
    expect(registered.wait).toMatchObject({ peerIds: [b], phase: WAIT_PHASE.open });
    expect(registered.instruction).toContain('End your turn now');
    expect(entryOf(run.id, registered.wait.id)).toMatchObject({ kind: WAIT_KIND.peer, via: WAIT_VIA['cez-message-wait'] });
    const cancelled = await service.cancelWait(callerFor(run.id), { waitId: registered.wait.id });
    expect(cancelled.wait).toMatchObject({ id: registered.wait.id, phase: WAIT_PHASE.cancelled });
    release();
  });
});
