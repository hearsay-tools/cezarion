import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerWaitRequestSchema } from '@open-mercato/cezar-contract';
import { RUNNER_IDS, type AgentSession, type RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { CiToolController } from '../ci-wait/controller.ts';
import { callCiWait } from '../ci-wait/client.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { manager, store, root, worker, fixtureUpdateRun, until, waitOf, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

// Delay only native mock output. The runner, lifecycle, IPC and persistence stay real.
function holdNativeTurn(runner: RunnerId) {
  const adapter = HARNESS_ADAPTERS[runner];
  const release = join(root, 'release-turn'), received = join(root, 'held-turn');
  let source = readFileSync(adapter.mockBin, 'utf8').replace(/^#!.*\n/, '');
  const gate = `await ciRefusalGate();`;
  if (runner === 'codex' || runner === 'opencode') {
    const pattern = /setTimeout\(\(\) => \{(\s+const held =)/;
    expect(source.match(pattern)).not.toBeNull();
    source = source.replace(pattern, `setTimeout(async () => { ${gate}$1`);
  } else {
    const anchor = runner === 'claude' ? "const held = 'parity hold: content after the pause';"
      : runner === 'pi' ? "sendText(['parity hold: content after the pause']);"
      : runner === 'omp' ? "assistantText(['parity hold: content after the pause']);"
      : "if (prompt.includes('mock:hold')) await new Promise(resolve => setTimeout(resolve, 500));";
    expect(source.split(anchor)).toHaveLength(2);
    source = source.replace(anchor, runner === 'cursor' ? `if (prompt.includes('mock:hold')) { ${gate} }` : `${gate}\n${anchor}`);
  }
  if (runner === 'cursor') source = source.replaceAll("import('./", `import('${join(adapter.mockBin, '..')}/`);
  const mock = join(root, 'gated-native.mjs');
  writeFileSync(mock, `#!/usr/bin/env node\nimport * as ciGateFs from 'node:fs';
async function ciRefusalGate() {
  ciGateFs.writeFileSync(${JSON.stringify(received)}, '');
  while (!ciGateFs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 5));
}\n${source}`, { mode: 0o755 });
  process.env.CEZ_DRY_RUN = '0';
  process.env[adapter.binEnv] = mock;
  return { received: () => existsSync(received), release: () => writeFileSync(release, '') };
}

const pr = 'https://github.com/acme/repo/pull/12';
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };

describe('R27 CI registration refusal after worker settlement — #713', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it.each(RUNNER_IDS)('%s names a settled but undelivered worker wait, then registers after delivery', async runner => {
    const wire = holdNativeTurn(runner);
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
    const controller = await CiToolController.start();
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.hold!, runner });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    try {
      await until(wire.received);
      const state = (manager as unknown as { active: Map<string, { ciGeneration: string; session: AgentSession }> }).active.get(run.id)!;
      const tools = controller.provision((request, signal) => manager.registerCiWait(run.id, request, state.ciGeneration, signal));
      const child = await worker(run.id);
      const wait = manager.registerWorkerWait(run.id, workerWaitRequestSchema.parse({ workerIds: [child.id] }));
      // Pending and settled-but-undelivered waits must both identify their blocker.
      await expect.soft(callCiWait({ pr }, tools.env)).rejects.toThrow(/worker_wait_pending:.*worker wait.*[Ee]nd your turn/);
      fixtureUpdateRun(child.id, { status: 'done' });
      manager.reconcileWorkerWaits();
      await until(() => waitOf(store.getRun(run.id))?.phase === 'wake-pending');
      const queued = () => store.getRun(run.id)?.agentInputs?.find(input => input.id === wait.id);
      expect(queued()?.deliveredAt).toBeUndefined();
      expect(store.readEvents(run.id).filter(e => e.type === 'turn-end')).toHaveLength(0);
      await expect(callCiWait({ pr }, tools.env)).rejects.toThrow(/worker_wait_pending:.*worker wait.*[Ee]nd your turn/);
      expect(store.getRun(run.id)?.ciWait).toBeUndefined();
      expect(waitOf(store.getRun(run.id))?.id).toBe(wait.id);
      wire.release();
      await until(() => !!queued()?.deliveredAt && !waitOf(store.getRun(run.id)));
      await expect(callCiWait({ pr }, tools.env)).resolves.toMatchObject({ prUrl: pr });
      expect(store.getRun(run.id)?.ciWait).toBeDefined();
      expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    } finally { wire.release(); await controller.close(); }
  });
  for (const action of ['cancel', 'destroy'] as const) {
    it.each(RUNNER_IDS)(`%s R80 ${action} frees a settled wait during the same native turn`, async runner => {
      const wire = holdNativeTurn(runner);
      vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
      vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
      const controller = await CiToolController.start();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.hold!, runner });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      try {
        await until(wire.received);
        const state = (manager as unknown as { active: Map<string, { ciGeneration: string }> }).active.get(run.id)!;
        const tools = controller.provision((request, signal) => manager.registerCiWait(run.id, request, state.ciGeneration, signal));
        const child = await worker(run.id);
        const wait = manager.registerWorkerWait(run.id, workerWaitRequestSchema.parse({ workerIds: [child.id] }));
        fixtureUpdateRun(child.id, { status: 'done' });
        manager.reconcileWorkerWaits();
        expect(waitOf(store.getRun(run.id))?.phase).toBe('wake-pending');
        const service = new DelegationService();
        const unregister = service.registerProject({ id: 'project', root, store, manager });
        try {
          if (action === 'cancel') {
            expect(await cancelAsAgent(service, run.id, wait.id)).toMatchObject({ wait: { id: wait.id, reason: 'cancelled' },
              instruction: `Wait ${wait.id} had already settled; cancelling freed the wait slot and its outcomes stay in this receipt. Register another wait in this turn.` });
          } else expect(await service.destroyForHuman('project', child.id)).toMatchObject({ state: 'complete', remaining: [] });
        } finally { unregister(); }
        expect(waitOf(store.getRun(run.id))).toBeUndefined();
        expect(store.getRun(run.id)?.delegation).toMatchObject({ lastWait: { id: wait.id,
          reason: action === 'cancel' ? 'cancelled' : 'outcome', outcomes: [{ workerId: child.id, status: 'done' }] } });
        expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id && !input.deliveredAt)).toEqual([]);
        expect(store.readEvents(run.id).filter(event => event.type === 'turn-end')).toHaveLength(0);
        // A new worker wait and then CI can both register before releasing the held turn.
        const next = manager.registerWorkerWait(run.id, workerWaitRequestSchema.parse({ workerIds: [child.id] }));
        manager.reconcileWorkerWaits();
        manager.cancelWorkerWait(run.id, next.id);
        await expect(callCiWait({ pr }, tools.env)).resolves.toMatchObject({ prUrl: pr });
      } finally { wire.release(); await controller.close(); }
    });
  }
  it.each(RUNNER_IDS)('%s R80 cancel-wait twice frees a live wait during the same native turn', async runner => {
    const wire = holdNativeTurn(runner);
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.hold!, runner });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    const service = new DelegationService();
    const unregister = service.registerProject({ id: 'project', root, store, manager });
    try {
      await until(wire.received);
      const child = await worker(run.id);
      const wait = manager.registerWorkerWait(run.id, workerWaitRequestSchema.parse({ workerIds: [child.id] }));
      expect(await cancelAsAgent(service, run.id, wait.id)).toMatchObject({ wait: { id: wait.id, phase: 'wake-pending', reason: 'cancelled' },
        instruction: `Wait ${wait.id} cancelled; it holds the wait slot until its cancellation is delivered. Run worker cancel-wait ${wait.id} again to free the slot and register another wait in this turn.` });
      expect(await cancelAsAgent(service, run.id, wait.id)).toMatchObject({ wait: { id: wait.id, reason: 'cancelled' },
        instruction: `Wait ${wait.id} had already settled; cancelling freed the wait slot and its outcomes stay in this receipt. Register another wait in this turn.` });
      expect(waitOf(store.getRun(run.id))).toBeUndefined();
      const next = manager.registerWorkerWait(run.id, workerWaitRequestSchema.parse({ workerIds: [child.id] }));
      expect(next).toMatchObject({ phase: 'registered' });
      expect(store.readEvents(run.id).filter(event => event.type === 'turn-end')).toHaveLength(0);
      // Settle the worker so it never starts once the parent frees its slot, then retire the new wait as R80 does.
      fixtureUpdateRun(child.id, { status: 'done' });
      manager.reconcileWorkerWaits();
      manager.cancelWorkerWait(run.id, next.id);
      expect(waitOf(store.getRun(run.id))).toBeUndefined();
    } finally { unregister(); wire.release(); }
  });

});

/** Cancel with the parent's own credential, as `cez worker cancel-wait` does, so the instruction is pinned (hearsay-tools/cezarion#1200). */
async function cancelAsAgent(service: DelegationService, runId: string, waitId: string) {
  vi.stubEnv('CEZ_DELEGATION', '1');
  const credentials = new CredentialRegistry();
  try { return await service.cancelWait(credentials.authenticate(credentials.issue('project', runId, randomUUID()))!, { waitId }); }
  finally { credentials.close(); vi.unstubAllEnvs(); }
}
