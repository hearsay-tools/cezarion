import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { withDelayedCommand, withHeldPipeResponse } from '../core/owned-input-delivery.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { manager, store, root, worker, until, semaphore, useWorkerWaitFixture } from './worker-wait.testkit.ts';

// Exhaustive transport classification: a new runner must provide either the real
// delayed-ACK race or an executable wire limitation, never an omitted/skip row.
const ACK_WIRES = {
  claude: 'pipe-write', codex: 'protocol', opencode: 'protocol', pi: 'protocol', cursor: 'pipe-write',
} as const satisfies Record<RunnerId, 'pipe-write' | 'protocol'>;

it('classifies every RUNNER_IDS delayed-ACK cell without omissions', () => {
  expect(Object.keys(ACK_WIRES).sort()).toEqual([...RUNNER_IDS].sort());
});

for (const backend of RUNNER_IDS) describe(`${backend} worker parent attention`, { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const mode of ['fresh', 'continuation'] as const) {
    for (const transport of ['ordinary', ACK_WIRES[backend]] as const) {
      it(`${mode} worker progress then markerless turn stays Working (${transport === 'pipe-write' ? 'pipe-write ACK exemption: acceptance precedes provider response' : transport === 'protocol' ? 'delayed ACK' : 'ordinary ACK'})`, async () => {
        const exercise = async (release: () => void, responseHeld?: () => boolean) => {
          process.env.CEZ_DRY_RUN = '0';
          process.env.CEZ_DELEGATION = '1';
          process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
          const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
          store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
          await until(() => store.getRun(p.id)?.status === 'waiting');
          // No workers and no marker still means waiting (#119).
          expect(store.getRun(p.id)?.activity).toBeUndefined();
          if (mode === 'continuation') {
            expect(manager.finish(p.id)).toBe(true);
            await until(() => !manager.isActive(p.id));
            expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
            await until(() => store.getRun(p.id)?.status === 'waiting');
          }
          expect(store.getRun(p.id)).toMatchObject({ status: 'waiting' });
          expect(store.getRun(p.id)?.activity).toBeUndefined();
          expect(store.getRun(p.id)?.monitoringWakeAt).toBeUndefined();
          const w = await worker(p.id);
          process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
          manager.enqueueOwnedRun(w.id);
          await until(() => store.getRun(w.id)?.status === 'waiting');
          const credentials = new CredentialRegistry();
          const service = new DelegationService();
          service.registerProject({ id: 'project', root, store, manager });
          try {
            const caller = credentials.authenticate(credentials.issue('project', w.id, randomUUID()))!;
            const id = randomUUID();
            const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
            await service.send(caller, { id, recipientRunId: p.id, kind: 'progress', text: 'Progress mock:agent-echo delay-owned-ack', timeoutSeconds: 600 });
            if (responseHeld) {
              // Claude and Cursor acknowledge the local pipe write, not any
              // provider reply. A held wire response cannot delay that ACK.
              await until(responseHeld);
              await until(() => !!store.getRun(p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
              expect(store.readEvents(p.id).filter(event => event.type === 'turn-end')).toHaveLength(boundaries);
              release();
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
            expect(store.getRun(p.id)).toMatchObject({ status: 'running', activity: 'monitoring' });
            expect(store.getRun(p.id)?.hasPendingHumanAsk).not.toBe(true);
            expect(store.getRun(p.id)?.monitoringWakeAt).toBeDefined();
          } finally { release(); credentials.close(); }
        };
        if (transport === 'protocol' && backend !== 'claude' && backend !== 'cursor') await withDelayedCommand(backend, exercise);
        else if (transport === 'pipe-write' && (backend === 'claude' || backend === 'cursor')) await withHeldPipeResponse(backend, exercise);
        else await exercise(() => {});
      });
    }
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
      expect(store.getRun(p.id)).toMatchObject({ status: 'running', activity: 'monitoring' });
      const ask = { questions: [{ header: 'Choice', question: 'Which module?', options: [{ label: 'Parser' }, { label: 'Runner' }] }] };
      manager.sendMessage(p.id, [{ type: 'text', text: `mock:agent-echo\nCEZ:ASK ${JSON.stringify(ask)}` }]);
      await until(() => store.getRun(p.id)?.hasPendingHumanAsk === true);
      expect(store.getRun(p.id)?.status).toBe('waiting');
      expect(store.getRun(p.id)?.monitoringWakeAt).toBeUndefined();
    });
  }
});
