import { expect, it } from 'vitest';
import { aliasRetentionAdapter } from './linux-alias-retention.ts';
import { assessAliasEvidence } from './linux-alias-discovery.ts';
import { AliasWorkBudget, aliasCandidates, indexAliasMounts } from './linux-alias-model.ts';
import type { AliasScanAttempt } from './linux-alias-scan.ts';
import type { WorkerAliasRetention, WorkerExecution } from '../runs/worker-execution.ts';
import { serializeWorkerExecution } from '../runs/worker-execution.ts';

const generation = 'b12898b9-8bf7-4c24-85e3-5ecf2b4d469e';
const resource = 'ff04f7e5-25b8-4f57-9050-895fe33fc6e6';
const boot = 'deffb118-419a-4586-af9e-748667bd30c8';
const attempt: AliasScanAttempt = { roots: ['/owned'], rootIdentities: ['2049:123'], owned: [],
  selfMounts: '', selfNamespace: '', budget: new AliasWorkBudget() };

it('keeps a marker across detach and reopen when indexed gathering exhausts', () => {
  const proof: WorkerExecution = { generation, phase: 'complete' };
  let saved: WorkerAliasRetention | undefined;
  const adapter = aliasRetentionAdapter(proof, resource, boot, attempt, value => { saved = value; }, () => {});
  const mounts = Array.from({ length: 100 }, () => ({ dev: '8:1', root: '/owned', point: '/alias' }));
  const index = indexAliasMounts(mounts, new AliasWorkBudget());
  expect(() => aliasCandidates('/alias/file', '/', '08:01', mounts, [{ path: '/owned', dev: '8:1', fsPath: '/owned' }],
    new AliasWorkBudget(50), index, () => { adapter.begin(123, boot + ':100'); })).toThrow('work exceeds');
  expect(saved?.pending).toEqual([{ pid: 123, start: '100' }]);
  expect(saved?.processes).toEqual([]);
  const reopened = aliasRetentionAdapter({ ...proof, aliasRetention: saved! }, resource, boot, attempt, value => { saved = value; }, () => {});
  expect(reopened.reconcile(() => boot + ':100', () => false)).toBe(true);
  expect(saved?.pending).toEqual([{ pid: 123, start: '100' }]);
});

it('restores committed identity after restart and retains a detached mapping', () => {
  let saved: WorkerAliasRetention | undefined;
  const proof: WorkerExecution = { generation, phase: 'complete' };
  const first = aliasRetentionAdapter(proof, resource, boot, attempt, value => { saved = value; }, () => {});
  const held = { outcome: 'held' as const, mappings: [{ path: '/owned/file', dev: '8:1', ino: 42n }], links: [] };
  expect(assessAliasEvidence(123, boot + ':100', held, first.scope, new AliasWorkBudget(), first.publish)).toBe(true);
  expect(saved?.processes[0]?.identities).toEqual([{ dev: '8:1', ino: '42' }]);
  const restarted = aliasRetentionAdapter({ ...proof, aliasRetention: saved! }, resource, boot, attempt, value => { saved = value; }, () => {});
  const detached = { outcome: 'clear' as const, mappings: [], links: [], maps: '1-2 r--p 0 08:01 42 /detached/file\n', observedLinks: [] };
  expect(() => assessAliasEvidence(123, boot + ':100', detached, restarted.scope, new AliasWorkBudget(), restarted.publish)).toThrow('released');
  expect(saved).toBeDefined();
  expect(assessAliasEvidence(123, boot + ':100', { ...detached, maps: '' }, restarted.scope, new AliasWorkBudget(), restarted.publish)).toBe(false);
  expect(saved).toBeUndefined();
});

