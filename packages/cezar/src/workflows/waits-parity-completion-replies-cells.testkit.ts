import { waitPartDescribers, repliesDoneAgain, workerParent, ignoreRefusal, gated, uncollectedRefusal, humanOpen, workerWaits, asks, nativeWire, blockedDone, blockingWorker, prompted, liveRefusal, replyBlockedAgain, parentWithWorker, sessionOf, silenceRefusals, noReplyNotes, nudgeNotes } from './waits-parity-fixture.testkit.ts';
import { MAX_AUTO_CONTINUES, COMPLETION_NUDGE_NOTE, COMPLETION_WILL_WAIT } from './run.ts';
import { join } from 'node:path';
import { it as registerTest, expect, vi } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { WAIT_KIND, WAIT_SOURCE, WAIT_VIA, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { Wait } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS, exemptionFor } from '../core/harness-parity-core.testkit.ts';
import { store, semaphore, manager, until, timeline, root } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';

// The completion-replies part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('completion-replies', completionRepliesCells);

export function completionRepliesCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U21h an ignored refusal with only uncollected results parks on Squawk's human wait`, async () => {
      const reply = repliesDoneAgain();
      const p = await workerParent(runner);
      const { second: w } = await ignoreRefusal(runner, p.id, reply, () => gated(p.id), { uncollected: true });
      const refusal = `${uncollectedRefusal(w)}, then call cezar_done again.`;
      expect(humanOpen(p.id)).toEqual([expect.objectContaining({ kind: WAIT_KIND.human, source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, phase: WAIT_PHASE.open })]);
      expect(workerWaits(p.id)).toEqual([]);
      const shown = store.readEvents(p.id).find(event => event.seq === humanOpen(p.id)[0]!.askSeq);
      expect(shown).toMatchObject({ type: 'note', message: refusal });
      expect(asks(p.id)).toEqual([]);
      expect(deriveAttention(store.getRun(p.id)!).label).toBe('needs you');
      expect(semaphore.busy()).toBe(0);
    });

    it(`${runner} U21a an autonomous parent's ignored refusal is nudged again until the budget`, async () => {
      const reply = repliesDoneAgain();
      nativeWire(runner);
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios['autonomous-cap']!, autonomous: true });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      // The opening turn spends what is left and parks on the budget; the workers come after it.
      store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES });
      await until(() => gated(run.id));
      const atNudges: Wait[][] = [];
      const append = store.appendEvent.bind(store);
      vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
        if (id === run.id && event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE)) atNudges.push(store.getRun(run.id)?.waits ?? []);
        return append(id, event);
      });
      // The human message restarted the budget; two units are left for the nudges.
      const w = await blockedDone(run.id, async () => {
        store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES - 2 });
        return blockingWorker(run.id);
      });
      await until(() => prompted(runner, liveRefusal(w)).length > 0, () => timeline(run.id));
      // The first reply's done is blocked again: the second nudge. The second reply's done, which the
      // tool refuses while that worker is live, ends a turn at the spent budget.
      const next = await replyBlockedAgain(run.id, reply, w, () => blockingWorker(run.id));
      await until(() => humanOpen(run.id)[0]?.via === 'budget' && gated(run.id));
      expect(prompted(runner, liveRefusal(w))).toHaveLength(1);
      expect(prompted(runner, liveRefusal(next))).toHaveLength(1);
      expect(atNudges).toEqual([[], []]);
      expect(humanOpen(run.id)).toEqual([expect.objectContaining({ kind: WAIT_KIND.human, source: WAIT_SOURCE.cezar, via: WAIT_VIA.budget, phase: WAIT_PHASE.open })]);
      expect(workerWaits(run.id)).toEqual([]);
      expect(store.getRun(run.id)?.automaticWakes).toBe(MAX_AUTO_CONTINUES);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
    });

    // hearsay-tools/cezarion#1301: a blocked done found after the session closed is queued as a
    // lifecycle wake; the scheduler continuation reopens the session and delivers it as the nudge.
    it(`${runner} U22 a done blocked after the session closed reopens it and delivers the refusal`, async () => {
      // The reply turn ends on done again: the refusal's turn is the nudge's, so it takes the second step.
      const reply = repliesDoneAgain();
      const { p, w } = await parentWithWorker(runner);
      const wakes = store.getRun(p.id)?.automaticWakes ?? 0;
      const commits = recordCommits(join(root, '.ai/cezar'));
      sessionOf(p.id).end();
      const refusal = liveRefusal(w);
      await until(() => prompted(runner, refusal).length > 0, () => timeline(p.id));
      const next = await replyBlockedAgain(p.id, reply, w, () => blockingWorker(p.id));
      await until(() => workerWaits(p.id)[0]?.phase === 'open' && store.getRun(p.id)?.status === 'waiting', () => timeline(p.id));
      // hearsay-tools/cezarion#1805: the refusal is queued with its charge, so no reopened store
      // delivers it uncharged.
      commits.expectEveryCommit(p.id, row => !row.agentInputs?.some(input => input.text.includes(refusal)) || row.automaticWakes === wakes + 1, 'a queued refusal and its charge');
      expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
      expect(prompted(runner, refusal)).toEqual([expect.stringContaining(COMPLETION_WILL_WAIT)]);
      const inputs = store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)) ?? [];
      expect(inputs).toEqual([expect.objectContaining({ source: 'lifecycle', deliveredAt: expect.any(String) })]);
      expect(store.getRun(p.id)?.automaticWakes).toBe(wakes + 1);
      expect(store.readEvents(p.id).filter(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE)))
        .toEqual([expect.objectContaining({ message: `${COMPLETION_NUDGE_NOTE} (${wakes + 1}/${MAX_AUTO_CONTINUES}): workers_outstanding` })]);
      expect(workerWaits(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, workerIds: [next.id] })]);
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
      expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
    });

    // hearsay-tools/cezarion#1301: a reopened session that acknowledges the refusal and never answers
    // it is bounded as the live nudge is: at the reply bound the run parks on Squawk's human wait and
    // gives up its slot, whether or not its harness reports the input read.
    it(`${runner} U22s a refusal reopened into a session that acknowledges it and never answers parks on Squawk's human wait at the nudge's reply bound`, async () => {
      if (exemptionFor('U22s', runner)) {
        expect(exemptionFor('U22s', runner)?.kind).toBe('capability-absent');
        return;
      }
      const silence = silenceRefusals();
      const { p, w } = await parentWithWorker(runner);
      const refusal = `Workers are still live: ${w.id}.`;
      sessionOf(p.id).end();
      await silence(runner, refusal);
      await until(() => noReplyNotes(p.id).length === 1 && gated(p.id));
      expect(prompted(runner, refusal)).toHaveLength(1);
      expect(store.getRun(p.id)?.agentInputs?.filter(input => input.text.includes(refusal)))
        .toEqual([expect.objectContaining({ source: 'lifecycle', deliveredAt: expect.any(String) })]);
      expect(humanOpen(p.id)).toEqual([expect.objectContaining({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'] })]);
      expect(nudgeNotes(p.id)).toHaveLength(1);
      expect(workerWaits(p.id)).toEqual([]);
      expect(semaphore.busy()).toBe(0);
    });

    // hearsay-tools/cezarion#1301: a queued refusal is owed input, and a reopened session that closes
    // before Squawk submits it is a failed delivery, as U14's: one copy, the delivery bound, and the
    // run fails keeping it. A legacy accepted Finish takes the same path.
  }
}
