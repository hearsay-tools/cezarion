import { expect, it } from 'vitest';
import { homeFileSchema, homeRecoveryActionSchema, homeRecoverySchema } from './home-recovery.ts';

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
