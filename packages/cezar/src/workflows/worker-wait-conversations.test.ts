import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { manager, semaphore, store, until, useWorkerWaitFixture, waitOf, lastWaitOf } from './worker-wait.testkit.ts';
import { conversationPair } from './worker-wait-conversations.testkit.ts';

describe('parent and worker conversation waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const runner of RUNNER_IDS) {
    it(`${runner} WP1 progress wakes the parent and preserves its worker wait until one terminal wake`, async () => {
      process.env.CEZ_DRY_RUN = '0';
      process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
      process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
      const f = await conversationPair(runner);
      try {
        const wait = manager.registerWorkerWait(f.p.id, { workerIds: [f.w.id], timeoutSeconds: 600 });
        await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
        for (let n = 0; n < 2; n++) {
          const id = randomUUID();
          await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'progress', text: 'Still working mock:hold', timeoutSeconds: 600 });
          await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
          expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, deadline: wait.deadline, workerIds: [f.w.id] });
          await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
          expect(semaphore.busy()).toBe(0);
        }
        expect(manager.finish(f.w.id)).toBe(true);
        await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt);
        manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
        expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
        expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
        expect(lastWaitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, reason: 'outcome' });
      } finally { f.close(); }
    });
  }
});
