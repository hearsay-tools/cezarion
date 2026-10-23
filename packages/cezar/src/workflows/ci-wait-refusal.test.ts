import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerWaitRequestSchema } from '@open-mercato/cezar-contract/delegation';
import { RUNNER_IDS, type AgentSession, type RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { repointMockImports } from '../core/mock-patch.testkit.ts';
import { DelegationService } from '../delegation/service.ts';
import { CiToolController } from '../ci-wait/controller.ts';
import { callCezarWait } from '../ci-wait/client.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { manager, store, root, worker, fixtureUpdateRun, lastWaitOf, until, waitOf, useWorkerWaitFixture } from './worker-wait.testkit.ts';
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
  source = repointMockImports(adapter.mockBin, source);
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
const ciWaitOf = (id: string) => store.getRun(id)?.waits?.find(entry => entry.kind === 'pr');

// hearsay-tools/cezarion#1235 phase 3a: worker waits are entries in the wait list beside CI, so the
// R27 refusal (#713: no CI wait while a worker wait is pending or owed) is gone. These cells pin
// the replacement on every runner's native wire: CI registers beside a pending and a settled
// worker wait, and the worker result is still delivered once.
describe('R27 CI registration beside worker waits — #713, hearsay-tools/cezarion#1235', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it.each(RUNNER_IDS)('%s registers CI beside a pending and a settled worker wait, and delivers the worker result once', async runner => {
    const wire = holdNativeTurn(runner);
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
    const controller = await CiToolController.start();
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.hold!, runner });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    try {
      await until(wire.received);
      const state = (manager as unknown as { active: Map<string, { ciGeneration: string; session: AgentSession }> }).active.get(run.id)!;
      const tools = controller.provision(manager.cezarToolHandlers(run.id, state.ciGeneration));
      const child = await worker(run.id);
      const wait = manager.registerWorkerWait(run.id, workerWaitRequestSchema.parse({ workerIds: [child.id] }));
      await expect(callCezarWait({ kind: 'pr', pr }, tools.env)).resolves.toMatchObject({ ok: true, kind: 'pr' });
      const ci = ciWaitOf(run.id);
      expect(ci).toMatchObject({ phase: 'open' });
      fixtureUpdateRun(child.id, { status: 'done' });
      manager.reconcileWorkerWaits();
      await until(() => waitOf(store.getRun(run.id))?.phase === 'wake-pending');
      const queued = () => store.getRun(run.id)?.agentInputs?.find(input => input.id === wait.id);
      expect(queued()?.deliveredAt).toBeUndefined();
      expect(store.readEvents(run.id).filter(e => e.type === 'turn-end')).toHaveLength(0);
      // The same CI registration is answered again while the worker result is owed.
      await expect(callCezarWait({ kind: 'pr', pr }, tools.env)).resolves.toMatchObject({ ok: true, kind: 'pr' });
      expect(ciWaitOf(run.id)?.id).toBe(ci!.id);
      wire.release();
      await until(() => !!queued()?.deliveredAt && !waitOf(store.getRun(run.id)));
      expect(ciWaitOf(run.id)).toMatchObject({ id: ci!.id, phase: 'open' });
      expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    } finally { wire.release(); await controller.close(); }
  });
  for (const action of ['cancel', 'destroy'] as const) {
    it.each(RUNNER_IDS)(`%s R80 ${action} of a settled wait during the same native turn leaves CI registration open`, async runner => {
      const wire = holdNativeTurn(runner);
      vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
      vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
      const controller = await CiToolController.start();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.hold!, runner });
      store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
      try {
        await until(wire.received);
        const state = (manager as unknown as { active: Map<string, { ciGeneration: string }> }).active.get(run.id)!;
        const tools = controller.provision(manager.cezarToolHandlers(run.id, state.ciGeneration));
        const child = await worker(run.id);
        const wait = manager.registerWorkerWait(run.id, workerWaitRequestSchema.parse({ workerIds: [child.id] }));
        fixtureUpdateRun(child.id, { status: 'done' });
        manager.reconcileWorkerWaits();
        expect(waitOf(store.getRun(run.id))?.phase).toBe('wake-pending');
        if (action === 'cancel') {
          // hearsay-tools/cezarion#1235: a resolved wait is past cancelling. The cancel answers its
          // `wake-pending` receipt and the result stays owed to the turn's end.
          expect(manager.cancelWorkerWait(run.id, wait.id)).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'outcome' });
          expect(waitOf(store.getRun(run.id))).toMatchObject({ id: wait.id, phase: 'wake-pending' });
          expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id && !input.deliveredAt)).toHaveLength(1);
        } else {
          const service = new DelegationService();
          const unregister = service.registerProject({ id: 'project', root, store, manager });
          try {
            expect(await service.destroyForHuman('project', child.id)).toMatchObject({ state: 'complete', remaining: [] });
          } finally { unregister(); }
          expect(waitOf(store.getRun(run.id))).toBeUndefined();
          // hearsay-tools/cezarion#1235: the receipt is in `lastWaits`, and a destroy during the live
          // turn cancels the wait it settled: nothing is left to await or deliver.
          expect(lastWaitOf(store.getRun(run.id))).toMatchObject({ id: wait.id, reason: 'cancelled',
            outcomes: [{ workerId: child.id, status: 'done' }] });
          expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id && !input.deliveredAt)).toEqual([]);
        }
        expect(store.readEvents(run.id).filter(event => event.type === 'turn-end')).toHaveLength(0);
        // A new worker wait and then CI can both register before releasing the held turn.
        const next = manager.registerWorkerWait(run.id, workerWaitRequestSchema.parse({ workerIds: [child.id] }));
        manager.reconcileWorkerWaits();
        manager.cancelWorkerWait(run.id, next.id);
        await expect(callCezarWait({ kind: 'pr', pr }, tools.env)).resolves.toMatchObject({ ok: true, kind: 'pr' });
      } finally { wire.release(); await controller.close(); }
    });
  }

});
