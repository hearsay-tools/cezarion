import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { DelegationService } from '../delegation/service.ts';
import { executions, manager, root, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

// Each fixture starts the runner's native mock before holding its continuation.
describe.runIf(process.platform === 'linux')('destroy during continuation startup', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it.each(RUNNER_IDS.flatMap(runner => [runner, runner].map((id, index) => [id, index === 0 ? 'resolves' : 'rejects'] as const)))('%s R127 cancels when held continuation workspace %s after preflight fails', async (runner, outcome) => {
    process.env.CEZ_DELEGATION = '1'; process.env.CEZ_DRY_RUN = '0';
    const adapter = HARNESS_ADAPTERS[runner]; process.env[adapter.binEnv] = adapter.mockBin;
    const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(p.id, { status: 'waiting', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const w = await worker(p.id, adapter.scenarios.done!, runner);
    manager.enqueueOwnedRun(w.id);
    await until(() => ['done', 'review'].includes(store.getRun(w.id)?.status ?? '') && store.readWorkerExecution(w.id)?.phase === 'complete');
    if (w.delegation?.role !== 'worker') throw Error('missing workspace');
    const workspace = w.delegation.workspace;
    const scratch = agentTmpDir(join(root, '.ai/cezar'), w.id);
    fs.mkdirSync(scratch, { recursive: true }); fs.writeFileSync(join(scratch, 'keep'), 'marker');
    const engine = manager as unknown as { continuationWorkspace: (...args: unknown[]) => Promise<unknown> };
    const actual = engine.continuationWorkspace.bind(manager);
    let release!: () => void; let entered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    engine.continuationWorkspace = async (...args) => { entered = true; await held; if (outcome === 'rejects') throw Error('fixture workspace rejection'); return actual(...args); };
    const priorEvents = store.readEvents(w.id).length;
    const service = new DelegationService(); const detach = service.registerProject({ id: 'start', root, store, manager });
    const read = fs.readFileSync;
    try {
      expect(manager.continueRun(w.id, { text: 'continue' })).toMatchObject({ ok: true });
      await until(() => entered);
      vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => String(args[0]) === '/proc/self/mountinfo' ? '' : Reflect.apply(read, fs, args)) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      const result = await service.destroyForHuman('start', w.id);
      expect(result).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'] });
      expect(fs.existsSync(workspace.path)).toBe(true);
      expect(fs.readFileSync(join(scratch, 'keep'), 'utf8')).toBe('marker');
      expect(execFileSync('git', ['branch', '--list', workspace.branch], { cwd: root, encoding: 'utf8' })).toContain(workspace.branch);
      if (outcome === 'rejects') { const last = executions.length - 1; executions[last] = executions[last]!.catch(() => undefined); }
      release();
      await until(() => store.readWorkerExecution(w.id)?.phase === 'complete');
      expect(store.getRun(w.id)?.status).toBe('cancelled');
      expect(store.readEvents(w.id).slice(priorEvents).some(event => event.type === 'session')).toBe(false);
    } finally { release(); detach(); vi.restoreAllMocks(); syncBuiltinESMExports(); }
  });
  it('keeps an unexpected continuation workspace rejection as a failure', async () => {
    process.env.CEZ_DELEGATION = '1'; process.env.CEZ_DRY_RUN = '0';
    const adapter = HARNESS_ADAPTERS.claude; process.env[adapter.binEnv] = adapter.mockBin;
    const p = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(p.id, { status: 'waiting', delegation: { role: 'root', permissions: ['spawn', 'inspect'], receipts: [] } });
    const w = await worker(p.id, adapter.scenarios.done!); manager.enqueueOwnedRun(w.id);
    await until(() => ['done', 'review'].includes(store.getRun(w.id)?.status ?? '') && store.readWorkerExecution(w.id)?.phase === 'complete');
    const engine = manager as unknown as { continuationWorkspace: (...args: unknown[]) => Promise<unknown> };
    engine.continuationWorkspace = async () => { throw Error('unexpected fixture workspace failure'); };
    expect(manager.continueRun(w.id, { text: 'continue' })).toMatchObject({ ok: true });
    const last = executions.length - 1; executions[last] = executions[last]!.catch(() => undefined);
    await until(() => store.readWorkerExecution(w.id)?.phase === 'complete');
    expect(store.getRun(w.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('unexpected fixture workspace failure') });
  });

});
