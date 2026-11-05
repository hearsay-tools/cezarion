import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../runs/store.ts';
import { addOutcome, addRequest, fakeStore, iso, makeRoot, makeWorker, NOW, rootOf, type FakeStoreOptions } from './activity.testkit.ts';
import { readActivityRequests } from './requests.ts';

const OUTCOME = requestOutcomeSchema.shape.status.enum;

type Options = FakeStoreOptions & { active?: readonly string[]; roots?: readonly string[]; carryOver?: Iterable<string> };
const readRequests = (runs: readonly RunRecord[], options: Options = {}) => readActivityRequests(fakeStore(runs, options), {
  now: NOW,
  isActive: (id) => options.active?.includes(id) ?? false,
  ...(options.roots ? { roots: options.roots } : {}),
  ...(options.carryOver ? { carryOver: options.carryOver } : {}),
});
const openIds = (runs: readonly RunRecord[], options?: Options) => readRequests(runs, options).requests.map((request) => request.requestId);
const closedOf = (runs: readonly RunRecord[], options?: Options) => readRequests(runs, options).closed.map((entry) => [entry.requestId, entry.status]);

/** A root and one worker; the worker settled when `complete`. */
function family(workerStatus: RunRecord['status'] = RUN_STATUS.running) {
  const root = makeRoot({ status: RUN_STATUS.waiting });
  const worker = makeWorker(root, { status: workerStatus });
  return { root, worker };
}

/** Two root tasks of one project. */
function peers(recipientStatus: RunRecord['status'] = RUN_STATUS.running) {
  const sender = makeRoot({ status: RUN_STATUS.waiting, title: 'Sender' });
  const recipient = makeRoot({ status: recipientStatus, title: 'Recipient' });
  return { sender, recipient };
}

