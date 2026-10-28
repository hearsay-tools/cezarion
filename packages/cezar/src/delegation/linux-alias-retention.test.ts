import { expect, it } from 'vitest';
import { aliasRetentionAdapter } from './linux-alias-retention.ts';
import { assessAliasEvidence } from './linux-alias-discovery.ts';
import { AliasWorkBudget } from './linux-alias-model.ts';
import type { AliasScanAttempt } from './linux-alias-scan.ts';
import type { WorkerAliasRetention, WorkerExecution } from '../runs/worker-execution.ts';

const generation = 'b12898b9-8bf7-4c24-85e3-5ecf2b4d469e';
const resource = 'ff04f7e5-25b8-4f57-9050-895fe33fc6e6';
const boot = 'deffb118-419a-4586-af9e-748667bd30c8';
const attempt: AliasScanAttempt = { roots: ['/owned'], rootIdentities: ['2049:123'], owned: [],
  selfMounts: '', selfNamespace: '', budget: new AliasWorkBudget() };

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
