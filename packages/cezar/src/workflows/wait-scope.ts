import { randomUUID } from 'node:crypto';
import type { AgentInput, CezarWaitRequest, PeerWaitEntry, PeerWaitResult, RunRecord, Wait, WaitErrorCode } from '@open-mercato/cezar-contract';
import { WAIT_LIMIT } from '@open-mercato/cezar-contract/waits';
import { peerPair } from '../delegation/conversations.ts';
import { hasLiveInboxClaim } from '../delegation/input.ts';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { identicalPeerWait, openWaits } from './waits.ts';

/**
 * Who a run may wait on, and what a delegation wait records at registration: owned workers,
 * replies to its own requests (hearsay-tools/cezarion#1235), or named peer root tasks
 * (hearsay-tools/cezarion#1995). Pure reads of the records `getRun` returns; refusals throw
 * `DelegationPolicyError`. RunManager owns the commit, the arming and the park.
 */
type GetRun = (id: string) => RunRecord | undefined;
type Delegation = Exclude<NonNullable<RunRecord['delegation']>, { role: 'invalid' }>;
const LIVE = ['queued', 'running', 'waiting'];

/** Scope of a wait on workers: only a parent holding `wait` may select, and only workers it owns. */
export function assertOwnedWorkerWaitScope(runId: string, delegation: Delegation, workerIds: readonly string[], getRun: GetRun): void {
  if (delegation.role !== 'root' || !delegation.permissions.includes('wait')) throw new DelegationPolicyError('denied_scope', 'Only a parent may wait for owned workers');
  for (const id of workerIds) {
    const worker = getRun(id);
    if (worker?.delegation?.role !== 'worker' || worker.delegation.parentRunId !== runId ||
      worker.delegation.workspace.ownerRunId !== id) throw new DelegationPolicyError('denied_scope', 'not an owned worker');
  }
}

/** Scope of a wait on replies: the caller's own accepted requests, read from its family root's conversation. */
export function assertRequestWaitScope(run: RunRecord, delegation: Delegation, requestIds: readonly string[], getRun: GetRun): void {
  const root = delegation.role === 'root' ? run : getRun(delegation.parentRunId);
  if (root?.delegation?.role !== 'root' || (delegation.role === 'root' && !delegation.permissions.includes('wait'))) {
    throw new DelegationPolicyError('denied_scope', 'Request wait scope denied');
  }
  for (const id of requestIds) {
    if (!root.delegation.conversation?.messages.some(message => message.id === id && message.kind === 'request' &&
      message.state === 'accepted' && message.senderRunId === run.id)) throw new DelegationPolicyError('denied_scope', 'Request wait scope denied');
  }
}

/** A worker entry's target fields: each worker's revision at registration, or the requests with no outcome yet. */
export function workerWaitTarget(request: { workerIds?: string[]; requestIds?: string[] | undefined }, getRun: GetRun) {
  if (!request.workerIds) return { requestIds: request.requestIds!, requestOutcomes: [] };
  return { workerIds: request.workerIds, outcomes: [], revisions: request.workerIds.map(workerId => {
    const metadata = getRun(workerId)!.delegation;
    return { workerId, revision: metadata?.role === 'worker' ? metadata.executionRevision ?? 0 : 0 };
  }) };
}

/**
 * A new `peer` wait (spec 2026-10-27-task-communication-protocol § 7), or the open one the same
 * peers repeat. Every name must pass the relationship resolver as a peer (`peerPair`), else
 * `denied_scope`, so a worker cannot register one. A full wait list is `capacity_limit`.
 */