describe('the request case table', () => {
  it('worker asks parent: an open family line from the worker row', () => {
    const { root, worker } = family();
    const question = addRequest(root, worker, root, { deadline: iso(60_000) });
    expect(readRequests([root, worker]).requests).toEqual([{
      requestId: question.id, relationship: 'family', senderRunId: worker.id, recipientRunId: root.id, text: 'Which branch?',
      senderTitle: worker.title, recipientTitle: root.title, createdAt: question.createdAt, deadline: question.deadline,
    }]);
  });

  it('parent replies: closed with its stored outcome, so the reply comet runs', () => {
    const { root, worker } = family();
    const question = addRequest(root, worker, root);
    addOutcome(root, { requestId: question.id, status: OUTCOME.replied, replyId: randomUUID() });
    expect(openIds([root, worker])).toEqual([]);
    expect(closedOf([root, worker])).toEqual([[question.id, OUTCOME.replied]]);
  });

  it('a worker question times out: closed; reconcile alone writes no closed entry', () => {
    const { root, worker } = family();
    const expired = addRequest(root, worker, root, { deadline: iso(-1_000) });
    expect(openIds([root, worker])).toEqual([]);
    expect(closedOf([root, worker])).toEqual([]);
    addOutcome(root, { requestId: expired.id, status: OUTCOME['timed-out'] });
    expect(closedOf([root, worker])).toEqual([[expired.id, OUTCOME['timed-out']]]);
  });

  it('worker destroyed while asking: the sender closed', () => {
    const { root, worker } = family(RUN_STATUS.cancelled);
    addRequest(root, worker, root);
    expect(openIds([root, worker], { complete: [worker.id] })).toEqual([]);
  });

  it('parent asks worker; worker destroyed: closed', () => {
    const { root, worker } = family(RUN_STATUS.cancelled);
    (worker.delegation as { destroy?: unknown }).destroy = { phase: 'complete' };
    addRequest(root, root, worker);
    expect(openIds([root, worker])).toEqual([]);
  });

  it('parent asks worker; worker rests at review: open, the parent can resume it', () => {
    const { root, worker } = family(RUN_STATUS.review);
    const request = addRequest(root, root, worker);
    expect(openIds([root, worker], { complete: [worker.id] })).toEqual([request.id]);
  });

  it.each([RUN_STATUS.done, RUN_STATUS.failed, RUN_STATUS.cancelled])('a worker recipient that ends %s closes it once settled', (status) => {
    const { root, worker } = family(status);
    const request = addRequest(root, root, worker);
    // Status alone closes nothing: the lifecycle is not settled yet.
    expect(openIds([root, worker])).toEqual([request.id]);
    expect(openIds([root, worker], { complete: [worker.id] })).toEqual([]);
  });

  it.each([RUN_STATUS.review, RUN_STATUS.done, RUN_STATUS.failed, RUN_STATUS.cancelled])('a peer recipient that ends %s closes it once settled', (status) => {
    const { sender, recipient } = peers(status);
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    expect(openIds([sender, recipient], { active: [recipient.id] })).toEqual([request.id]);
    expect(openIds([sender, recipient])).toEqual([]);
  });

  it.each([RUN_STATUS.done, RUN_STATUS.failed, RUN_STATUS.cancelled])('a sender that ends %s closes it once settled', (status) => {
    const { sender, recipient } = peers();
    sender.status = status;
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    expect(openIds([sender, recipient], { held: [sender.id, recipient.id], active: [sender.id] })).toEqual([request.id]);
    expect(openIds([sender, recipient], { held: [sender.id, recipient.id] })).toEqual([]);
  });

  it('a human pressed Finish on the sender: closed', () => {
    const { sender, recipient } = peers();
    rootOf(sender).finishRequestedAt = iso(-1_000);
    addRequest(sender, sender, recipient, { relationship: 'peer' });
    expect(openIds([sender, recipient], { active: [sender.id] })).toEqual([]);
  });

  it('the recipient’s record cannot be read: open, with no recipient title', () => {
    const { sender, recipient } = peers();
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    const [open] = readRequests([sender, recipient], { unreadable: [recipient.id] }).requests;
    expect(open?.requestId).toBe(request.id);
    expect(open).not.toHaveProperty('recipientTitle');
    expect(open?.senderTitle).toBe('Sender');
  });

  it('the sender’s history deletion is in progress: its ledger is skipped', () => {
    const { sender, recipient } = peers();
    addRequest(sender, sender, recipient, { relationship: 'peer' });
    rootOf(sender).historyDeletion = 'pending';
    expect(readRequests([sender, recipient])).toEqual({ requests: [], closed: [], openLedgers: new Set() });
  });

  it('the recipient’s history deletion is in progress: open until its record goes', () => {
    const { sender, recipient } = peers();
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    rootOf(recipient).historyDeletion = 'pending';
    expect(openIds([sender, recipient])).toEqual([request.id]);
    expect(openIds([sender])).toEqual([]);
  });

  it('the recipient’s Finish is pending while its workers live: open', () => {
    const { sender, recipient } = peers();
    rootOf(recipient).finishRequestedAt = iso(-1_000);
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    expect(openIds([sender, recipient], { active: [recipient.id] })).toEqual([request.id]);
  });

  it('root A asks root B, B replies, and the reply sits in A’s ledger', () => {
    const { sender, recipient } = peers();
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    expect(readRequests([sender, recipient]).requests.map((entry) => [entry.relationship, entry.senderRunId, entry.recipientRunId]))
      .toEqual([['peer', sender.id, recipient.id]]);
    addOutcome(sender, { requestId: request.id, status: OUTCOME.replied, replyId: randomUUID() });
    expect(readRequests([sender, recipient]).closed).toEqual([{ requestId: request.id, senderRunId: sender.id, recipientRunId: recipient.id, status: OUTCOME.replied, observedAt: iso(-1_000) }]);
  });

  it('B’s record deleted: closed', () => {
    const { sender, recipient } = peers();
    addRequest(sender, sender, recipient, { relationship: 'peer' });
    expect(openIds([sender])).toEqual([]);
  });

  it('a late reply after a timeout stays closed, with no second entry', () => {
    const { sender, recipient } = peers();
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    addOutcome(sender, { requestId: request.id, status: OUTCOME['replied-late'], replyId: randomUUID() });
    expect(openIds([sender, recipient])).toEqual([]);
    expect(closedOf([sender, recipient])).toEqual([]);
  });

  it('either side leaves the active set while open: the request stays, with both titles', () => {
    const { sender, recipient } = peers(RUN_STATUS.review);
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    const [open] = readRequests([sender, recipient], { active: [recipient.id] }).requests;
    expect(open).toMatchObject({ requestId: request.id, senderTitle: 'Sender', recipientTitle: 'Recipient' });
  });

  it.each(['continuation-required', 'destroyed'] as const)('a send not delivered (%s) never opened', (state) => {
    const { sender, recipient } = peers();
    addRequest(sender, sender, recipient, { relationship: 'peer', state });
    expect(openIds([sender, recipient])).toEqual([]);
  });

  it.each([RUN_STATUS.queued, RUN_STATUS.waiting])('a %s recipient: open', (status) => {
    const { sender, recipient } = peers(status);
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    expect(openIds([sender, recipient])).toEqual([request.id]);
  });

  it('the parent stops while its worker’s routed question is open: stored cancelled, closed', () => {
    const { root, worker } = family();
    const question = addRequest(root, worker, root);
    addOutcome(root, { requestId: question.id, status: OUTCOME.cancelled });
    expect(openIds([root, worker])).toEqual([]);
    expect(closedOf([root, worker])).toEqual([[question.id, OUTCOME.cancelled]]);
  });

  it('the sender’s history deleted: the ledger is gone, nothing is drawn', () => {
    const { sender, recipient } = peers();
    addRequest(sender, sender, recipient, { relationship: 'peer' });
    expect(readRequests([recipient], { roots: [sender.id] })).toEqual({ requests: [], closed: [], openLedgers: new Set() });
  });

  it('a request with no deadline has none', () => {
    const { root, worker } = family();
    addRequest(root, worker, root);
    expect(readRequests([root, worker]).requests[0]).not.toHaveProperty('deadline');
  });

  it('clamps the text to 500 characters', () => {
    const { sender, recipient } = peers();
    addRequest(sender, sender, recipient, { relationship: 'peer', text: 'x'.repeat(600) });
    expect(readRequests([sender, recipient]).requests[0]?.text).toHaveLength(500);
  });

  it('lists only outcomes stored in the last 30 s', () => {
    const { root, worker } = family();
    const recent = addRequest(root, worker, root);
    const old = addRequest(root, worker, root);
    addOutcome(root, { requestId: recent.id, status: OUTCOME.replied, observedAt: iso(-30_000) });
    addOutcome(root, { requestId: old.id, status: OUTCOME.replied, observedAt: iso(-30_001) });
    expect(closedOf([root, worker])).toEqual([[recent.id, OUTCOME.replied]]);
  });
});

