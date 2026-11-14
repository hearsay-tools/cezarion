import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homeFileSchema } from '@open-mercato/cezar-contract/home-recovery';
import type { Home } from './home.ts';
import { homePaths } from './home.ts';
import { registryFiles } from './entry-authorization.ts';
import { homeFileKind } from './file-location.ts';
import { readInstallMarker } from './install-marker.ts';
import { readMigrationRecord, type MigrationFile, type MigrationRecord } from './migration-record.ts';
import { digest, readBytes } from './version-log.ts';

export interface LegacySource { entry: MigrationFile; bytes: Buffer | null; hash: string | null; mtimeMs: number | null; regular: boolean }

export function legacyMigration(home: Home): MigrationRecord | undefined {
  const marker = readInstallMarker(home.config);
  if (marker?.state !== 'committed' || !marker.migratedFrom) return;
  const record = readMigrationRecord(home);
  if (!record || resolve(record.legacyRoot) !== resolve(marker.migratedFrom)) return;
  return record;
}

export function legacyEntries(record: MigrationRecord): MigrationFile[] {
  const entries = new Map(record.files.map(entry => [entry.path, entry]));
  // FRESH records have no files. Discover later creations without creating a legacy home.
  const legacy = homePaths(record.legacyRoot, record.legacyRoot, undefined);
  for (const path of registryFiles(legacy)) {
    const file = path.slice(record.legacyRoot.length + 1).replaceAll('\\', '/');
    if (!entries.has(file) && homeFileSchema.safeParse(file).success) entries.set(file,
      { path: file, hash: null, mtimeMs: null, target: { kind: homeFileKind(file), path: file } });
  }
  return [...entries.values()].filter(entry => entry.target !== null && homeFileSchema.safeParse(entry.path).success);
}

/** Links hash as links, as in migration. They can be ignored but are never imported. */
export function readLegacySource(record: MigrationRecord, entry: MigrationFile): LegacySource {
  const path = join(record.legacyRoot, entry.path);
  try {
    const stat = lstatSync(path);
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readBytes(path);
    return { entry, bytes, hash: digest(bytes), mtimeMs: stat.mtimeMs, regular: stat.isFile() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { entry, bytes: null, hash: null, mtimeMs: null, regular: false };
  }
}

export function legacyWatchDirectories(home: Home): string[] {
  try {
    const record = legacyMigration(home);
    return record ? [...new Set([record.legacyRoot, join(record.legacyRoot, 'remote-settings'),
      join(record.legacyRoot, 'server-instances'), ...legacyEntries(record).map(entry => dirname(join(record.legacyRoot, entry.path)))])] : [];
  } catch { return []; }
}