export function peerWaitEntry(run: RunRecord, request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-message-wait',
  turnId: () => string, getRun: GetRun): PeerWaitEntry {
  for (const id of request.peerIds) if (!peerPair(run, getRun(id), false)) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
  const repeated = identicalPeerWait(run.waits ?? [], request.peerIds);
  if (repeated) return repeated;
  if (openWaits(run).length >= WAIT_LIMIT) throw new DelegationPolicyError('capacity_limit', `This run already has ${WAIT_LIMIT} open waits; cancel one first`);
  const now = Date.now();
  return { id: randomUUID(), kind: 'peer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
    deadline: new Date(now + request.timeoutSeconds * 1000).toISOString(), timeoutSeconds: request.timeoutSeconds,
    turnId: turnId(), phase: 'open', peerIds: request.peerIds };
}

/** The run's peer wait `waitId`, open or settled, for `cez message cancel-wait`. */
export function peerWaitOf(run: RunRecord | undefined, waitId: string): PeerWaitEntry {
  const entry = [...run?.waits ?? [], ...run?.lastWaits ?? []].find((wait): wait is PeerWaitEntry => wait.id === waitId && wait.kind === 'peer');
  if (!entry) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
  return entry;
}

/**
 * Why an open peer wait resolves now, if it does: a message from a named peer that the run has not
 * received (`message`), else a named peer that settled or was deleted (`settled`), never one whose
 * row the store cannot read. The message comes
 * first, so a peer that wrote and then finished reports what it wrote. The deadline is the timer's.
 */
export function peerWaitResult(run: RunRecord, wait: PeerWaitEntry, peers: { getRun: GetRun; isUnreadable(id: string): boolean }): PeerWaitResult | undefined {
  const message = run.agentInputs?.find((input: AgentInput) => !input.deliveredAt && !hasLiveInboxClaim(input) &&
    input.conversation?.relationship === 'peer' && wait.peerIds.includes(input.conversation.senderRunId));
  if (message) return { reason: 'message', peerRunId: message.conversation!.senderRunId, messageId: message.id };
  // The store reads an unreadable row as no record too: that peer is not known to be gone.
  const settled = wait.peerIds.find(id => { const peer = peers.getRun(id); return peer ? !LIVE.includes(peer.status) : !peers.isUnreadable(id); });
  return settled ? { reason: 'settled', peerRunId: settled } : undefined;
}

/** The runs whose open peer wait names this peer, once it has settled; a deleted peer is its id.
 *  A live peer settles nobody's wait, so the live set is read only for a settled one. */
export function runsAwaitingPeer(peer: RunRecord | string, runs: () => readonly RunRecord[]): string[] {
  if (typeof peer !== 'string' && LIVE.includes(peer.status)) return [];
  const peerId = typeof peer === 'string' ? peer : peer.id;
  const names = (wait: Wait) => wait.kind === 'peer' && wait.peerIds.includes(peerId);
  return runs().filter(run => openWaits(run).some(names)).map(run => run.id);
}

type DelegationWait = Extract<CezarWaitRequest, { kind: 'worker' | 'request' | 'peer' }>;
/** The `cezar_wait` kinds the delegation registration serves, under the tool's own codes. */
export function isDelegationWait(request: CezarWaitRequest): request is DelegationWait {
  return request.kind === 'worker' || request.kind === 'request' || request.kind === 'peer';
}

/** `cezar_wait` kinds `worker` and `request` as the worker entry's target (hearsay-tools/cezarion#1995). */
export function workerListTarget(request: Extract<CezarWaitRequest, { kind: 'worker' | 'request' }>) {
  return { ...(request.kind === 'worker' ? { workerIds: request.worker_ids } : { requestIds: request.request_ids }),
    ...(request.mode === undefined ? {} : { mode: request.mode }), timeoutSeconds: request.timeout_seconds };
}

/** A delegation wait's refusal under `cezar_wait`'s own codes. Anything but a policy refusal is
 *  rethrown, for the tool server to answer `unavailable`. */
export function delegationWaitRefusal(error: unknown, finishing: () => boolean): WaitErrorCode {
  if (!(error instanceof DelegationPolicyError)) throw error;
  if (error.code === 'denied_scope') return 'denied_scope';
  if (error.code === 'capacity_limit') return 'capacity';
  return finishing() ? 'root_finish_pending' : 'unavailable';
}
