import { captureSessions } from './runner-session-capture.testkit.ts';
import { NO_WAIT_NUDGE_NOTE } from './turn-end.ts';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type RunRecord } from '../runs/store.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { withHeldAck } from '../core/owned-input-delivery.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { bookkeeping, collect, manager, register, root, semaphore, store, terminal, until, waitOf, workerEntryOf, worker } from './worker-wait.testkit.ts';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { parkedOnWorkers, useWorkerCapacityFixture } from './worker-wait-capacity.testkit.ts';

describe("worker waits through RunManager", { timeout: 30_000 }, () => {
  useWorkerCapacityFixture();

// The wake turn ends with no wait or done, so its boundary sends the no-wait nudge
  // (hearsay-tools/cezarion#1234) where it parked before; the nudge's charge is the decision on disk.
  it('interactive markerless wake persists its turn-end decision immediately after its held HTTP ACK', async () => {
    const sessionOf = captureSessions();
    await withHeldAck('opencode', async release => {
      process.env.CEZ_DRY_RUN = '0';
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      process.env.CEZ_OPENCODE_BIN = HARNESS_ADAPTERS.opencode.mockBin;
      const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: 'opencode' });
      store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id, 'mock:slow');
      register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
      try {
        await until(() => sessionOf(w.id).open);
        const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
        manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
        // The wake turn's own frames reach the runner while its acknowledgement is held. The wake is
        // Squawk's text, so the mock answers it with its ordinary turn rather than an echo.
        await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries);
        await Promise.all(bookkeeping);
        store.flush(); // Earlier turn bookkeeping/debounce cannot satisfy the measured ACK checkpoint.
        const wake = structuredClone(store.getRun(p.id)?.agentInputs?.find(input => input.source === 'lifecycle'));
        expect(wake?.deliveredAt).toBeUndefined();
        const charged = store.getRun(p.id)?.automaticWakes ?? 0; // the first turn's nudge
        let disk: RunRecord | undefined;
        const append = store.appendEvent.bind(store);
        const checkpoint = vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
          // The charge precedes its note. Read before forwarding so this event cannot flush it.
          if (id === p.id && event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE)) {
            disk = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).find(run => run.id === p.id);
          }
          return append(id, event);
        });
        release();
        await until(() => disk !== undefined);
        checkpoint.mockRestore();
        // Captured synchronously at the post-ACK charge boundary, before debounce.
        expect.soft(disk!.automaticWakes).toBe(charged + 1);
        expect.soft(disk!.status).toBe('running');
        expect(waitOf(disk)).toBeUndefined();
        expect(disk!.agentInputs?.find(input => input.id === wake?.id)?.deliveredAt).toEqual(expect.any(String));
      } finally {
        release();
        for (const run of store.listRuns()) manager.cancel(run.id);
        await until(() => store.listRuns().every(run => !manager.isActive(run.id)));
      }
    }, 'Worker wait');
  });

it('an actual session close during a nonfinal wait cannot advance a check or retain a capacity exemption', async () => {
    const sessionOf = captureSessions();
    const run = manager.startRun({ name: 'closed chain', source: 'built-in', steps: [{ id: 'first', prompt: 'mock:hold' }, { id: 'next', command: 'echo checked' }] }, { task: 'parent', runner: 'claude' });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    await until(() => sessionOf(run.id).open);
    const w = await worker(run.id, 'mock:slow'); register(run.id, [w.id]); manager.enqueueOwnedRun(w.id);
    // A stored park precedes slot release; worker startup proves admission completed.
    await until(() => parkedOnWorkers(run.id) && !!store.getRun(w.id)?.steps.some(step => !!step.sessionId));
    sessionOf(run.id).end();
    // hearsay-tools/cezarion#1235: a clean close with a worker wait open parks, recoverably (spec
    // "Session failure and close"); it used to fail the run.
    await until(() => !manager.isActive(run.id));
    expect(store.getRun(run.id)).toMatchObject({ status: RUN_STATUS.waiting });
    expect(store.getRun(run.id)?.error).toBeUndefined();
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
    expect(waitOf(store.getRun(run.id))?.phase).toBe('parked');
    // The parked parent holds no slot: the one slot is its running worker's, and nothing more.
    await until(() => sessionOf(w.id).open);
    expect(semaphore.busy()).toBe(1);
    manager.requestWorkerStop(w.id); expect(await manager.awaitRunTermination(w.id, 15000)).toBe(true);
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
  });

it('a portable human ask still takes precedence over an accepted nonfinal worker wait', async () => {
    const sessionOf = captureSessions();
    const run = manager.startRun({ name: 'ask chain', source: 'built-in', steps: [{ id: 'first', prompt: 'mock:cezar-ask' }, { id: 'next', command: 'echo checked' }] }, { task: 'parent', runner: 'claude' });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    await until(() => sessionOf(run.id).open);
    const w = await worker(run.id); register(run.id, [w.id]);
    await until(() => store.getRun(run.id)?.status === 'waiting');
    expect(store.readEvents(run.id).some(event => event.type === 'ask.requested')).toBe(true);
    // hearsay-tools/cezarion#1235 phase 3a: the worker wait is an open list entry beside the
    // question, and the question's park, like a worker park, holds no slot.
    expect(workerEntryOf(store.getRun(run.id))).toMatchObject({ phase: WAIT_PHASE.open, workerIds: [w.id] });
    expect(toRunSummary(store.getRun(run.id)!).waitingOn).toEqual({ kind: WAIT_KIND.human, shown: true });
    expect(semaphore.busy()).toBe(0);
    manager.requestWorkerStop(w.id); await manager.awaitRunTermination(w.id, 15000);
    expect(store.getRun(run.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
    expect(store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status).toBe('pending');
    // The answer signals done, which the uncollected worker would refuse (hearsay-tools/cezarion#1620).
    await collect(w.id);
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Vitest mock:cezar-done' }])).toBe(true);
    await until(() => store.getRun(run.id)?.steps.find(step => step.id === 'next')?.status === 'done');
    expect(store.readEvents(run.id).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
  });

it('an ordinary earlier step advances to the next check on its done without a worker wait', async () => {
    const run = manager.startRun({ name: 'ordinary chain', source: 'built-in', steps: [{ id: 'first', prompt: 'mock:cezar-done' }, { id: 'next', command: 'echo checked' }] }, { task: 'parent', runner: 'claude' });
    await until(() => terminal.includes(store.getRun(run.id)!.status));
    expect(store.getRun(run.id)?.steps.map(step => step.status)).toEqual(['done', 'done']);
    expect(semaphore.busy()).toBe(0);
  });
});
