import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { withHeldAck, withHeldResponse } from '../core/owned-input-delivery.testkit.ts';
import { attentionFields } from '../task-cli/projections.ts';
import { toolCall } from './waits-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { monitoringWakeOf } from './waits.testkit.ts';
import { delegatingParent, deliveredBesideWorkerMessages, fixtureUpdateRun, manager, parent, queuedWake, register, store, terminal, worker, until, semaphore, useWorkerWaitFixture, waitOf, workerEntryOf } from './worker-wait.testkit.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';

const ASK_PROMPT = toolCall('cezar_ask', { context: 'A choice is needed.', questions: [{ header: 'Choice', question: 'Which module?', options: [{ label: 'Parser' }, { label: 'Runner' }] }] });

// Exhaustive transport classification: a new runner must provide either the real
// delayed-ACK race or an executable wire limitation, never an omitted/skip row.
const ACK_WIRES = {
  claude: 'pipe-write', codex: 'protocol', opencode: 'protocol', pi: 'protocol', cursor: 'model-work', omp: 'protocol',
} as const satisfies Record<RunnerId, 'pipe-write' | 'protocol' | 'model-work'>;

export { ACK_WIRES };

type AttentionRow =
 | { family: 'progress'; backend: RunnerId; mode: 'fresh' | 'continuation'; transport: 'ordinary' | 'pipe-write' | 'protocol' | 'model-work' }
 | { family: 'spawn-ask'; backend: RunnerId; mode: 'fresh' | 'continuation' }
 | { family: 'completion' | 'timeout' | 'restart' | 'human-ask'; backend: RunnerId };
