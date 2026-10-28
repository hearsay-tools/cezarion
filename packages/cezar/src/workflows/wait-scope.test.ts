import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentInput, RunRecord } from '@open-mercato/cezar-contract';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { WAIT_LIMIT } from '@open-mercato/cezar-contract/waits';
import { makePeerWait, makeRunRecord, makeTimerWait, RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { delegationWaitRefusal, peerWaitEntry, peerWaitOf, peerWaitResult, runsAwaitingPeer, workerListTarget } from './wait-scope.ts';

// The peer wait's pure rules (hearsay-tools/cezarion#1995, spec 2026-10-27-task-communication-protocol § 7).
const root = (over: Partial<RunRecord> = {}): RunRecord => makeRunRecord({ id: randomUUID(), status: RUN_STATUS.running,
  delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] }, ...over });
const lookup = (...runs: RunRecord[]) => (id: string) => runs.find(run => run.id === id);
const request = (peerIds: string[]) => ({ peerIds, timeoutSeconds: 600 });
const turn = () => 'turn-1';
const peerInput = (senderRunId: string, over: Partial<AgentInput> = {}): AgentInput => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: senderRunId,
  text: 'hello', createdAt: new Date().toISOString(), conversation: { senderRunId, recipientRunId: 'self', kind: 'progress', relationship: 'peer' }, ...over });

describe('peerWaitEntry', () => {
  it('builds an open wait on root peers, with its deadline', () => {
    const [a, b] = [root(), root({ delegation: undefined })];
    const entry = peerWaitEntry(a, request([b.id]), WAIT_VIA['cez-message-wait'], turn, lookup(a, b));
    expect(entry).toMatchObject({ phase: WAIT_PHASE.open, peerIds: [b.id], timeoutSeconds: 600, via: WAIT_VIA['cez-message-wait'], turnId: 'turn-1' });
    expect(Date.parse(entry.deadline) - Date.parse(entry.registeredAt)).toBe(600_000);
  });

  it('refuses with denied_scope a worker registrant, a worker peer, itself, an unknown task and a family deleting its history', () => {
    const a = root(); const b = root();
    const worker = makeRunRecord({ id: randomUUID(), status: RUN_STATUS.running,
      delegation: { role: 'worker', permissions: [], parentRunId: a.id, workspace: { ownerRunId: 'w', resourceId: randomUUID(), kind: 'owned-isolated', path: '/w', branch: 'w', baselineSha: 'a'.repeat(40) } } });
    const deleting = root({ delegation: { role: 'root', permissions: [], receipts: [], historyDeletion: 'pending' } });
    const refused = (self: RunRecord, ids: string[]) => () => peerWaitEntry(self, request(ids), WAIT_VIA.cezar_wait, turn, lookup(a, b, worker, deleting));
    expect(refused(worker, [b.id])).toThrow(expect.objectContaining({ code: 'denied_scope' }));
    for (const ids of [[b.id, worker.id], [a.id], [randomUUID()], [deleting.id]]) expect(refused(a, ids)).toThrow(expect.objectContaining({ code: 'denied_scope' }));
  });

  it('returns the open wait the same peers repeat, and refuses a full wait list', () => {
    const b = root(); const c = root();
    const open = makePeerWait({ peerIds: [b.id, c.id] });
    const a = root({ waits: [open] });
    expect(peerWaitEntry(a, request([c.id, b.id]), WAIT_VIA.cezar_wait, turn, lookup(a, b, c))).toBe(open);
    const full = root({ waits: Array.from({ length: WAIT_LIMIT }, () => makeTimerWait()) });
    expect(() => peerWaitEntry(full, request([b.id]), WAIT_VIA.cezar_wait, turn, lookup(full, b))).toThrow(expect.objectContaining({ code: 'capacity_limit' }));
  });
});

describe('peerWaitResult', () => {
  it('a named peer\'s unreceived message comes first, even when that peer has settled', () => {
    const b = root({ status: RUN_STATUS.done });
    const input = peerInput(b.id);
    const wait = makePeerWait({ peerIds: [b.id] });
    expect(peerWaitResult(root({ agentInputs: [input] }), wait, lookup(b))).toEqual({ reason: 'message', peerRunId: b.id, messageId: input.id });
    expect(peerWaitResult(root(), wait, lookup(b))).toEqual({ reason: 'settled', peerRunId: b.id });
  });

  it('ignores a received message, one an inbox read holds, a family message and another peer\'s message', () => {
    const b = root(); const other = root();
    const wait = makePeerWait({ peerIds: [b.id] });
    const claim = { receiptId: randomUUID(), generation: 'g', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const inputs = [peerInput(b.id, { deliveredAt: new Date().toISOString() }), peerInput(b.id, { inboxClaim: claim }), peerInput(other.id),
      peerInput(b.id, { conversation: { senderRunId: b.id, recipientRunId: 'self', kind: 'progress' } })];
    expect(peerWaitResult(root({ agentInputs: inputs }), wait, lookup(b, other))).toBeUndefined();
  });

  it('a deleted peer is settled', () => {
    const gone = randomUUID();
    expect(peerWaitResult(root(), makePeerWait({ peerIds: [gone] }), lookup())).toEqual({ reason: 'settled', peerRunId: gone });
  });
});

describe('cezar_wait kinds worker and request', () => {
  it('map onto the worker entry target, and policy refusals onto the tool codes', () => {
    const [w, r] = [randomUUID(), randomUUID()];
    expect(workerListTarget({ kind: WAIT_KIND.worker, worker_ids: [w], timeout_seconds: 600 })).toEqual({ workerIds: [w], timeoutSeconds: 600 });
    expect(workerListTarget({ kind: 'request', request_ids: [r], mode: 'all', timeout_seconds: 60 })).toEqual({ requestIds: [r], mode: 'all', timeoutSeconds: 60 });
    const policy = (code: ConstructorParameters<typeof DelegationPolicyError>[0]) => new DelegationPolicyError(code, 'x');
    expect(delegationWaitRefusal(policy('denied_scope'), () => true)).toBe('denied_scope');
    expect(delegationWaitRefusal(policy('capacity_limit'), () => true)).toBe('capacity');
    expect(delegationWaitRefusal(policy('incompatible_state'), () => true)).toBe('root_finish_pending');
    expect(delegationWaitRefusal(policy('incompatible_state'), () => false)).toBe('unavailable');
    expect(() => delegationWaitRefusal(new Error('disk'), () => false)).toThrow('disk');
  });
});

describe('the runs that wait on a peer', () => {
  it('lists runs whose open peer wait names it, and finds a settled wait by id', () => {
    const peer = randomUUID();
    const open = makePeerWait({ peerIds: [peer] });
    const settled = makePeerWait({ peerIds: [peer], phase: WAIT_PHASE.cancelled });
    const waiting = root({ waits: [open] });
    const runs = () => [waiting, root({ lastWaits: [settled] }), root()];
    expect(runsAwaitingPeer(peer, runs)).toEqual([waiting.id]);
    expect(runsAwaitingPeer(root({ id: peer, status: RUN_STATUS.done }), runs)).toEqual([waiting.id]);
    // A live peer settles no wait, and the live set is not read for it.
    expect(runsAwaitingPeer(root({ id: peer }), () => { throw new Error('read'); })).toEqual([]);
    expect(peerWaitOf(root({ lastWaits: [settled] }), settled.id)).toBe(settled);
    expect(() => peerWaitOf(waiting, randomUUID())).toThrow(expect.objectContaining({ code: 'denied_scope' }));
  });
});
