import type { ActivityClosedRequest, ActivityRequest, ConversationMessage } from '@open-mercato/cezar-contract';
import { ACTIVITY_CLOSED_WINDOW_MS, ACTIVITY_TEXT_MAX } from '@open-mercato/cezar-contract/activity';
import { reconcileConversationState } from '../delegation/conversations.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { clampText } from './text.ts';

/** What the request read needs from a project's run store. */
export type ActivityRequestStore = Pick<RunStore, 'listRuns' | 'listForeignClaimedRunIds' | 'getRun' | 'isUnreadable' | 'readWorkerExecution'>;

export interface ActivityRequestOptions {
  now: number;
  /** Whether this process's run manager runs the run now. */
  isActive: (runId: string) => boolean;
  /** More roots to read: the active cards, whose ledgers the view always shows. */
  roots?: Iterable<string>;
  /** A publisher's carry-over: the roots whose ledger held an open request in its last snapshot. */
  carryOver?: Iterable<string>;
}

export interface ActivityRequestRead {
  requests: ActivityRequest[];
  closed: ActivityClosedRequest[];
  /** The roots whose ledger holds an open request now: the next carry-over. */
  openLedgers: Set<string>;
}

/** The root whose ledger a run's family requests sit in. */
const familyRoot = (run: RunRecord): string => run.delegation?.role === 'worker' ? run.delegation.parentRunId : run.id;
const displayTitle = (run: RunRecord | undefined): string | undefined => run && (run.titleSummary ?? run.title);

/**
 * Open and recently closed requests (spec 2026-11-05-live-activity-view, Read model). The
 * ledgers read are a bounded union, never a scan of finished rows: the roots of the runs this
 * process holds or pins (`listRuns()`), the roots of every family another process claims
 * (`listForeignClaimedRunIds()`), the active cards and the carry-over. Each request sits in one
 * ledger (`ledgerFor` in the delegation service), so one read per root finds every request once.
 */
export function readActivityRequests(store: ActivityRequestStore, options: ActivityRequestOptions): ActivityRequestRead {
  const foreign = new Set(store.listForeignClaimedRunIds());
  const roots = new Set<string>(store.listRuns().map(familyRoot));
  for (const id of foreign) {
    const run = store.getRun(id);
    if (run) roots.add(familyRoot(run));
  }
  for (const id of options.roots ?? []) roots.add(id);
  for (const id of options.carryOver ?? []) roots.add(id);
  // The delegation service's own test, except that a root another process runs is never settled
  // here because this process's run manager does not hold it.
  const isSettled = (run: RunRecord) => run.delegation?.role === 'worker'
    ? store.readWorkerExecution(run.id)?.phase === 'complete'
    : !foreign.has(run.id) && !options.isActive(run.id);
  const nowIso = new Date(options.now).toISOString();
  const read: ActivityRequestRead = { requests: [], closed: [], openLedgers: new Set() };
  for (const id of roots) readLedger(store, id, { nowIso, now: options.now, isSettled }, read);
  read.requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId));
  read.closed.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.requestId.localeCompare(b.requestId));
  return read;
}

function readLedger(store: ActivityRequestStore, rootId: string, clock: { nowIso: string; now: number; isSettled: (run: RunRecord) => boolean },
  read: ActivityRequestRead): void {
  const root = store.getRun(rootId);
  // A ledger whose history is being deleted is skipped, as `projectConversationEvents` skips it.
  if (root?.delegation?.role !== 'root' || !root.delegation.conversation || root.delegation.historyDeletion) return;
  const stored = root.delegation.conversation;
  const state = reconcileConversationState(root, (id) => store.getRun(id), clock.nowIso, clock.isSettled, (id) => store.isUnreadable(id)) ?? stored;
  const settled = new Set(state.outcomes.map((outcome) => outcome.requestId));
  const requests = new Map<string, ConversationMessage>();
  for (const message of state.messages) {
    if (message.kind !== 'request') continue;
    requests.set(message.id, message);
    if (message.state !== 'accepted' || settled.has(message.id)) continue;
    read.openLedgers.add(root.id);
    read.requests.push(openRequest(store, message));
  }
  // Only stored outcomes: the ones reconcile adds carry the read's time, not the closure's. A late
  // reply amends a timeout; that request closed already.
  for (const outcome of stored.outcomes) {
    const request = requests.get(outcome.requestId);
    if (!request || outcome.status === 'replied-late' || Date.parse(outcome.observedAt) < clock.now - ACTIVITY_CLOSED_WINDOW_MS) continue;
    read.closed.push({ requestId: outcome.requestId, senderRunId: request.senderRunId, recipientRunId: request.recipientRunId, status: outcome.status, observedAt: outcome.observedAt });
  }
}

function openRequest(store: ActivityRequestStore, message: ConversationMessage): ActivityRequest {
  const senderTitle = displayTitle(store.getRun(message.senderRunId));
  const recipientTitle = displayTitle(store.getRun(message.recipientRunId));
  return {
    requestId: message.id,
    relationship: message.relationship ?? 'family',
    senderRunId: message.senderRunId,
    recipientRunId: message.recipientRunId,
    text: clampText(message.text, ACTIVITY_TEXT_MAX),
    ...(senderTitle === undefined ? {} : { senderTitle }),
    ...(recipientTitle === undefined ? {} : { recipientTitle }),
    createdAt: message.createdAt,
    ...(message.deadline === undefined ? {} : { deadline: message.deadline }),
  };
}