it('refuses fallback tokens, changed identity and unavailable checkpoints', () => {
  let saved: WorkerAliasRetention | undefined;
  const proof: WorkerExecution = { generation, phase: 'complete' };
  const adapter = aliasRetentionAdapter(proof, resource, boot, attempt, value => { saved = value; }, () => {});
  adapter.scope.remember(123, '100', [{ dev: '8:1', ino: 42n }]);
  expect(() => adapter.publish(adapter.scope.snapshot())).toThrow('Unscoped');
  expect(saved).toBeUndefined();
  expect(() => aliasRetentionAdapter(undefined, resource, boot, attempt, () => {}, () => {})).toThrow('unavailable');
  adapter.scope.remember(123, boot + ':100', [{ dev: '8:1', ino: 42n }]);
  adapter.publish(adapter.scope.snapshot());
  expect(() => aliasRetentionAdapter({ ...proof, aliasRetention: saved! }, resource, boot,
    { ...attempt, rootIdentities: ['2049:124'] }, () => {}, () => {})).toThrow('identity changed');
});

it('clears old boot incarnations only after verification and a successful write', () => {
  let saved: WorkerAliasRetention | undefined;
  const proof: WorkerExecution = { generation, phase: 'complete' };
  const first = aliasRetentionAdapter(proof, resource, boot, attempt, value => { saved = value; }, () => {});
  first.scope.remember(123, boot + ':100', [{ dev: '8:1', ino: 42n }]);
  first.publish(first.scope.snapshot());
  const nextBoot = '42cfc8e5-58ce-4589-9d8b-5604238e4a3b';
  let verified = false;
  expect(() => aliasRetentionAdapter({ ...proof, aliasRetention: saved! }, resource, nextBoot, attempt,
    () => { throw new Error('disk'); }, () => { verified = true; })).toThrow('disk');
  expect(verified).toBe(true); expect(saved).toBeDefined();
  aliasRetentionAdapter({ ...proof, aliasRetention: saved! }, resource, nextBoot, attempt, value => { saved = value; }, () => {});
  expect(saved).toBeUndefined();
});

it('keeps an interrupted scan across reopen until the incarnation exits or changes', () => {
  const proof: WorkerExecution = { generation, phase: 'complete' };
  let saved: WorkerAliasRetention | undefined;
  const first = aliasRetentionAdapter(proof, resource, boot, attempt, value => { saved = value; }, () => {});
  expect(first.begin(123, boot + ':100')).toBe(true);
  const reopened = aliasRetentionAdapter({ ...proof, aliasRetention: saved! }, resource, boot, attempt, value => { saved = value; }, () => {});
  expect(reopened.begin(123, boot + ':100')).toBe(false);
  expect(reopened.reconcile(() => boot + ':100', () => false)).toBe(true);
  expect(saved?.pending).toEqual([{ pid: 123, start: '100' }]);
  expect(reopened.reconcile(() => boot + ':101', () => false)).toBe(false);
  expect(saved).toBeUndefined();
});

it('clears a verified same-token zombie and retains uncertain or changed observations', () => {
  const proof: WorkerExecution = { generation, phase: 'complete' };
  let saved: WorkerAliasRetention | undefined;
  const adapter = aliasRetentionAdapter(proof, resource, boot, attempt, value => { saved = value; }, () => {});
  adapter.begin(123, boot + ':100');
  expect(adapter.reconcile(() => undefined, () => false)).toBe(true);
  let reads = 0;
  expect(adapter.reconcile(() => ++reads === 1 ? boot + ':100' : undefined, () => true)).toBe(true);
  expect(() => adapter.reconcile(() => 'fallback:100', () => true)).toThrow('Unscoped');
  expect(saved?.pending).toHaveLength(1);
  expect(adapter.reconcile(() => boot + ':100', () => true)).toBe(false);
  expect(saved).toBeUndefined();
});

