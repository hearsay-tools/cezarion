import { expect, it } from 'vitest';
import { z } from 'zod';
import { filterHomeRecoveryReasons, homeFileSchema, homeRecoveryActionSchema, homeRecoveryReaderSchema, homeRecoverySchema } from './home-recovery.ts';

it('admits every HomeStore file family and no caller-selected path', () => {
  const files = ['config.json', 'config.json.bak', 'agent-accounts.json', 'ui-state.json', 'server.json',
    'server.install.lock', 'remote-settings/4321.json', 'server-instances/shop.json',
    'server-instances/shop.install.lock', 'remote-settings/4321.install.lock'];
  for (const file of files) expect(homeFileSchema.parse(file)).toBe(file);
  for (const file of ['../config.json', '/config.json', 'remote-settings/../config.json',
    'server-instances/a/b.json', 'config.json/HEAD', 'install.json', 'server-instances/a\\b.json']) {
    expect(homeFileSchema.safeParse(file).success).toBe(false);
  }
  expect(homeRecoveryActionSchema.safeParse({ file: 'config.json', path: '/elsewhere' }).success).toBe(false);
});

it('describes recovery metadata without exposing saved file content', () => {
  expect(homeRecoverySchema.parse({ files: [] })).toEqual({ files: [] });
  const file = { file: 'config.json', reason: 'outside-write', detectedAt: '2026-11-07T09:00:00.000Z', canRestore: true };
  expect(homeRecoverySchema.parse({ files: [file] })).toEqual({ files: [file] });
  expect(homeRecoverySchema.safeParse({ files: [{ ...file, reason: 'changed' }] }).success).toBe(false);
  expect(homeRecoverySchema.safeParse({ files: [{ ...file, detectedAt: 'yesterday' }] }).success).toBe(false);
});

it('requires the incident time on recovery actions so stale requests cannot resolve a newer incident', () => {
  expect(homeRecoveryActionSchema.safeParse({ file: 'config.json' }).success).toBe(false);
  const action = { file: 'config.json', detectedAt: '2026-11-07T09:00:00.000Z' };
  expect(homeRecoveryActionSchema.parse(action)).toEqual(action);
  expect(homeRecoveryActionSchema.safeParse({ ...action, detectedAt: 'yesterday' }).success).toBe(false);
});

it('lets a tolerant v1 reader ignore legacy-change and keep its known rows', () => {
  const known = { file: 'config.json', reason: 'reset', detectedAt: '2026-11-07T09:00:00.000Z', canRestore: true };
  const legacy = { ...known, reason: 'legacy-change', canRestore: false, canImport: true };
  const v1 = z.preprocess(value => filterHomeRecoveryReasons(value, ['reset', 'outside-write']), z.object({
    files: z.array(z.object({ file: homeFileSchema, reason: z.enum(['reset', 'outside-write']), detectedAt: z.iso.datetime(), canRestore: z.boolean() })),
  }));
  expect(homeRecoverySchema.parse({ files: [known, legacy] }).files).toHaveLength(2);
  expect(v1.parse({ files: [legacy, known] })).toEqual({ files: [known] });
  expect(homeRecoveryReaderSchema.parse({ files: [known, { ...legacy, reason: 'future-reason' }] })).toEqual({ files: [known] });
  expect(homeRecoveryReaderSchema.safeParse({ files: [{ ...known, detectedAt: 'invalid' }] }).success).toBe(false);
  expect(homeRecoveryReaderSchema.safeParse({ files: [{ ...known, reason: 4 }] }).success).toBe(false);
});
