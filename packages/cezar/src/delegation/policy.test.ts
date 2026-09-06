import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerOperationSchema, type WorkerOperation } from '@open-mercato/cezar-contract';
import { runRecordSchema, type RunRecord } from '../runs/store.ts';
import { CredentialRegistry, type Caller } from './credentials.ts';
import { authorizeSpawn, authorizeSpawnReplay, authorizeWorker } from './policy.ts';

const projectId = 'project';
const parentId = randomUUID();
const workerId = randomUUID();
const otherId = randomUUID();
const now = '2026-09-06T12:00:00.000Z';
const operations = workerOperationSchema.options;
const targeted = ['inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'] as const;
const registries: CredentialRegistry[] = [];
afterEach(() => { for (const registry of registries.splice(0)) registry.close(); vi.unstubAllEnvs(); });

function caller(runId: string = parentId, project: string = projectId): Caller {
  const registry = new CredentialRegistry();
  registries.push(registry);
  return registry.authenticate(registry.issue(project, runId, 'session-1'))!;
}
function root(): RunRecord {
  return runRecordSchema.parse({
    id: parentId, title: 'parent', task: 'task', workflow: 'quick-task', status: 'running',
    createdAt: now, tokensUsed: 0, steps: [],
    delegation: { role: 'root', permissions: operations, receipts: [] },
  });
}
function worker(): RunRecord {
  return runRecordSchema.parse({ ...root(), id: workerId, delegation: {
    role: 'worker', parentRunId: parentId, permissions: [], workspace: {
      ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
      path: `/managed/${workerId}`, branch: 'cez/worker', baselineSha: 'a'.repeat(40),
    },
  } });
}
function authorize(operation: WorkerOperation, identity: Caller, parent: RunRecord | undefined, target: RunRecord | undefined = worker(), project = projectId): void {
  if (operation === 'spawn') authorizeSpawn(identity, parent, project);
  else authorizeWorker(identity, target, operation, parent, project);
}
function denied(action: () => void, code = 'denied_scope'): void {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

describe('parent-only delegation policy', () => {
  it.each(operations)('pending parent finish gates %s without blocking inspection or cleanup', operation => {
    const parent = root();
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    parent.delegation.finishRequestedAt = now;
    if (['spawn', 'steer', 'wait'].includes(operation)) {
      denied(() => authorize(operation, caller(), parent), 'incompatible_state');
    } else expect(() => authorize(operation, caller(), parent)).not.toThrow();
  });

  it.each(operations)('permits owner %s using the authenticated identity, not CEZ_TASK_ID', operation => {
    vi.stubEnv('CEZ_TASK_ID', otherId);
    expect(() => authorize(operation, caller(), root())).not.toThrow();
  });

  it.each(operations)('denies %s to an unrelated root even with a claimed parent record', operation => {
    vi.stubEnv('CEZ_TASK_ID', parentId);
    denied(() => authorize(operation, caller(otherId), root()));
  });

  it.each(operations)('denies %s to a worker even with elevated persisted permissions', operation => {
    const parent = worker();
    parent.delegation = { ...parent.delegation!, permissions: [...operations] } as RunRecord['delegation'];
    denied(() => authorize(operation, caller(workerId), parent));
  });

  it.each(operations)('denies %s on missing, invalid or malformed parent metadata', operation => {
    for (const delegation of [undefined, { role: 'invalid' }, { role: 'root', permissions: operations }, { role: 'root', permissions: ['merge'], receipts: [] }]) {
      const parent = { ...root(), delegation } as RunRecord;
      denied(() => authorize(operation, caller(), parent));
    }
    denied(() => authorize(operation, caller(), undefined));
  });

  it.each(operations)('denies %s across projects even with matching run IDs', operation => {
    denied(() => authorize(operation, caller(parentId, 'other-project'), root()));
    denied(() => authorize(operation, caller(), root(), worker(), 'other-project'));
  });

  it.each(operations)('requires the persisted %s permission', operation => {
    const parent = root();
    if (parent.delegation?.role !== 'root') throw new Error('fixture');
    parent.delegation.permissions = operations.filter(value => value !== operation);
    denied(() => authorize(operation, caller(), parent));
  });

  it.each(operations)('denies %s for queued or terminal parents but permits waiting', operation => {
    for (const status of ['queued', 'review', 'done', 'failed', 'cancelled'] as const) {
      denied(() => authorize(operation, caller(), { ...root(), status }), 'incompatible_state');
    }
    expect(() => authorize(operation, caller(), { ...root(), status: 'waiting' })).not.toThrow();
  });

  it.each(targeted)('scopes %s reads and mutations equally for absent/unrelated/invalid targets', operation => {
    const identity = caller();
    const unrelated = worker();
    if (unrelated.delegation?.role !== 'worker') throw new Error('fixture');
    unrelated.delegation.parentRunId = otherId;
    const wrongOwner = worker();
    if (wrongOwner.delegation?.role !== 'worker') throw new Error('fixture');
    wrongOwner.delegation.workspace.ownerRunId = otherId;
    const targets = [undefined, unrelated, wrongOwner, root(), { ...worker(), id: parentId },
      { ...worker(), delegation: undefined }, { ...worker(), delegation: { role: 'invalid' as const } },
      { ...worker(), delegation: { role: 'worker', parentRunId: parentId } } as RunRecord];
    const errors = targets.map(target => {
      try { authorizeWorker(identity, target, operation, root(), projectId); }
      catch (error) { return error; }
      throw new Error('Unauthorized target accepted');
    });
    for (const error of errors) expect(error).toMatchObject({ code: 'denied_scope', message: 'Worker scope denied' });
  });

  it('rejects spawn on the targeted-operation seam', () => {
    denied(() => authorizeWorker(caller(), worker(), 'spawn', root(), projectId));
  });

  it.each(operations)('rejects a fabricated, copied or revoked Caller for %s', operation => {
    const identity = caller();
    denied(() => authorize(operation, { projectId, runId: parentId, generation: 'session-1' } as Caller, root()));
    denied(() => authorize(operation, { ...identity }, root()));
    registries.at(-1)!.revoke(parentId);
    denied(() => authorize(operation, identity, root()));
  });

  it.each(targeted)('checks all destruction phases for %s without blocking idempotent cleanup or reads', operation => {
    for (const phase of ['requested', 'terminating', 'cleaning', 'complete', 'incomplete'] as const) {
      const target = worker();
      if (target.delegation?.role !== 'worker') throw new Error('fixture');
      target.delegation.destroy = { requestedAt: now, phase, remaining: [] };
      const action = () => authorizeWorker(caller(), target, operation, root(), projectId);
      if (operation === 'steer') denied(action, 'incompatible_state');
      else expect(action).not.toThrow();
    }
  });

  it('rejects terminal steering but permits queued/running/waiting input', () => {
    for (const status of ['review', 'done', 'failed', 'cancelled'] as const) {
      denied(() => authorizeWorker(caller(), { ...worker(), status }, 'steer', root(), projectId), 'incompatible_state');
    }
    for (const status of ['queued', 'running', 'waiting'] as const) {
      expect(() => authorizeWorker(caller(), { ...worker(), status }, 'steer', root(), projectId)).not.toThrow();
    }
  });

  it('replay authority never bypasses root identity, project, permission, metadata or lifecycle', () => {
    denied(() => authorizeSpawnReplay(caller(otherId), root(), projectId));
    denied(() => authorizeSpawnReplay(caller(), root(), 'other-project'));
    denied(() => authorizeSpawnReplay(caller(workerId), worker(), projectId));
    denied(() => authorizeSpawnReplay(caller(), undefined, projectId));
    denied(() => authorizeSpawnReplay(caller(), { ...root(), delegation: { role: 'invalid' } }, projectId));
    denied(() => authorizeSpawnReplay(caller(), { ...root(), delegation: undefined }, projectId));
    denied(() => authorizeSpawnReplay(caller(), { ...root(), delegation: { role: 'root', permissions: ['inspect'], receipts: [] } }, projectId));
    for (const status of ['queued', 'review', 'done', 'failed', 'cancelled'] as const) {
      denied(() => authorizeSpawnReplay(caller(), { ...root(), status }, projectId), 'incompatible_state');
    }
  });

  it('counts all persisted creation receipts, not live workers, across the lifetime cap', () => {
    const parent = root();
    if (parent.delegation?.role !== 'root') throw new Error('fixture');
    parent.delegation.receipts = Array.from({ length: 31 }, () => ({ requestId: randomUUID(), workerId: randomUUID(), requestHash: 'b'.repeat(64) }));
    expect(() => authorizeSpawn(caller(), parent, projectId)).not.toThrow();
    parent.delegation.receipts.push({ requestId: randomUUID(), workerId, requestHash: 'c'.repeat(64) });
    denied(() => authorizeSpawn(caller(), parent, projectId), 'capacity_limit');
    expect(() => authorizeSpawnReplay(caller(), parent, projectId)).not.toThrow();
    // The same persisted receipts still block a new creation after reload, even with no live rows.
    denied(() => authorizeSpawn(caller(), runRecordSchema.parse(JSON.parse(JSON.stringify(parent))), projectId), 'capacity_limit');
    expect(() => authorizeWorker(caller(), worker(), 'inspect', parent, projectId)).not.toThrow();
  });
});
