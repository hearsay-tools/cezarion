import { waitPartDescribers, prompted, workerWaits, parkedOn, viaOf, gated, retryAtOnce, parentWithWorker, sessionOf, nudgeNotes, retryClock, silenceRefusals, noReplyNotes, humanOpen, nativeWire, asks, delivered, ASK_CONTEXT, questions, settled } from './waits-parity-fixture.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { MAX_WAKE_DELIVERY_ATTEMPTS, WAKE_SESSION_CLOSED_ERROR, WAKE_DELIVERY_CAP_NOTE, COMPLETION_NUDGE_NOTE, REFUSAL_DISCARDED_NOTE, WORKER_FALLBACK_QUESTION, NO_WAIT_NUDGE_NOTE, WORKER_FALLBACK_HEADER, WORKER_FALLBACK_REPLY_NOTE, MAX_AUTO_CONTINUES } from './run.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { it as registerTest, expect, onTestFinished } from 'vitest';
import { WAIT_VIA, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { exemptionFor, HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { until, timeline, store, manager, semaphore, eventCheckpoint, root, restart, checkpoint, delegatingParent, worker, parent } from './worker-wait-core.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import { withHeldAck } from '../core/owned-input-delivery.testkit.ts';
import { MESSAGE_WAKE_OPENING, toolCall, thenSay } from './waits-parity.testkit.ts';

// The closed part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity, describeWaitParityFamily } = waitPartDescribers('closed', closedCells);

/** Claude U22c/k/x cross several real process launches. Keep the shared 15 s guard per
 *  signal, rather than charging every delivery attempt to one window (hearsay-tools/cezarion#1450). */
const refusalStep = (runner: RunnerId, id: string, step: string, predicate: () => boolean) =>
  until(predicate, runner === 'claude' ? () => `${runner} ${step}\n${timeline(id)}` : undefined);

async function refusalDeliveryBound(runner: RunnerId, id: string, cell: string, closed: () => number) {
  const failed = () => store.getRun(id)?.status === 'failed' && !manager.isActive(id);
  if (runner !== 'claude') { await until(failed); return; }
  // bound: each existing 15 s guard covers one durable queue write, native admission, close,
  // or retry checkpoint. Three fresh mock processes no longer share one launch budget.
  await refusalStep(runner, id, `${cell}: refusal queued`, () =>
    store.getRun(id)?.agentInputs?.some(input => input.purpose === 'completion-refusal') === true);
  for (let attempt = 1; attempt <= MAX_WAKE_DELIVERY_ATTEMPTS; attempt++) {
    await refusalStep(runner, id, `${cell}: retry ${attempt} native admission`, () => prompted(runner, MESSAGE_WAKE_OPENING).length >= attempt);
    await refusalStep(runner, id, `${cell}: retry ${attempt} session close`, () => closed() >= attempt);
    if (attempt < MAX_WAKE_DELIVERY_ATTEMPTS) {
      // The counter clears at the cap. A later native admission also proves this retry was admitted.
      await refusalStep(runner, id, `${cell}: retry ${attempt} delivery checkpoint`, () =>
        (store.getRun(id)?.waitDeliveryFailures ?? 0) >= attempt || prompted(runner, MESSAGE_WAKE_OPENING).length > attempt || failed());
    }
  }
  await refusalStep(runner, id, `${cell}: delivery cap and inactive`, failed);
}
/** A nudge reply whose cezar_done the tool refuses while the blocker stays: no done at its turn
 *  end, so a live worker's turn end opens the implicit re-check timer (`parkedOnWorkersTimer`). */
const refusedDoneReply = () => `${toolCall('cezar_done', {})} ${thenSay('Still done.')}`;
/** Where a refused reply's turn end leaves the run: parked on the timer a turn end opens while
 *  workers run (`monitoring-line`), or, once that turn spent the run's wake budget or its nudge, on
 *  Squawk's human wait. Never on the completion wait: the tool refused the done. */
const parkedOnWorkersTimer = (id: string) => workerWaits(id).length === 0 && (parkedOn(id, viaOf(id, WAIT_VIA['monitoring-line'])) || gated(id));

export function closedCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    for (const legacy of [false, true]) {
      it(`${runner} U22c a refusal whose reopened sessions keep closing cleanly is queued once, stops at the delivery bound, and Continue delivers it once${legacy ? ' (legacy Finish)' : ''}`, async () => {
        retryAtOnce();
        const { p, w } = await parentWithWorker(runner, runner === 'claude' ? 'U22c' : undefined);
        const refusal = `Workers are still live: ${w.id}.`;
        const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
        const wakes = store.getRun(p.id)?.automaticWakes ?? 0;
        if (legacy) {
          const delegation = store.getRun(p.id)!.delegation!;
          if (delegation.role !== 'root') throw Error('root fixture');
          store.commitDelegation([{ id: p.id, delegation: { ...delegation, finishRequestedAt: new Date().toISOString() } }]);
        }
        let closing = true;
        let closed = 0;
        const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
          if (runId === p.id && event.type === 'turn-end' && closing && refusals().some(input => !input.deliveredAt)) {
            closed++;
            sessionOf(p.id).end();
          }
        };
        store.on('event', closeAtTurnEnd);
        try {
          sessionOf(p.id).end();
          await refusalDeliveryBound(runner, p.id, 'U22c', () => closed);
          // Each attempt is a scheduler continuation that closed before the refusal reached it.
          expect(prompted(runner, MESSAGE_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
          expect(prompted(runner, refusal)).toEqual([]);
          expect(refusals()).toEqual([expect.objectContaining({ source: 'lifecycle' })]);
          expect(refusals()[0]!.deliveredAt).toBeUndefined();
          expect(nudgeNotes(p.id)).toHaveLength(1);
          expect(store.getRun(p.id)?.automaticWakes).toBe(wakes + 1);
          expect(store.getRun(p.id)?.error).toBe(`continue failed: ${WAKE_SESSION_CLOSED_ERROR}`);
          expect(store.readEvents(p.id).filter(event => event.type === 'note' && event.message === WAKE_DELIVERY_CAP_NOTE)).toHaveLength(1);
          expect(retryClock.pending).toBe(0);
          expect(store.getRun(p.id)?.delegation).not.toHaveProperty('finishRequestedAt');
          closing = false;
          expect(manager.continueRun(p.id, { text: 'go on' })).toEqual({ ok: true });
          if (runner === 'claude') {
            await refusalStep(runner, p.id, 'U22c: Continue native refusal receipt', () => prompted(runner, refusal).length > 0);
            await refusalStep(runner, p.id, 'U22c: Continue delivery checkpoint', () => refusals()[0]?.deliveredAt !== undefined);
          } else await until(() => refusals()[0]?.deliveredAt !== undefined && prompted(runner, refusal).length > 0);
          expect(prompted(runner, refusal)).toHaveLength(1);
          expect(refusals()).toHaveLength(1);
          await refusalStep(runner, p.id, 'U22c: Continue final park', () => store.getRun(p.id)?.status === 'waiting');
        } finally {
          store.off('event', closeAtTurnEnd);
        }
      });
    }

    it(`${runner} U22f a refusal whose reopened session closes once counts the failure, and its delivery clears it`, async () => {
      retryAtOnce();
      process.env.CEZ_MOCK_COMPLETION_REPLY = refusedDoneReply();
      const { p, w } = await parentWithWorker(runner);
      const refusal = `Workers are still live: ${w.id}.`;
      const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
      let closes = 1;
      const closeOnce = ({ runId, event }: { runId: string; event: { type: string } }) => {
        if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
        closes--;
        sessionOf(p.id).end();
      };
      // With no backoff the retry delivers at once and clears the count, so a poll can miss it: the
      // store's own writes record that it was counted.
      let counted = false;
      const countOnce = (run: RunRecord) => { if (run.id === p.id && run.waitDeliveryFailures === 1) counted = true; };
      store.on('event', closeOnce);
      store.on('run', countOnce);
      try {
        sessionOf(p.id).end();
        await until(() => counted);
        await until(() => prompted(runner, refusal).length > 0 && parkedOnWorkersTimer(p.id) && refusals()[0]?.deliveredAt !== undefined);
        expect(refusals()).toEqual([expect.objectContaining({ deliveredAt: expect.any(String) })]);
        expect(prompted(runner, MESSAGE_WAKE_OPENING)).toHaveLength(2);
        expect(store.getRun(p.id)?.waitDeliveryFailures).toBeUndefined();
      } finally {
        store.off('event', closeOnce);
        store.off('run', countOnce);
      }
    });

    // hearsay-tools/cezarion#1301: a refusal is known by its persisted input, so both bounds that
    // hold it, the nudge's reply bound and the delivery retry of sessions that close before it, last
    // past a run that failed at the delivery bound (U22k: Continue delivers it) and a restart (U22r).
    // The silent harness is not constructible on Cursor print (U22s's exemption).
    for (const variant of ['silent', 'closing'] as const) {
      const how = variant === 'silent' ? 'as the nudge: a harness that never answers parks at the reply bound'
        : 'with the delivery retry: a session that closes before it counts a failure, and one copy is delivered';
      it(`${runner} U22k after a refusal failed at the delivery bound, Continue delivers it ${how}`, async () => {
        if (variant === 'silent' && exemptionFor('U22s', runner)) {
          expect(exemptionFor('U22s', runner)?.kind).toBe('capability-absent');
          return;
        }
        retryAtOnce();
        const silence = variant === 'silent' ? silenceRefusals() : undefined;
        if (variant === 'closing') process.env.CEZ_MOCK_COMPLETION_REPLY = refusedDoneReply();
        const { p, w } = await parentWithWorker(runner, runner === 'claude' ? 'U22k' : undefined);
        const refusal = `Workers are still live: ${w.id}.`;
        const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
        let closes = MAX_WAKE_DELIVERY_ATTEMPTS;
        const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
          if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
          closes--;
          sessionOf(p.id).end();
        };
        store.on('event', closeAtTurnEnd);
        onTestFinished(() => { store.off('event', closeAtTurnEnd); });
        sessionOf(p.id).end();
        await refusalDeliveryBound(runner, p.id, 'U22k', () => MAX_WAKE_DELIVERY_ATTEMPTS - closes);
        expect(prompted(runner, MESSAGE_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS);
        expect(refusals()).toHaveLength(1);
        expect(refusals()[0]!.deliveredAt).toBeUndefined();
        if (variant === 'closing') closes = 1;
        expect(manager.continueRun(p.id, { text: 'go on' })).toEqual({ ok: true });
        if (variant === 'closing') {
          await refusalStep(runner, p.id, 'U22k: Continue session close', () => closes === 0);
          await refusalStep(runner, p.id, 'U22k: Continue retry native admission', () => prompted(runner, MESSAGE_WAKE_OPENING).length > MAX_WAKE_DELIVERY_ATTEMPTS);
        }
        await refusalStep(runner, p.id, 'U22k: Continue native refusal receipt', () => prompted(runner, refusal).length > 0);
        // The prompt record and the reply bound can both precede the native ACK that writes
        // `deliveredAt` (OpenCode's HTTP reply): wait for that checkpoint before the bound fires.
        await refusalStep(runner, p.id, 'U22k: Continue delivery checkpoint', () => refusals()[0]?.deliveredAt !== undefined);
        if (variant === 'silent') {
          await silence!(runner, refusal);
          await refusalStep(runner, p.id, 'U22k: Continue no-reply final park', () => noReplyNotes(p.id).length === 1 && gated(p.id));
          expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
          expect(semaphore.busy()).toBe(0);
        } else {
          // The reply's done is refused by the tool, and its turn end parks on the live workers' timer.
          await refusalStep(runner, p.id, 'U22k: Continue final park', () => prompted(runner, refusal).length > 0 && parkedOnWorkersTimer(p.id));
          expect(closes).toBe(0);
          // The Continue's session closed first: one more scheduler continuation delivered it.
          expect(prompted(runner, MESSAGE_WAKE_OPENING)).toHaveLength(MAX_WAKE_DELIVERY_ATTEMPTS + 1);
          expect(store.getRun(p.id)?.waitDeliveryFailures).toBeUndefined();
        }
        expect(prompted(runner, refusal)).toHaveLength(1);
        expect(refusals()).toEqual([expect.objectContaining({ deliveredAt: expect.any(String) })]);
        expect(nudgeNotes(p.id)).toHaveLength(1);
      });

      it(`${runner} U22r after a restart, a refusal queued for a closed session is delivered ${how}`, async () => {
        const exercise = async (releaseAck: () => void) => {
          if (variant === 'silent' && exemptionFor('U22s', runner)) {
            expect(exemptionFor('U22s', runner)?.kind).toBe('capability-absent');
            return;
          }
          let silence = variant === 'silent' ? silenceRefusals() : undefined;
          if (variant === 'closing') process.env.CEZ_MOCK_COMPLETION_REPLY = refusedDoneReply();
          const { p, w } = await parentWithWorker(runner);
          const refusal = `Workers are still live: ${w.id}.`;
          const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
          // The disk as the refusal was queued and charged, before any session took it: a crash there.
          let disk: ReturnType<typeof readPersistedRuns> | undefined, events: Map<string, string> | undefined;
          const capture = ({ runId, event }: { runId: string; event: { type: string; message?: unknown } }) => {
            if (runId !== p.id || disk || event.type !== 'note' || !String(event.message).startsWith(COMPLETION_NUDGE_NOTE)) return;
            events = eventCheckpoint();
            disk = readPersistedRuns(join(root, '.ai/cezar'));
          };
          store.on('event', capture);
          sessionOf(p.id).end();
          await until(() => disk !== undefined);
          store.off('event', capture);
          let closes = variant === 'closing' ? 1 : 0;
          const closeOnce = ({ runId, event }: { runId: string; event: { type: string } }) => {
            if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
            closes--;
            sessionOf(p.id).end();
          };
          await restart(false, disk, events);
          // The old manager may have reached a mock before it stopped: count from here.
          const before = prompted(runner, refusal).length;
          // Recovery reopens the run through the scheduler; its first turn end is a mock round trip away.
          store.on('event', closeOnce);
          onTestFinished(() => { store.off('event', closeOnce); });
          if (variant === 'silent') silence = silenceRefusals();
          else retryAtOnce();
          expect(refusals()).toEqual([expect.objectContaining({ source: 'lifecycle' })]);
          if (variant === 'silent') {
            await silence!(runner, refusal, { after: before });
            await until(() => noReplyNotes(p.id).length === 1 && gated(p.id));
            if (runner === 'opencode') expect(refusals()[0]!.deliveredAt).toBeUndefined();
            expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
            expect(semaphore.busy()).toBe(0);
            releaseAck();
            if (runner === 'opencode') {
              await until(() => refusals().some(input => !!input.deliveredAt));
              await silence!(runner, refusal, { after: before });
            }
            // The reply bound can beat the native ACK. Its human gate alone does not prove
            // delivery committed; the late ACK resumes wake bookkeeping and re-arms that bound.
            checkpoint('u22r-refusal-delivered-and-reparked');
            await until(() => refusals().some(input => !!input.deliveredAt) && gated(p.id));
            expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
            expect(semaphore.busy()).toBe(0);
          } else {
            await until(() => prompted(runner, refusal).length > before && parkedOnWorkersTimer(p.id) && refusals().some(input => !!input.deliveredAt));
            expect(closes).toBe(0);
            expect(store.getRun(p.id)?.waitDeliveryFailures).toBeUndefined();
          }
          expect(prompted(runner, refusal).length - before).toBe(1);
          expect(refusals()).toEqual([expect.objectContaining({ deliveredAt: expect.any(String) })]);
          expect(nudgeNotes(p.id)).toHaveLength(1);
        };
        if (runner === 'opencode' && variant === 'silent') {
          await withHeldAck('opencode', exercise, 'mock:ack-only');
        } else await exercise(() => {});
      });
    }

    // hearsay-tools/cezarion#1301: Stop discards a refusal a closed session still owes, as it
    // discards the run's waits, so a Continue after it never delivers a stale refusal.
    it(`${runner} U22x Stop retires a refusal a closed session still owes, and Continue does not deliver it`, async () => {
      retryAtOnce();
      const { p, w } = await parentWithWorker(runner, runner === 'claude' ? 'U22x' : undefined);
      const refusal = `Workers are still live: ${w.id}.`;
      const refusals = () => store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
      let closes = MAX_WAKE_DELIVERY_ATTEMPTS;
      const closeAtTurnEnd = ({ runId, event }: { runId: string; event: { type: string } }) => {
        if (runId !== p.id || event.type !== 'turn-end' || !closes || !refusals().some(input => !input.deliveredAt)) return;
        closes--;
        sessionOf(p.id).end();
      };
      store.on('event', closeAtTurnEnd);
      onTestFinished(() => { store.off('event', closeAtTurnEnd); });
      sessionOf(p.id).end();
      await refusalDeliveryBound(runner, p.id, 'U22x', () => MAX_WAKE_DELIVERY_ATTEMPTS - closes);
      expect(refusals()).toEqual([expect.objectContaining({ purpose: 'completion-refusal' })]);
      expect(refusals()[0]!.deliveredAt).toBeUndefined();
      expect(manager.cancel(p.id)).toBe(true);
      expect(refusals()).toEqual([]);
      expect(store.getRun(p.id)?.status).toBe('failed');
      expect(store.readEvents(p.id).filter(event => event.type === 'note' && event.message === REFUSAL_DISCARDED_NOTE)).toHaveLength(1);
      expect(manager.continueRun(p.id, { text: 'go on' })).toEqual({ ok: true });
      if (runner === 'claude') await refusalStep(runner, p.id, 'U22x: Continue native receipt', () => prompted(runner, 'go on').length > 0);
      await refusalStep(runner, p.id, 'U22x: Continue final park', () => prompted(runner, 'go on').length > 0 && store.getRun(p.id)?.status === 'waiting');
      expect(prompted(runner, refusal)).toHaveLength(0);
      expect(nudgeNotes(p.id)).toHaveLength(1);
    });

    // hearsay-tools/cezarion#1301: a worker keeps its one no-wait nudge; the next turn end with no
    // wait or done asks its parent, and the parent's reply resumes it, charged to its budget.
    it(`${runner} U24 a worker's second no-wait turn end asks its parent, and the reply resumes it`, async () => {
      nativeWire(runner);
      const { p, service, callerFor } = await delegatingParent({ task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner, permissions: ['spawn', 'wait', 'steer'] });
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id, HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
      manager.enqueueOwnedRun(w.id);
      const routed = () => store.readEvents(w.id).find(event => event.type === 'worker-question-routed');
      await until(() => routed() !== undefined && store.getRun(w.id)?.status === 'waiting');
      const question = WORKER_FALLBACK_QUESTION(w.id);
      expect(store.readEvents(w.id).filter(event => event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE))).toHaveLength(1);
      expect(asks(w.id)).toEqual([expect.objectContaining({ questions: [{ header: WORKER_FALLBACK_HEADER, question }] })]);
      expect(humanOpen(w.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'], askSeq: asks(w.id)[0]!.seq })]);
      expect(routed()).toMatchObject({ askSeq: asks(w.id)[0]!.seq, parentRunId: p.id });
      // The request is in the parent's conversation, and it wakes the parent.
      const requestId = String(routed()!.messageId);
      const conversation = store.getRun(p.id)?.delegation?.role === 'root' ? (store.getRun(p.id)!.delegation as { conversation?: { messages: Array<{ id: string; kind: string; senderRunId: string }> } }).conversation : undefined;
      expect(conversation?.messages.find(message => message.id === requestId)).toMatchObject({ kind: 'request', senderRunId: w.id });
      await until(() => delivered(p.id, requestId) && prompted(runner, question).length > 0);
      const wakes = store.getRun(w.id)?.automaticWakes ?? 0;
      const parentCaller = callerFor(p.id);
      const fallback = humanOpen(w.id)[0]!.id;
      const commits = recordCommits(join(root, '.ai/cezar'));
      const replyId = randomUUID();
      await service.send(parentCaller, { id: replyId, recipientRunId: w.id, kind: 'reply', requestId, text: `${WORKER_FALLBACK_HEADER}: cez-dev`, timeoutSeconds: 600 });
      await until(() => store.readEvents(w.id).some(event => event.type === 'human-input-delivered' && event.source === 'parent' && event.askSeq === asks(w.id)[0]!.seq));
      expect(store.readEvents(w.id).filter(event => event.type === 'note' && String(event.message).startsWith(WORKER_FALLBACK_REPLY_NOTE)))
        .toEqual([expect.objectContaining({ message: `${WORKER_FALLBACK_REPLY_NOTE} (${wakes + 1}/${MAX_AUTO_CONTINUES})` })]);
      await until(() => prompted(runner, `${WORKER_FALLBACK_HEADER}: cez-dev`).length > 0);
      // hearsay-tools/cezarion#1805: whichever way the reply reaches the worker (its live session, or a
      // continuation that opens with it), a reopened store never reads the charge or the answered
      // question without the reply delivered or owed, nor the reply read with the question still open.
      const reply = (row: RunRecord) => row.agentInputs?.find(input => input.id === replyId);
      const owed = (row: RunRecord) => !!reply(row)?.deliveredAt || row.continuationMessage?.agentInputId === replyId;
      commits.expectEveryCommit(w.id, row => row.automaticWakes !== wakes + 1 || owed(row), 'the reply\'s charge and its delivery');
      commits.expectEveryCommit(w.id, row => !row.lastWaits?.some(wait => wait.id === fallback && wait.phase === 'delivered') || owed(row), 'the answered question and its reply');
      commits.expectEveryCommit(w.id, row => !reply(row)?.consumedAt || !row.waits?.some(wait => wait.id === fallback), 'the read reply and its question');
    });

    // hearsay-tools/cezarion#1805: the reply opens a continuation, and the opening turn's
    // acknowledgement reads the reply and answers the worker's question in one commit, so a reopened
    // store never reads the reply consumed with the question still open.
    it(`${runner} U24r a parent's reply to a worker question whose session closed opens a continuation that answers it in one commit`, async () => {
      nativeWire(runner);
      const { p, service, callerFor } = await delegatingParent({ task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner, permissions: ['spawn', 'wait', 'steer'] });
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id, toolCall('cezar_ask', { context: ASK_CONTEXT, questions }), runner);
      manager.enqueueOwnedRun(w.id);
      const routed = () => store.readEvents(w.id).find(event => event.type === 'worker-question-routed');
      await until(() => routed() !== undefined && humanOpen(w.id)[0]?.askSeq !== undefined && store.getRun(w.id)?.status === 'waiting');
      const [question] = humanOpen(w.id);
      sessionOf(w.id).end();
      await until(() => !manager.isActive(w.id) && store.getRun(w.id)?.status === 'waiting');
      expect(humanOpen(w.id).map(wait => wait.id)).toEqual([question!.id]);
      const commits = recordCommits(join(root, '.ai/cezar'));
      const replyId = randomUUID();
      await service.send(callerFor(p.id), { id: replyId, recipientRunId: w.id, kind: 'reply', requestId: String(routed()!.messageId), text: 'Choice: Parser', timeoutSeconds: 600 });
      await until(() => store.readEvents(w.id).some(event => event.type === 'human-input-delivered' && event.source === 'parent'));
      await until(() => !!store.getRun(w.id)?.agentInputs?.find(input => input.id === replyId)?.consumedAt && humanOpen(w.id).every(wait => wait.id !== question!.id));
      expect(settled(w.id, question!.id)?.phase).toBe('delivered');
      const reply = (row: RunRecord) => row.agentInputs?.find(input => input.id === replyId);
      commits.expectEveryCommit(w.id, row => !reply(row)?.consumedAt || !row.waits?.some(wait => wait.id === question!.id), 'the read reply and its question');
      commits.expectEveryCommit(w.id, row => !row.lastWaits?.some(wait => wait.id === question!.id && wait.phase === 'delivered') || !!reply(row)?.deliveredAt ||
        row.continuationMessage?.agentInputId === replyId, 'the answered question and its reply');
    });

    // hearsay-tools/cezarion#1301: an automatic message to a worker supersedes Squawk's pending fallback
    // question, as the plain park it replaced let it through: it reaches the wire, the routed request
    // gets an outcome, and the parent's done is no longer blocked by the question.
    it(`${runner} U25 an automatic message supersedes a worker's fallback question`, async () => {
      nativeWire(runner);
      const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const delegation = store.getRun(p.id)!.delegation!;
      if (delegation.role !== 'root') throw Error('root fixture');
      store.commitDelegation([{ id: p.id, delegation: { ...delegation, permissions: [...delegation.permissions, 'steer'] } }]);
      const w = await worker(p.id, HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
      manager.enqueueOwnedRun(w.id);
      const routed = () => store.readEvents(w.id).find(event => event.type === 'worker-question-routed');
      await until(() => routed() !== undefined && store.getRun(w.id)?.status === 'waiting');
      const askSeq = asks(w.id)[0]!.seq;
      const requestId = String(routed()!.messageId);
      const conversation = () => {
        const delegation = store.getRun(p.id)!.delegation!;
        if (delegation.role !== 'root') throw Error('root fixture');
        return delegation.conversation;
      };
      expect(conversation()?.messages.find(message => message.id === requestId)).toMatchObject({ kind: 'request', senderRunId: w.id });
      expect(conversation()?.outcomes.filter(outcome => outcome.requestId === requestId)).toEqual([]);
      const text = 'automatic steer U25';
      const input = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: p.id, text, createdAt: new Date().toISOString() };
      expect(manager.steerWorker(w.id, input)).toBe('queued');
      await until(() => prompted(runner, text).length > 0);
      expect(store.readEvents(w.id).filter(event => event.type === 'human-ask-closed'))
        .toEqual([expect.objectContaining({ askSeq, reason: 'superseded' })]);
      expect(conversation()?.outcomes.filter(outcome => outcome.requestId === requestId)).toHaveLength(1);
      expect(store.getRun(w.id)?.agentInputs?.find(entry => entry.id === input.id)).toMatchObject(input);
      // The steer's own turn may end without a wait and route a fresh fallback question before
      // these reads: only the superseded question is checked (hearsay-tools/cezarion#1301).
      expect(humanOpen(w.id).filter(wait => wait.askSeq === askSeq)).toEqual([]);
    });
  }
}