describe('which ledgers are read', () => {
  it('a pinned terminal root whose lifecycle has not settled keeps its open requests', () => {
    const { sender, recipient } = peers();
    sender.status = RUN_STATUS.done;
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    // Not live and not pinned: no ledger read finds it.
    expect(openIds([sender, recipient], { held: [recipient.id] })).toEqual([]);
    expect(openIds([sender, recipient], { held: [sender.id, recipient.id], active: [sender.id] })).toEqual([request.id]);
  });

  it('a held worker brings its family’s ledger', () => {
    const { root, worker } = family();
    root.status = RUN_STATUS.review;
    const question = addRequest(root, worker, root);
    expect(openIds([root, worker], { held: [worker.id] })).toEqual([question.id]);
  });

  it('a foreign live root: read through the claims, never settled by this process', () => {
    const { sender, recipient } = peers();
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    expect(openIds([sender, recipient], { held: [], foreign: [sender.id, recipient.id] })).toEqual([request.id]);
  });

  it('a foreign terminal root that is still claimed (live = 0) keeps its request open', () => {
    const { sender, recipient } = peers();
    sender.status = RUN_STATUS.done;
    const workerOfSender = makeWorker(sender, { status: RUN_STATUS.done });
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    // The claim lists the family's worker first; its root is what is read.
    expect(openIds([sender, recipient, workerOfSender], { held: [recipient.id], foreign: [workerOfSender.id, sender.id] })).toEqual([request.id]);
    // The same root, held by nobody: this process may settle it.
    expect(openIds([sender, recipient, workerOfSender], { held: [recipient.id], roots: [sender.id] })).toEqual([]);
  });

  it('a sender that settles right after a reply: the carry-over still finds the stored reply', () => {
    const { sender, recipient } = peers();
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    const first = readRequests([sender, recipient]);
    expect(first.openLedgers).toEqual(new Set([sender.id]));
    addOutcome(sender, { requestId: request.id, status: OUTCOME.replied, replyId: randomUUID() });
    sender.status = RUN_STATUS.done;
    // The sender left both sets before the next read.
    expect(closedOf([sender, recipient], { held: [recipient.id] })).toEqual([]);
    const next = readRequests([sender, recipient], { held: [recipient.id], carryOver: first.openLedgers });
    expect(next.closed.map((entry) => [entry.requestId, entry.status])).toEqual([[request.id, OUTCOME.replied]]);
    expect(next.openLedgers).toEqual(new Set());
  });

  it('reads a root in both sets once', () => {
    const { sender, recipient } = peers();
    addRequest(sender, sender, recipient, { relationship: 'peer' });
    expect(openIds([sender, recipient], { foreign: [sender.id], roots: [sender.id], carryOver: [sender.id] })).toHaveLength(1);
  });
});
