import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareOperatorHome } from './entry.ts';
import { Home } from './home.ts';
import { readInstallMarker } from './install-marker.ts';
import * as migration from './migrate.ts';
import { prepareMigrationHome } from './migration-boot.ts';
import { json, migrationFixture } from './migration.testkit.ts';
import { cleanStoreRoots } from './store.testkit.ts';

const restoreModes: Array<() => void> = [];
afterEach(() => {
  for (const restore of restoreModes.splice(0)) restore();
  vi.restoreAllMocks();
  cleanStoreRoots();
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

describe('a committed custom home launched with only HSQ_HOME', () => {
  it('keeps the recorded source instead of the default legacy home the env now names', () => {
    const f = migrationFixture();
    expect(migration.migrateLegacyHome(f.legacy, f.target).status).toBe('migrated');
    // A launch that drops CEZ_HOME resolves the default legacy home, not the recorded source.
    const envLegacy = Home.sandbox(join(f.directory, 'default-legacy'), { layout: 'legacy' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(prepareMigrationHome(f.target, f.env, { legacy: envLegacy })).toEqual({ kind: 'ready' });
    expect(prepareOperatorHome(f.target, 'serve', f.env, { legacy: envLegacy })).toBe(f.target);

    expect(readInstallMarker(f.target.config)).toMatchObject({ state: 'committed', migratedFrom: f.legacy.root });
    expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(true);
    expect(existsSync(join(envLegacy.root, 'MOVED.json'))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a first boot that cannot write a home', () => {
  it.each(['EROFS', 'EACCES', 'EPERM'])('serves the legacy home on %s before the commit', code => {
    const f = migrationFixture();
    vi.spyOn(migration, 'migrateLegacyHome').mockImplementation(() => { throw errno(code); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(prepareOperatorHome(f.target, 'serve', f.env, { legacy: f.legacy })).toBe(f.legacy);
    expect(json(f.legacy.workspaceConfig).saved).toBe('original');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`serving ${f.legacy.root} until both homes are writable`));
  });

  it('serves the migrated home when only a step after the commit fails', () => {
    const f = migrationFixture();
    migration.migrateLegacyHome(f.legacy, f.target);
    vi.spyOn(migration, 'migrateLegacyHome').mockImplementation(() => { throw errno('EROFS'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(prepareOperatorHome(f.target, 'serve', f.env, { legacy: f.legacy })).toBe(f.target);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('serving the migrated home'));
  });

  it('still fails on an error that is not about write access', () => {
    const f = migrationFixture();
    vi.spyOn(migration, 'migrateLegacyHome').mockImplementation(() => { throw errno('EIO'); });
    expect(() => prepareOperatorHome(f.target, 'serve', f.env, { legacy: f.legacy })).toThrow('EIO: injected');
  });

  // Permission bits do not stop root or Windows writers, so the real read-only case runs elsewhere only.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('boots from a real read-only legacy home', () => {
    const f = migrationFixture();
    chmodSync(f.legacy.root, 0o555);
    restoreModes.push(() => chmodSync(f.legacy.root, 0o755));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(prepareOperatorHome(f.target, 'serve', f.env, { legacy: f.legacy })).toBe(f.legacy);
    expect(json(f.legacy.workspaceConfig).saved).toBe('original');
    expect(readInstallMarker(f.target.config)?.state).not.toBe('committed');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('until both homes are writable'));
  });
});
