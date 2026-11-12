import { waitPartDescribers, github, nativeWire, turnEnds, pr, stepStatus, prompted, ASK_CONTEXT, questions, pendingQuestion, humanOpen, sessionOf, settled, gated } from './waits-parity-fixture.testkit.ts';
import { NO_WAIT_NUDGE_NOTE, MAX_AUTO_CONTINUES, NO_WAIT_NOTE } from './run.ts';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it as registerTest, expect } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { WAIT_KIND, WAIT_PHASE, WAIT_VIA, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { root, parent, until, store, worker, manager, collect, terminal } from './worker-wait-core.testkit.ts';
import { workflowDefSchema, QUICK_TASK_WORKFLOW } from './types.ts';
import { NO_WAIT_NUDGE } from './turn-end.ts';
import { expectNoWaitNudgeKinds } from './turn-end.testkit.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import { toolCall } from './waits-parity.testkit.ts';

// The done part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('done', doneCells);

export function doneCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    it(`${runner} U6 cezar_done is refused with live workers and with settled but uncollected workers, accepted once collected, and open waits are cancelled`, async () => {
      const external = github();
      nativeWire(runner);
      const answers = join(root, 'done-answers');
      process.env.CEZ_MOCK_CI_RESULT = answers;
      const p = await parent(HARNESS_ADAPTERS[runner].scenarios.baseline!, runner);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id);
      /** One turn through the native wire; the answer of its last Squawk tool call. */
      const turn = async (text: string) => {
        const turns = turnEnds(p.id);
        rmSync(answers, { force: true });
        expect(manager.sendMessage(p.id, [{ type: 'text', text }])).toBe(true);
        await until(() => turnEnds(p.id) > turns && existsSync(answers) && store.getRun(p.id)?.status !== 'running');
        return JSON.parse(JSON.parse(readFileSync(answers, 'utf8')).response.content[0].text.split('\n')[0]);
      };
      const outstanding = await turn(toolCall('cezar_done', {}));
      expect(outstanding).toMatchObject({ ok: false, code: 'workers_outstanding', workers: [{ worker_id: w.id, reason: 'outstanding' }] });
      expect(outstanding.message).toContain('worker wait');
      expect(outstanding.message).toContain(`worker stop ${w.id}`);
      expect(manager.isActive(p.id)).toBe(true);
      manager.requestWorkerStop(w.id);
      expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      const uncollected = await turn(toolCall('cezar_done', {}));
      expect(uncollected).toMatchObject({ ok: false, code: 'workers_uncollected', workers: [{ worker_id: w.id, reason: 'uncollected' }] });
      expect(uncollected.message).toContain(`worker collect ${w.id}`);
      await collect(w.id);
      const accepted = await turn(`${toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr })} ${toolCall('cezar_done', {})}`);
      const ci = store.getRun(p.id)?.lastWaits?.find(wait => wait.kind === 'pr');
      expect(accepted).toMatchObject({ ok: true, finishes: 'at_turn_end' });
      expect(accepted.open_waits).toEqual(expect.arrayContaining([expect.objectContaining({ wait_id: ci?.id, kind: WAIT_KIND.pr })]));
      await until(() => terminal.includes(store.getRun(p.id)?.status ?? '') && !manager.isActive(p.id));
      expect(ci).toMatchObject({ phase: WAIT_PHASE.cancelled, via: WAIT_VIA.cezar_wait });
      expect(store.getRun(p.id)?.waits ?? []).toEqual([]);
      expect(external.aborted()).toBe(true);
      const closed = store.readEvents(p.id).filter(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed');
      expect(closed).toEqual([expect.objectContaining({ via: 'cezar_done' })]);
    });

    // hearsay-tools/cezarion#1620: every agent step accepts the done. In a step that is not the
    // last, it completes that step, says which step starts, and the next step runs.
    it(`${runner} U6s cezar_done in a workflow step that is not the last completes that step, and the next step runs`, async () => {
      nativeWire(runner);
      const answers = join(root, 'done-answers');
      process.env.CEZ_MOCK_CI_RESULT = answers;
      const chain = workflowDefSchema.parse({ name: 'done-chain', source: 'file', steps: [
        { id: 'implement', prompt: '{{task}}' },
        { id: 'review', name: 'Review', prompt: HARNESS_ADAPTERS[runner].scenarios.baseline! },
      ] });
      const run = manager.startRun(chain, { task: toolCall('cezar_done', { summary: 'step shipped' }), runner });
      await until(() => stepStatus(run.id, 'review') === 'waiting' && existsSync(answers));
      const answer = JSON.parse(JSON.parse(readFileSync(answers, 'utf8')).response.content[0].text.split('\n')[0]);
      expect(answer).toMatchObject({ ok: true, finishes: 'at_turn_end', completes: 'step', next_step: 'Review' });
      expect(store.getRun(run.id)!.steps.map(step => [step.id, step.status])).toEqual([['implement', 'done'], ['review', 'waiting']]);
      const closings = store.readEvents(run.id).filter(event => event.type === 'lifecycle' && String(event.message).endsWith('session closed'));
      expect(closings).toEqual([expect.objectContaining({ message: 'step complete — session closed', via: 'cezar_done' })]);
      expect(store.readEvents(run.id).some(event => event.type === 'note' && event.message === 'step shipped')).toBe(true);
      // The step that signalled done is never nudged; only the next step's quiet turn end is.
      const noWaitNudges = store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE));
      expect(noWaitNudges.map(event => event.stepId)).toEqual(['review']);
    });

    it(`${runner} U7d cezar_done finishes through the done path in a message turn and in a Continue`, async () => {
      nativeWire(runner);
      const closings = (id: string) => store.readEvents(id).filter(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed');
      const finished = (id: string) => terminal.includes(store.getRun(id)?.status ?? '') && !manager.isActive(id);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      // A turn that ends on an accepted done gets no no-wait nudge, fresh or continued.
      const nudged = prompted(runner, NO_WAIT_NUDGE).length;
      expect(manager.sendMessage(run.id, [{ type: 'text', text: toolCall('cezar_done', { summary: 'u7d shipped' }) }])).toBe(true);
      await until(() => finished(run.id));
      const status = store.getRun(run.id)!.status;
      expect(closings(run.id)).toEqual([expect.objectContaining({ via: 'cezar_done' })]);
      expect(prompted(runner, NO_WAIT_NUDGE)).toHaveLength(nudged);
      // The summary is the note right before the closing event.
      const events = store.readEvents(run.id);
      expect(events[events.findIndex(event => event.seq === closings(run.id)[0]!.seq) - 1]).toMatchObject({ type: 'note', message: 'u7d shipped' });
      // A Continue turn finishes through the same path on its own handler.
      expect(manager.continueRun(run.id, { text: toolCall('cezar_done', {}) }).ok).toBe(true);
      await until(() => closings(run.id).length === 2 && finished(run.id));
      expect(closings(run.id).map(event => event.via)).toEqual(['cezar_done', 'cezar_done']);
      expect(store.getRun(run.id)!.status).toBe(status);
      expect(prompted(runner, NO_WAIT_NUDGE)).toHaveLength(nudged);
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE))).toHaveLength(nudged);
    });

    // The answer a Continue opens with is no longer a pending question to cezar_done.
    it(`${runner} U7d a Continue that answers the question finishes through cezar_done`, async () => {
      nativeWire(runner);
      const answers = join(root, 'done-answers');
      process.env.CEZ_MOCK_CI_RESULT = answers;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: ASK_CONTEXT, questions }), runner });
      await until(() => pendingQuestion(run.id) && humanOpen(run.id)[0]?.askSeq !== undefined);
      const [wait] = humanOpen(run.id);
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      rmSync(answers, { force: true });
      store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES, waitDeliveryFailures: 2 });
      // What a crash after any commit would leave (hearsay-tools/cezarion#1805): every committed row.
      const commits = recordCommits(join(root, '.ai/cezar'));
      const answer = toolCall('cezar_done', { summary: 'answered and shipped' });
      expect(manager.continueRun(run.id, { text: answer }).ok).toBe(true);
      commits.stop();
      commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(entry => entry.id === wait!.id && entry.phase === 'delivered') ||
        (row.automaticWakes === 0 && row.waitDeliveryFailures === undefined), 'an answered wait and its reset wake budget');
      // The wait is never delivered in a row that lost the answer it was delivered with: until the
      // Continue's step starts, a row with the wait delivered holds the answer.
      commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(entry => entry.id === wait!.id && entry.phase === 'delivered') ||
        row.continuationMessage?.text === answer.trim() || row.steps.some(step => step.id === 'continue-1' && step.status !== 'pending'), 'an answered wait and its answer');
      expect(commits.rows(run.id).some(row => row?.lastWaits?.some(entry => entry.id === wait!.id && entry.phase === 'delivered') && row.continuationMessage?.text === answer.trim())).toBe(true);
      // File creation precedes write completion in the mock child. Read its response only
      // after the native turn has finished, when the child has completed the write.
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? '') && !manager.isActive(run.id));
      expect(JSON.parse(JSON.parse(readFileSync(answers, 'utf8')).response.content[0].text.split('\n')[0])).toMatchObject({ ok: true, finishes: 'at_turn_end' });
      expect(store.readEvents(run.id).filter(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed'))
        .toEqual([expect.objectContaining({ via: 'cezar_done' })]);
      expect(settled(run.id, wait!.id)?.phase).toBe('delivered');
    });

    // hearsay-tools/cezarion#1234 phase 2b: one turn-end rule. Nothing reads the turn's prose.
    it(`${runner} U5 a turn end with no wait gets one nudge, then a second no-wait turn end opens a no-wait human wait and reads needs you`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => gated(run.id));
      expect(prompted(runner, NO_WAIT_NUDGE)).toHaveLength(1);
      expectNoWaitNudgeKinds(prompted(runner, NO_WAIT_NUDGE)[0]!);
      const [wait, ...more] = humanOpen(run.id);
      expect(more).toEqual([]);
      expect(wait).toMatchObject({ kind: WAIT_KIND.human, via: WAIT_VIA['no-wait'], source: WAIT_SOURCE.cezar, phase: WAIT_PHASE.open });
      expect(wait!.questions).toBeUndefined();
      expect(store.getRun(run.id)?.automaticWakes).toBe(1);
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && event.message === NO_WAIT_NOTE)).toHaveLength(1);
      expect(toRunSummary(store.getRun(run.id)!).waitingOn).toEqual({ kind: WAIT_KIND.human, shown: true });
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      // The user's reply answers it and restarts the budget; the reply's own turn is nudged again.
      expect(manager.sendMessage(run.id, [{ type: 'text', text: 'carry on' }])).toBe(true);
      await until(() => settled(run.id, wait!.id)?.phase === 'delivered');
      await until(() => prompted(runner, NO_WAIT_NUDGE).length === 2 && gated(run.id));
      for (const nudge of prompted(runner, NO_WAIT_NUDGE)) expectNoWaitNudgeKinds(nudge);
      expect(store.getRun(run.id)?.automaticWakes).toBe(1);
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    // hearsay-tools/cezarion#1805: a message deferred while its session started up
    // (open-mercato/cezar#472) is queued beside the waits. When it answers the question, the answered
    // wait and the removed queue entry are one commit: a reopened store never replays an answer it
    // shows delivered, nor shows the question open after dropping the answer.
  }
}
