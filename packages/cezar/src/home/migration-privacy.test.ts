import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { copyPrivateTree, writeLegacyArchive } from './migration-files.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';
import { migrationFixture } from './migration.testkit.ts';
import { migrateLegacyHome } from './migrate.ts';

vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn(() => Buffer.alloc(0)),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); cleanStoreRoots(); });

it('migration copies and archives request the split Windows private ACL while the release switch is off', () => {
  const source = storeRoot(), target = join(storeRoot(), 'copy'), archive = join(storeRoot(), 'backups/archive.tar.gz');
  const home = migrationFixture();
  writeFileSync(join(source, 'auth.json'), '{"secret":"credential"}');
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  copyPrivateTree(source, target);
  writeLegacyArchive(source, archive, ['auth.json']);
  expect(migrateLegacyHome(home.legacy, home.target).status).toBe('migrated');
  const aclCalls = vi.mocked(execFileSync).mock.calls.filter(([command]) => command === 'powershell.exe');
  expect(aclCalls.length).toBeGreaterThanOrEqual(2);
  expect(aclCalls.every(([, args]) => String(args).includes('SetAccessRuleProtection($true, $false)'))).toBe(true);
  expect(aclCalls.some(([, args]) => String(args).includes(target))).toBe(true);
  expect(aclCalls.some(([, args]) => String(args).includes(join(archive, '..')))).toBe(true);
  expect(aclCalls.some(([, args]) => String(args).includes(home.target.config))).toBe(true);
  expect(aclCalls.some(([, args]) => String(args).includes(home.target.state))).toBe(true);
  expect(readFileSync(join(target, 'auth.json'), 'utf8')).toBe('{"secret":"credential"}');
  expect(statSync(archive).size).toBeGreaterThan(0);
});