it('refuses a 65th distinct pending incarnation before publication', () => {
  const proof: WorkerExecution = { generation, phase: 'complete' };
  let saved: WorkerAliasRetention | undefined;
  const adapter = aliasRetentionAdapter(proof, resource, boot, attempt, value => { saved = value; }, () => {});
  for (let pid = 1; pid <= 64; pid++) adapter.scope.remember(pid, boot + ':100', [{ dev: '8:1', ino: BigInt(pid) }]);
  adapter.publish(adapter.scope.snapshot());
  expect(adapter.begin(1, boot + ':100')).toBe(true);
  const before = JSON.stringify(saved);
  expect(() => adapter.begin(65, boot + ':100')).toThrow();
  expect(JSON.stringify(saved)).toBe(before);
});

it('persists the marker before overflow or write failure can lose evidence', () => {
  const proof: WorkerExecution = { generation, phase: 'complete' };
  let saved: WorkerAliasRetention | undefined;
  const adapter = aliasRetentionAdapter(proof, resource, boot, attempt, value => { saved = value; }, () => {});
  adapter.begin(123, boot + ':100');
  adapter.scope.remember(123, boot + ':100', Array.from({ length: 64 }, (_, i) => ({ dev: '8:1', ino: BigInt(i + 1) })));
  adapter.publish(adapter.scope.snapshot());
  adapter.scope.remember(123, boot + ':100', [{ dev: '8:1', ino: 65n }]);
  expect(() => adapter.publish(adapter.scope.snapshot())).toThrow();
  expect(saved?.pending).toEqual([{ pid: 123, start: '100' }]);
  expect(saved?.processes[0]?.identities).toHaveLength(64);
  const reopened = aliasRetentionAdapter({ ...proof, aliasRetention: saved! }, resource, boot, attempt, value => { saved = value; }, () => {});
  expect(reopened.reconcile(() => boot + ':100', () => false)).toBe(true);
  expect(saved?.pending).toEqual([{ pid: 123, start: '100' }]);
  const fail = aliasRetentionAdapter(proof, resource, boot, attempt, () => { throw new Error('disk'); }, () => {});
  expect(() => fail.begin(123, boot + ':100')).toThrow('disk');
});

it('refuses the first marker when the existing checkpoint has no byte capacity', () => {
  const roots = Array.from({ length: 5 }, (_, i) => '/' + String(i) + 'x'.repeat(3998));
  const oversized = { ...attempt, roots, rootIdentities: roots.map(() => '2049:123') };
  const proof: WorkerExecution = { generation, phase: 'complete' };
  let committed = serializeWorkerExecution(proof);
  const adapter = aliasRetentionAdapter(proof, resource, boot, oversized, value => {
    committed = serializeWorkerExecution({ ...proof, aliasRetention: value });
  }, () => {});
  expect(() => adapter.begin(123, boot + ':100')).toThrow('exceeds bounds');
  expect(JSON.parse(committed)).toEqual(proof);
});

it('keeps a committed marker when publishing a match or clearing the marker fails', () => {
  const proof: WorkerExecution = { generation, phase: 'complete' };
  let saved: WorkerAliasRetention | undefined;
  let fail = false;
  const write = (value: WorkerAliasRetention | undefined) => { if (fail) throw new Error('disk'); saved = value; };
  const first = aliasRetentionAdapter(proof, resource, boot, attempt, write, () => {});
  first.begin(123, boot + ':100');
  first.scope.remember(123, boot + ':100', [{ dev: '8:1', ino: 42n }]);
  fail = true;
  expect(() => first.publish(first.scope.snapshot())).toThrow('disk');
  expect(() => first.finish(123, boot + ':100')).toThrow('disk');
  expect(saved?.pending).toEqual([{ pid: 123, start: '100' }]);
  fail = false;
  const reopened = aliasRetentionAdapter({ ...proof, aliasRetention: saved! }, resource, boot, attempt, write, () => {});
  expect(reopened.reconcile(() => boot + ':100', () => false)).toBe(true);
  expect(reopened.reconcile(() => undefined, () => true)).toBe(false);
  expect(saved).toBeUndefined();
});