export const ATTENTION_GROUPS = {
 'fresh-ordinary-progress': RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'fresh', transport: 'ordinary' } as const)),
 'fresh-delayed-progress': RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'fresh', transport: ACK_WIRES[backend] } as const)),
 'continued-ordinary-progress': RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'continuation', transport: 'ordinary' } as const)),
 'continued-delayed-progress': RUNNER_IDS.map(backend => ({ family: 'progress', backend, mode: 'continuation', transport: ACK_WIRES[backend] } as const)),
 'fresh-spawn-ask': RUNNER_IDS.map(backend => ({ family: 'spawn-ask', backend, mode: 'fresh' } as const)),
 'continued-spawn-ask': RUNNER_IDS.map(backend => ({ family: 'spawn-ask', backend, mode: 'continuation' } as const)),
 'capacity-wake': RUNNER_IDS.flatMap(backend => { return (['completion', 'timeout'] as const).map(family => ({ family, backend } as const)); }),
 'restart-human-ask': RUNNER_IDS.flatMap(backend => { return (['restart', 'human-ask'] as const).map(family => ({ family, backend } as const)); }),
};
export type AttentionGroup = keyof typeof ATTENTION_GROUPS;
export function attentionRowKey(row: AttentionRow): string {
 return [row.backend, row.family, ...('mode' in row ? [row.mode] : []), ...('transport' in row ? [row.transport] : [])].join(':');
}
export function registerAttentionGroup(group: AttentionGroup): void {
 for (const backend of RUNNER_IDS) describe(`${backend} worker parent attention`, { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
const native = () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
    process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
  };
const capacity = (id: string) => {
    const run = store.getRun(id)!;
    expect(waitOf(run)?.phase).toBe('wake-pending');
    expect(hasPendingAsk(store, id)).toBe(false);
    expect(deliveredBesideWorkerMessages(run)).toBe(false);
    expect(deriveAttention(run)).toMatchObject({ bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity' });
    expect(attentionFields(run)).toEqual({ attention: 'none', attentionLabel: 'waiting for capacity' });
  };
 for(const row of ATTENTION_GROUPS[group] as readonly AttentionRow[]) {
 if(row.backend !== backend) continue;
if(row.family === 'progress') {
 const {mode, transport} = row;
 // No prose is read (hearsay-tools/cezarion#1234, hearsay-tools/cezarion#2397): the turn the
 // progress message starts parks on the monitoring timer the live worker opens.
it(`${mode} ${mode === 'fresh' ? 'M26' : 'M27'} worker progress through an input ACK keeps monitoring with live workers (${transport === 'pipe-write' ? 'pipe-write ACK exemption: acceptance precedes provider response' : transport === 'model-work' ? 'model-work admission boundary' : transport === 'protocol' ? 'delayed ACK' : 'ordinary ACK'})`, async () => {
        const exercise = async (release: () => void, responseHeld?: () => boolean) => {
          process.env.CEZ_DRY_RUN = '0';
          process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
          const { p, service, callerFor, close } = await delegatingParent({ runner: backend, permissions: ['spawn', 'wait'] });
          await until(() => store.getRun(p.id)?.status === 'waiting');
          // No workers and no marker still means waiting (#119).
          if (mode === 'continuation') {
            expect(manager.finish(p.id)).toBe(true);
            await until(() => !manager.isActive(p.id));
            expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
            await until(() => store.getRun(p.id)?.status === 'waiting');
          }
          expect(store.getRun(p.id)).toMatchObject({ status: RUN_STATUS.waiting });
          expect(monitoringWakeOf(store.getRun(p.id))).toBeUndefined();
          const w = await worker(p.id);
          process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
          manager.enqueueOwnedRun(w.id);
          await until(() => store.getRun(w.id)?.status === 'waiting');
          try {
            const caller = callerFor(w.id);
            const id = randomUUID();
            const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
            const delivery = service.send(caller, { id, recipientRunId: p.id, kind: 'progress', text: 'Progress mock:agent-echo delay-owned-ack', timeoutSeconds: 600 });
            if (transport === 'model-work') {
              await until(() => responseHeld?.() === true);
              expect(store.getRun(p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt).toBeUndefined();
              release();
            }
            await delivery;
            if (responseHeld) {
              // Claude acknowledges the local pipe write; Cursor print waits
              // for native model work before acknowledging owned input.
              if (transport === 'pipe-write') {
                await until(responseHeld);
                await until(() => !!store.getRun(p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
                expect(store.readEvents(p.id).filter(event => event.type === 'turn-end')).toHaveLength(boundaries);
                release();
              }
            }
            await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries);
            if (transport === 'protocol') {
              expect(store.getRun(p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt).toBeUndefined();
              expect(semaphore.busy()).toBe(1);
            }
            release();
            await until(() => !!store.getRun(p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
            await until(() => semaphore.busy() === 0);
            expect(store.readEvents(p.id).some(event => event.type === 'conversation-message')).toBe(true);
            expect(store.getRun(p.id)).toMatchObject({ status: RUN_STATUS.waiting });
            expect(hasPendingAsk(store, p.id)).not.toBe(true);
            expect(store.getRun(p.id)?.waits?.filter(wait => wait.kind === 'human') ?? []).toEqual([]);
            expect(monitoringWakeOf(store.getRun(p.id))).toBeDefined();
          } finally { release(); close(); }
        };
        if (transport === 'protocol' && backend !== 'claude' && backend !== 'cursor') await withHeldAck(backend, exercise);
        else if (transport === 'pipe-write' && backend === 'claude') await withHeldResponse(backend, exercise);
        else if (transport === 'model-work' && backend === 'cursor') await withHeldResponse('cursor', exercise);
        else await exercise(() => {});
      });
}
if(row.family === 'spawn-ask') {
 const {mode} = row;
it(`${mode} spawn without wait parks as monitoring and a real ASK still wins`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
      const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
      store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      if (mode === 'continuation') {
        expect(manager.finish(p.id)).toBe(true);
        await until(() => !manager.isActive(p.id));
        expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
        await until(() => store.getRun(p.id)?.status === 'waiting');
      }
      await worker(p.id);
      const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
      manager.sendMessage(p.id, [{ type: 'text', text: 'mock:hold' }]);
      await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries);
      expect(store.getRun(p.id)).toMatchObject({ status: RUN_STATUS.waiting });
      const timer = monitoringWakeOf(store.getRun(p.id));
      expect(timer).toBeDefined();
      manager.sendMessage(p.id, [{ type: 'text', text: ASK_PROMPT }]);
      await until(() => hasPendingAsk(store, p.id) === true);
      expect(store.getRun(p.id)?.status).toBe('waiting');
      // hearsay-tools/cezarion#1233: the question outranks the open timer, which an ask never cancels.
      expect(deriveAttention(store.getRun(p.id)!).label).toBe('needs you');
      expect(monitoringWakeOf(store.getRun(p.id))).toBe(timer);
    });
}
if(row.family === 'completion') {
it('queued wake after worker completion waits for capacity, not Needs you (#971)', async () => {
    native();
    const p = await parent('mock:hold', backend);
    const w = await worker(p.id);
    register(p.id, [w.id]);
    manager.enqueueOwnedRun(w.id);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    await until(() => store.getRun(w.id)?.status === 'running');
    const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
    try {
      await until(() => store.getRun(w.id)?.status === 'waiting');
      await until(() => store.getRun(blocker.id)?.status === 'running');
      // The wait settles on the worker's durable exit proof, not its status write:
      // finishWorkerExecution awaits the worker's sessions, turns and deliveries, then
      // commitWorkerExecutionComplete emits the run that reconcileWorkerWaits reads.
      // Hold the durable proof at its store boundary (hearsay-tools/cezarion#1113: the
      // gate read `parked` right after the worker reached `done`).
      const complete = vi.spyOn(store, 'commitWorkerExecutionComplete').mockReturnValue(false);
      manager.finish(w.id);
      try {
        await until(() => terminal.includes(store.getRun(w.id)?.status ?? ''));
        await until(() => complete.mock.calls.some(([id]) => id === w.id));
        // Until the proof lands the parent stays parked on its worker, and that reads as
        // waiting on the worker, never Needs you.
        expect(waitOf(store.getRun(p.id))?.phase).toBe('parked');
        expect(deriveAttention(store.getRun(p.id)!)).toMatchObject({ bucket: 'none', tone: 'running', shape: 'workers', label: 'waiting on 1 worker' });
      } finally { complete.mockRestore(); }
      expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      await until(() => waitOf(store.getRun(p.id))?.phase !== 'parked');
      expect(store.getRun(p.id)?.status).toBe('waiting');
      capacity(p.id);
    } finally {
      manager.cancel(blocker.id);
    }
  });
}
if(row.family === 'timeout') {
it('queued wake after wait timeout waits for capacity, not Needs you (#971)', async () => {
    native();
    const p = await parent('mock:hold', backend);
    const w = await worker(p.id, 'mock:slow');
    register(p.id, [w.id]);
    manager.enqueueOwnedRun(w.id);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    await until(() => store.getRun(w.id)?.status === 'running');
    // hearsay-tools/cezarion#1235: the agent's wait is a list entry; move its deadline to now.
    const entry = workerEntryOf(store.getRun(p.id));
    if (!entry) throw Error('fixture');
    store.commitWait(p.id, { ...entry, deadline: new Date().toISOString() });
    manager.reconcileWorkerWaits();
    await until(() => waitOf(store.getRun(p.id))?.phase === 'wake-pending');
    expect(waitOf(store.getRun(p.id))?.reason).toBe('timeout');
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(w.id)?.status).toBe('running');
    capacity(p.id);
  });
}
if(row.family === 'restart') {
it('queued leftover after restart waits for capacity, not Needs you (#971)', async () => {
    native();
    const { p } = await queuedWake(backend);
    expect(store.getRun(p.id)?.status).toBe('queued');
    capacity(p.id);
  });
}
if(row.family === 'human-ask') {
it('keeps a wake-pending parent with a pending human ask as Needs you (#971)', async () => {
    native();
    const p = await parent('mock:hold', backend);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const send = async (prompt: string, afterDelivery?: () => void) => {
      const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
      expect(manager.sendMessage(p.id, [{ type: 'text', text: prompt }])).toBe(true);
      afterDelivery?.();
      await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries && semaphore.busy() === 0);
    };
    await send(ASK_PROMPT, () => {
      expect(register(p.id, [w.id]).phase).toBe('registered');
    });
    expect(hasPendingAsk(store, p.id)).toBe(true);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(waitOf(store.getRun(p.id))?.phase).toBe('registered');
    fixtureUpdateRun(w.id, { status: RUN_STATUS.done });
    manager.reconcileWorkerWaits();
    await until(() => waitOf(store.getRun(p.id))?.phase === 'wake-pending');
    const run = store.getRun(p.id)!;
    expect(hasPendingAsk(store, p.id)).toBe(true);
    expect(run.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
    expect(deriveAttention(run)).toMatchObject({ bucket: 'waiting', label: 'needs you' });
    expect(attentionFields(run)).toEqual({ attention: 'waiting', attentionLabel: 'needs you' });
  });
}
 }
 });
}
