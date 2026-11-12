import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES } from './run.ts';
import { toolCall } from './waits-parity.testkit.ts';
import { randomUUID } from 'node:crypto';
import { collect, manager, parent, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';
import { completionNudges, sentTexts, recordAgentInput, blockedDone, sessionOf } from './worker-wait-readiness.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

// Real Git, durable checkpoints and native process shutdown retain their original budgets.
describe('worker waits: refusal', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();

it('readiness repeated done with live workers: one nudge, then a park on the re-check timer, and no automatic wait', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await blockedDone(p.id, () => worker(p.id));
    await until(() => completionNudges(p.id).length === 1 && store.getRun(p.id)?.status === 'waiting');
    const timer = store.getRun(p.id)?.waits?.find(wait => wait.kind === 'timer' && wait.via === 'monitoring-line');
    expect(timer).toBeDefined();
    const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
    // Deliver Squawk's own lifecycle input through the public route, without a human budget reset.
    const input = { id: randomUUID(), source: 'lifecycle' as const, parentRunId: p.id,
      text: toolCall('cezar_done', {}), createdAt: new Date().toISOString() };
    store.updateRun(p.id, { agentInputs: [...store.getRun(p.id)?.agentInputs ?? [], input] });
    manager.deliverConversationInput(p.id);
    const refused = () => store.readEvents(p.id).filter(event => event.type === 'text' && String(event.text).includes('workers_outstanding') && String(event.text).includes(`worker stop ${w.id}`));
    // The child reply and stdin delivery receipt arrive on independent pipes.
    // bound: fail if either lifecycle signal is missing; neither signal requires a refusal.
    await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries &&
      !!store.getRun(p.id)?.agentInputs?.find(found => found.id === input.id)?.deliveredAt);
    expect(refused()).toHaveLength(1);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(completionNudges(p.id)).toHaveLength(1);
    expect(store.getRun(p.id)?.waits).toEqual([expect.objectContaining({ id: timer!.id, phase: WAIT_PHASE.open })]);
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('completion');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.filter(found => found.source === 'lifecycle')).toEqual([expect.objectContaining({ id: input.id, deliveredAt: expect.any(String) })]);
    expect(store.getRun(w.id)?.status).toBe('queued');
  });
it('a blocked done with the automatic-wake budget spent opens the budget human wait instead of a nudge', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    store.commitOutcome(p.id, { kind: 'charged', automaticWakes: MAX_AUTO_CONTINUES });
    const sent = recordAgentInput(p.id);
    const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
    // Straight to the session: a human message would restart the budget.
    const w = await blockedDone(p.id, () => worker(p.id), text => sessionOf(p.id).sendMessage([{ type: 'text', text }]));
    await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries && store.getRun(p.id)?.status === 'waiting');
    expect(completionNudges(p.id)).toEqual([]);
    expect(sentTexts(sent, `Workers are still live: ${w.id}.`)).toEqual([]);
    expect(store.getRun(p.id)?.waits).toEqual([expect.objectContaining({ kind: WAIT_KIND.human, source: WAIT_SOURCE.cezar, via: WAIT_VIA.budget, phase: WAIT_PHASE.open })]);
    expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes(`Workers are still live: ${w.id}.`))).toBe(true);
    expect(store.getRun(p.id)?.automaticWakes).toBe(MAX_AUTO_CONTINUES);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(manager.finish(p.id)).toBe(false);
  });
it('readiness settled uncollected completion sends the collect refusal without the will-wait sentence, then finishes once collected', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const sent = recordAgentInput(p.id);
    const w = await blockedDone(p.id, async () => {
      const settled = await worker(p.id);
      manager.requestWorkerStop(settled.id); expect(await manager.awaitRunTermination(settled.id, 15000)).toBe(true);
      return settled;
    });
    await until(() => completionNudges(p.id).length === 1 && store.getRun(p.id)?.status === 'waiting');
    const [nudge, ...more] = sentTexts(sent, `worker collect ${w.id}`);
    expect(more).toEqual([]);
    expect(nudge).not.toContain(COMPLETION_WILL_WAIT);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.source === 'lifecycle') ?? []).toEqual([]);
    await collect(w.id);
    process.env.CEZ_REVIEW_GATE = '1';
    writeFileSync(join(store.getRun(p.id)!.worktreePath!, 'parent-result.txt'), 'parent result');
    sessionOf(p.id).sendMessage([{ type: 'text', text: toolCall('cezar_done', {}) }]);
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('review');
  });
});
