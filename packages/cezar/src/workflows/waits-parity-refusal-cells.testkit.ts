import { waitPartDescribers, workerParent, turnEnds, blockedDone, blockingWorker, uncollectedRefusal, liveRefusal, prompted, workerWaits, silenceRefusals, idleClock, noReplyNotes, gated, nudgeNotes, humanOpen, parentOn, sessionOf, settled } from './waits-parity-fixture.testkit.ts';
import { COMPLETION_NUDGE_NOTE, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES } from './run.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it as registerTest, vi, expect } from 'vitest';
import { RUN_STATUS, WAIT_SOURCE, WAIT_VIA, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { Wait } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { exemptionFor, HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { store, until, root, waitOf, manager, collect, restart, timeline } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { handoffPath } from '../handoff.ts';
import { gatedProviderFailure, toolCall, thenSay } from './waits-parity.testkit.ts';

// The refusal part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('refusal', refusalCells);

/** Seed an accepted peer obligation without an unread input: the native turn tests the gate. */
function seedCompletionRequest(senderRunId: string, recipientRunId: string) {
  const request = { id: randomUUID(), senderRunId, recipientRunId, kind: 'request' as const, relationship: 'peer' as const,
    text: 'Please check the result', createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 600_000).toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const };
  store.commitConversation(senderRunId, { messages: [request], outcomes: [] });
  return request;
}

export function refusalCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    for (const settledWorker of [false, true]) {
      it(`${runner} ${settledWorker ? 'U20u a done blocked by a settled, uncollected worker gets the uncollected refusal nudge without the will-wait sentence' : 'U20 a done blocked by live workers at the turn end gets one refusal nudge with the will-wait sentence and opens no wait'}`, async () => {
        const p = await workerParent(runner);
        // The human message below restarts the automatic-wake budget: the nudge spends its first unit.
        const wakes = 0;
        // The run as the nudge note is written: the note follows the submission and the charge.
        let atNudge: { status?: string; waits?: Wait[]; automaticWakes?: number | undefined; delegation?: unknown } | undefined;
        const publicationFailures: unknown[] = [];
        const append = store.appendEvent.bind(store);
        vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
          if (id === p.id && event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE) && !atNudge) {
            const run = store.getRun(p.id)!;
            try {
              expect(run).toMatchObject({ status: RUN_STATUS.running, automaticWakes: wakes + 1 });
              expect(run.waits ?? []).toEqual([]);
            } catch (error) { publicationFailures.push(error); }
            atNudge = structuredClone({ status: run.status, waits: run.waits ?? [], automaticWakes: run.automaticWakes, delegation: run.delegation });
          }
          return append(id, event);
        });
        const turns = turnEnds(p.id);
        const w = await blockedDone(p.id, () => blockingWorker(p.id, { uncollected: settledWorker }));
        const refusal = settledWorker ? uncollectedRefusal(w) : liveRefusal(w);
        await until(() => turnEnds(p.id) > turns + 1 && store.getRun(p.id)?.status === RUN_STATUS.waiting);
        const [nudge, ...more] = prompted(runner, refusal);
        expect(more).toEqual([]);
        if (settledWorker) expect(nudge).not.toContain(COMPLETION_WILL_WAIT);
        else expect(nudge).toContain(COMPLETION_WILL_WAIT);
        expect(atNudge).toMatchObject({ status: RUN_STATUS.running, waits: [], automaticWakes: wakes + 1 });
        expect(publicationFailures).toEqual([]);
        expect(atNudge!.delegation).not.toHaveProperty('wait');
        expect(atNudge!.delegation).not.toHaveProperty('completion');
        expect(store.readEvents(p.id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE)))
          .toEqual([expect.objectContaining({ message: `${COMPLETION_NUDGE_NOTE} (${wakes + 1}/${MAX_AUTO_CONTINUES}): ${settledWorker ? 'workers_uncollected' : 'workers_outstanding'}` })]);
        // The turn end writes nothing to the handoff file (hearsay-tools/cezarion#1809).
        expect(readFileSync(handoffPath(join(root, '.ai/cezar'), p.id), 'utf8')).not.toMatch(/turn complete|status=/);
        // The nudge turn's own end follows the ordinary rule; the run still finishes nothing.
        await until(() => store.getRun(p.id)?.status === 'waiting');
        expect(waitOf(store.getRun(p.id))).toBeUndefined();
        expect(workerWaits(p.id)).toEqual([]);
      });
    }

    // hearsay-tools/cezarion#1301: a human message starts a fresh cycle (U20h). A refusal nudge the
    // harness acknowledges on its native wire and never answers parks on Cezar's human wait; the next
    // message then ends on a blocked done again, and that done gets a fresh nudge rather than the
    // second step. Each turn-end handler: the opening session's and a continuation's.
    for (const path of ['opening session', 'continuation'] as const) {
      it(`${runner} U20h a human message after an unanswered refusal nudge starts a fresh cycle (${path})`, async () => {
        if (exemptionFor('U20h', runner)) {
          expect(exemptionFor('U20h', runner)?.kind).toBe('capability-absent');
          return;
        }
        const silence = silenceRefusals();
        const p = await workerParent(runner);
        if (path === 'continuation') {
          // An idle close leaves the run waiting; the human's Continue reopens it as a continuation.
          idleClock.fire(idleClock.captured - 1);
          await until(() => !manager.isActive(p.id) && store.getRun(p.id)?.status === 'waiting');
        }
        const continued = (prompt: string) => expect(manager.continueRun(p.id, { text: prompt }).ok).toBe(true);
        const w = await blockedDone(p.id, () => blockingWorker(p.id), path === 'continuation' ? continued : undefined);
        await silence(runner, liveRefusal(w));
        await until(() => noReplyNotes(p.id).length === 1 && gated(p.id));
        if (path === 'continuation') expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
        expect(nudgeNotes(p.id)).toHaveLength(1);
        expect(prompted(runner, liveRefusal(w))).toHaveLength(1);
        expect(workerWaits(p.id)).toEqual([]);
        expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
        // The next turn ends on a blocked done: a fresh cycle, so a second nudge and no wait. The
        // tool accepts that done only once the first worker settled and was collected.
        manager.requestWorkerStop(w.id);
        expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
        await collect(w.id);
        const turns = turnEnds(p.id);
        const next = await blockedDone(p.id, () => blockingWorker(p.id));
        await until(() => turnEnds(p.id) > turns && (nudgeNotes(p.id).length === 2 || workerWaits(p.id).length > 0 || humanOpen(p.id).some(wait => wait.via === 'completion')));
        expect(workerWaits(p.id)).toEqual([]);
        expect(nudgeNotes(p.id)).toHaveLength(2);
        await until(() => prompted(runner, liveRefusal(next)).length > 0);
        expect(prompted(runner, liveRefusal(next))).toHaveLength(1);
        await silence(runner, liveRefusal(next));
        await until(() => noReplyNotes(p.id).length === 2 && gated(p.id));
        expect(workerWaits(p.id)).toEqual([]);
      });
    }

    it(`${runner} R18 Finish followed by a provider error retires its intent before restart`, async () => {
      const peer = await parentOn(runner);
      const wire = gatedProviderFailure(root, runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['provider-error-controlled']! });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['wait'], receipts: [] } }]);
      await until(wire.held);
      const request = seedCompletionRequest(run.id, peer.id);
      // Hold graceful shutdown until the queued native provider error wins.
      const close = vi.spyOn(sessionOf(run.id), 'end').mockImplementationOnce(() => {});
      expect(manager.finish(run.id)).toBe(true);
      close.mockRestore();
      wire.release();
      await until(() => store.getRun(run.id)?.status === RUN_STATUS.failed && !manager.isActive(run.id));
      expect(store.getRun(run.id)?.delegation).not.toHaveProperty('finishRequestedAt');
      const delegation = store.getRun(run.id)?.delegation;
      expect(delegation?.role === 'root' && delegation.conversation?.outcomes).toEqual([
        expect.objectContaining({ requestId: request.id, status: 'sender-closed' }),
      ]);
      await restart();
      expect(store.getRun(run.id)?.status).toBe(RUN_STATUS.failed);
      expect(store.getRun(run.id)?.delegation).not.toHaveProperty('finishRequestedAt');
      expect(manager.continueRun(run.id, { text: 'Try again.' })).toEqual({ ok: true });
      await until(() => store.getRun(run.id)?.status === RUN_STATUS.waiting);
    });

    it(`${runner} R13 repeated cezar_done tool refusals park on sent requests`, async () => {
      const p = await parentOn(runner); const peer = await parentOn(runner);
      const request = seedCompletionRequest(p.id, peer.id);
      const answers = vi.spyOn(manager, 'acceptDone');
      expect(manager.sendMessage(p.id, [{ type: 'text', text: `${toolCall('cezar_done', {})} ${toolCall('cezar_done', {})}` }])).toBe(true);
      await until(() => workerWaits(p.id)[0]?.phase === 'open' && store.getRun(p.id)?.status === 'waiting');
      expect(workerWaits(p.id)[0]).toMatchObject({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, requestIds: [request.id] });
      expect(answers.mock.results.map(result => result.value)).toEqual([
        expect.objectContaining({ ok: false, code: 'requests_outstanding', message: expect.stringContaining(request.id) }),
        expect.objectContaining({ ok: false, code: 'requests_outstanding' }),
      ]);
    });

    it(`${runner} R17 a second cezar_done tool call passes after the incoming refusal`, async () => {
      const p = await parentOn(runner); const peer = await parentOn(runner);
      const request = seedCompletionRequest(peer.id, p.id);
      const answers = vi.spyOn(manager, 'acceptDone');
      expect(manager.sendMessage(p.id, [{ type: 'text', text: `${toolCall('cezar_done', {})} ${toolCall('cezar_done', {})}` }])).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'done' && !manager.isActive(p.id));
      expect(answers.mock.results.map(result => result.value)).toEqual([
        expect.objectContaining({ ok: false, code: 'requests_unanswered', message: expect.stringContaining(request.id) }),
        expect.objectContaining({ ok: true, finishes: 'at_turn_end' }),
      ]);
    });

    it(`${runner} R13 open sent requests refuse done, park without a wait deadline, and a reply wakes the root`, async () => {
      // The reply's cezar_done is refused by the tool again; a second refusal while requests are
      // outstanding is a done its turn end takes to the second step (recordRequestRefusal).
      process.env.CEZ_MOCK_COMPLETION_REPLY = `${toolCall('cezar_done', {})} ${thenSay('Still done.')}`;
      const p = await parentOn(runner);
      const peer = await parentOn(runner);
      const request = await blockedDone(p.id, () => seedCompletionRequest(p.id, peer.id));
      await until(() => prompted(runner, 'Requests are still open:').length > 0, () => timeline(p.id));
      await until(() => store.getRun(p.id)?.status === 'waiting' && workerWaits(p.id)[0]?.phase === 'open', () => timeline(p.id));
      expect(prompted(runner, 'Requests are still open:')).toHaveLength(1);
      expect(nudgeNotes(p.id)).toHaveLength(1);
      const entry = workerWaits(p.id)[0]!;
      expect(prompted(runner, request.id)).not.toHaveLength(0);
      expect(prompted(runner, 'hsq message wait --request')).not.toHaveLength(0);
      expect(prompted(runner, 'hsq message cancel-request')).not.toHaveLength(0);
      expect(entry).toMatchObject({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, requestIds: [request.id], phase: WAIT_PHASE.open });
      expect(entry).not.toHaveProperty('deadline');
      expect(entry).not.toHaveProperty('timeoutSeconds');
      const current = store.getRun(p.id)!.delegation;
      if (current?.role !== 'root') throw Error('missing ledger');
      store.commitConversation(p.id, { ...current.conversation!, outcomes: [{ requestId: request.id, status: 'replied', observedAt: new Date().toISOString() }] });
      manager.reconcileWorkerWaits(p.id);
      await until(() => settled(p.id, entry.id)?.phase === 'delivered');
      await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(manager.sendMessage(p.id, [{ type: 'text', text: toolCall('cezar_done', {}) }])).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'done');
    });

    it(`${runner} R17 incoming requests refuse once then complete and settle the requester obligation`, async () => {
      // The reply's cezar_done is accepted: an incoming request refuses a done once per cycle.
      process.env.CEZ_MOCK_COMPLETION_REPLY = `${toolCall('cezar_done', {})} ${thenSay('Finish without replying.')}`;
      const p = await parentOn(runner);
      const peer = await parentOn(runner);
      const request = await blockedDone(p.id, () => seedCompletionRequest(peer.id, p.id));
      await until(() => prompted(runner, 'Requests are unanswered:').length === 1);
      expect(prompted(runner, `${request.id} from ${peer.id}`)).toHaveLength(1);
      await until(() => store.getRun(p.id)?.status === 'done' && !manager.isActive(p.id));
      await until(() => {
        const root = store.getRun(peer.id)?.delegation;
        return root?.role === 'root' && !!root.conversation?.outcomes.some(outcome => outcome.requestId === request.id && outcome.status === 'completed-without-reply');
      });
      expect(nudgeNotes(p.id)).toHaveLength(1);
    });

    // hearsay-tools/cezarion#1301: the turn that answers the refusal nudge ends on done again.
  }
}
