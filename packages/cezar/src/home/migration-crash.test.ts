import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import * as privateFiles from './private-files.ts';
import { migrateLegacyHome, type MigrationStep } from './migrate.ts';
import { readInstallMarker } from './install-marker.ts';
import { migrationFixture, rawJson, json } from './migration.testkit.ts';
import { cleanStoreRoots, childEnv } from './store.testkit.ts';
import { getHomeRecovery } from './recovery.ts';
import { HomeStore } from './store.ts';
import { runCrashMigration } from './migration-process.fixture.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });
const fixture = fileURLToPath(new URL('./migration-process.fixture.testkit.ts', import.meta.url));
const steps: MigrationStep[] = ['recovered', 'claimed', 'pending', 'archived', 'copied', 'recheck', 'accounts', 'committed'];

it('a crash between committed marker and MOVED publication keeps the committed target authoritative', () => {
  const { legacy, target } = migrationFixture();
  const replace = privateFiles.replacePrivate;
  vi.spyOn(privateFiles, 'replacePrivate').mockImplementation((path, bytes, options) => {
    if (path === join(legacy.root, 'MOVED.json')) throw new Error('MOVED publication crash');
    replace(path, bytes, options);
  });
  expect(() => migrateLegacyHome(legacy, target)).toThrow('MOVED publication crash');
  expect(readInstallMarker(target.config)?.state).toBe('committed');
  rawJson(legacy.workspaceConfig, { saved: 'late old writer' });
  vi.restoreAllMocks();
  expect(migrateLegacyHome(legacy, target).status).toBe('unchanged');
  expect(existsSync(join(legacy.root, 'MOVED.json'))).toBe(true);
  expect(json(target.workspaceConfig).saved).toBe('original');
});

it('a thrown fault releases .migrating and a later run overwrites its pending copy', () => {
  const { legacy, target } = migrationFixture();
  expect(() => runCrashMigration(legacy.root, dirname(target.config), 'copied', () => { throw new Error('injected'); })).toThrow('injected');
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
  expect(migrateLegacyHome(legacy, target).status).toBe('migrated');
});

it('an operator migration from a legacy test marker creates a live target marker and a test process still cannot write it', () => {
  const { legacy, target } = migrationFixture();
  // The legacy kind never carries over: a wrongly stamped legacy home still migrates to a live target.
  expect(readInstallMarker(legacy.root)?.kind).toBe('test');
  rmSync(join(target.config, 'install.json'));
  const result = spawnSync(process.execPath, ['--import', 'tsx', fixture, legacy.root, dirname(target.config), 'complete'], { env: childEnv(), encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(readInstallMarker(target.config)).toMatchObject({ kind: 'live', state: 'committed' });
  expect(() => new HomeStore(target).writeJson(target.workspaceConfig, {})).toThrow(/refusing to write live home/);
});

it.each(steps)('a process crash at %s leaves legacy bytes untouched and the next migration completes', step => {
  const { legacy, target } = migrationFixture();
  const bytes = readFileSync(legacy.workspaceConfig);
  const crash = spawnSync(process.execPath, ['--import', 'tsx', fixture, legacy.root, dirname(target.config), step], { env: childEnv(), encoding: 'utf8' });
  expect(crash.status, crash.stderr).toBe(74);
  expect(readFileSync(legacy.workspaceConfig)).toEqual(bytes);
  if (readInstallMarker(target.config)?.state === 'pending') rawJson(target.workspaceConfig, { crashedPendingCopy: true });
  const result = migrateLegacyHome(legacy, target);
  expect(['migrated', 'unchanged']).toContain(result.status);
  expect(readInstallMarker(target.config)?.state).toBe('committed');
  expect(json(target.workspaceConfig).saved).toBe('original');
  expect(json(target.workspaceConfig).crashedPendingCopy).toBeUndefined();
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});
