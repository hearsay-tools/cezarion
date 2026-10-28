import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { fixture } from '../delegation/service.testkit.ts';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import type { WorkerAliasRetention } from './worker-execution.ts';
import { holdersStillHold } from '../delegation/destroy-observation.ts';
import { RunStore } from './store.ts';

it('retains private alias evidence through completion and refuses resource reuse', async () => {
  scopeFixtureProcesses(); vi.stubEnv('CEZ_DELEGATION', '1');
  const f = fixture();
  try {
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
    const run = f.store.getRun(workerId)!;
    if (run.delegation?.role !== 'worker') throw new Error('not a worker');
    const generation = f.store.readWorkerExecution(workerId)!.generation;
    const path = join(f.root, '.ai/cezar/runs', workerId + '.execution.json');
    // Simulate a starting execution without launching any process.
    writeFileSync(path, JSON.stringify({ generation, phase: 'starting' }));
    f.store.updateRun(workerId, { status: 'cancelled' });
    f.store.commitDelegation([{ id: workerId, delegation: { ...run.delegation,
      destroy: { requestedAt: new Date().toISOString(), phase: 'incomplete', remaining: ['worktree'] } } as never }]);
    const resourceId = run.delegation.workspace.resourceId;
    const retention: WorkerAliasRetention = { generation, resourceId, bootId: randomUUID(),
      roots: [{ path: run.delegation.workspace.path, identity: { dev: '8:1', ino: '123' } }],
      processes: [{ pid: 42, start: '123', identities: [{ dev: '8:1', ino: '456' }] }] };
    f.store.commitWorkerAliasRetention(workerId, generation, resourceId, retention);
    expect(f.store.readWorkerExecution(workerId)?.aliasRetention).toEqual(retention);
    expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).aliasRetention).toEqual(retention);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    try { expect(reopened.readWorkerExecution(workerId)?.aliasRetention).toEqual(retention); }
    finally { reopened.close(); }
    expect(f.store.workerResourcesSafe(workerId, generation, resourceId)).toBe(false);
    expect(f.store.workerScratchResourcesSafe(workerId, generation, resourceId)).toBe(false);
    expect(holdersStillHold({ store: f.store, dataDir: join(f.root, '.ai/cezar'), workerId, holders: [] })).toBe(false);
    expect(() => f.store.commitWorkerAliasRetention(workerId, randomUUID(), resourceId, undefined)).toThrow();
    expect(f.store.readWorkerExecution(workerId)?.aliasRetention).toEqual(retention);
    const oversized = { ...retention, roots: Array.from({ length: 16 }, (_, index) => ({ path: '/' + index + 'x'.repeat(4000), identity: null })) };
    expect(() => f.store.commitWorkerAliasRetention(workerId, generation, resourceId, oversized)).toThrow('exceeds bounds');
    expect(f.store.readWorkerExecution(workerId)?.aliasRetention).toEqual(retention);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, '{malformed');
    expect(() => f.store.commitWorkerAliasRetention(workerId, generation, resourceId, undefined)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{malformed');
    writeFileSync(path, original);
    const backup = path + '.fixture-backup';
    renameSync(path, backup); symlinkSync(backup, path);
    try {
      expect(() => f.store.commitWorkerAliasRetention(workerId, generation, resourceId, undefined)).toThrow();
      expect(readFileSync(backup, 'utf8')).toBe(original);
    } finally { rmSync(path); renameSync(backup, path); }
  } finally { await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
