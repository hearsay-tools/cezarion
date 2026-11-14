import { join } from 'node:path';
import { statSync } from 'node:fs';
import { z } from 'zod';
import type { HomeRecoveryFile } from '@open-mercato/cezar-contract/home-recovery';
import { homeFileSchema } from '@open-mercato/cezar-contract/home-recovery';
import type { Home } from './home.ts';
import { HomeStore } from './store.ts';
import { homeFileKind, homeFileLocation } from './file-location.ts';
import { assertHomePath } from './boundary.ts';
import { homeChanged } from './changes.ts';
import { VersionLog, readBytes, type OutsideWrite } from './version-log.ts';
import { replacePrivate } from './private-files.ts';
import { migrationPrivacy } from './migration-files.ts';
import { writeMigrationRecord, type MigrationRecord } from './migration-record.ts';
import { legacyEntries, legacyMigration, readLegacySource, type LegacySource } from './legacy-source.ts';
import { mergeLegacyJson } from './legacy-merge.ts';
import { preserveAccountRelocations } from './legacy-account-paths.ts';

const incidentSchema = z.object({ restoreHash: z.string().nullable(), observedHash: z.string().nullable(), detectedAt: z.iso.datetime() });
const baseChecks = new Map<string, { stamp: string; available: boolean }>();

function journal(home: Home, file: string): VersionLog {
  const { root } = homeFileLocation(home, file);
  const log = new VersionLog(root, file, migrationPrivacy);
  assertHomePath(root, join(log.directory, 'LEGACY'));
  return log;
}

function incident(log: VersionLog, source: LegacySource) {
  const value = log.record('LEGACY');
  const previous = value === undefined ? undefined : incidentSchema.parse(value);
  if (previous?.restoreHash === source.entry.hash && previous.observedHash === source.hash) return previous;
  const next = { restoreHash: source.entry.hash, observedHash: source.hash,
    detectedAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.detectedAt) + 1 : 0)).toISOString() };
  log.setRecord('LEGACY', next);
  return next;
}

function importable(source: LegacySource): boolean {
  const { entry } = source;
  return source.regular && source.bytes !== null && /\.json(?:\.bak)?$/.test(entry.path)
    && entry.target?.path === entry.path && entry.target.kind === homeFileKind(entry.path);
}

/** Retained versions are immutable; metadata changes invalidate their hash/JSON check. */
function baseAvailable(log: VersionLog, flag: OutsideWrite): boolean {
  // A recorded absence is the valid empty base for a file created after migration.
  if (flag.restoreHash === null) return true;
  try {
    const stat = statSync(join(log.directory, flag.restoreHash), { bigint: true });
    const stamp = `${flag.restoreHash}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = baseChecks.get(log.directory);
    if (cached?.stamp === stamp) return cached.available;
    const bytes = log.recoveryBytes(flag); // Read failures are transient: the outer catch retries next poll.
    let available = false;
    try {
      const base: unknown = bytes === null ? null : JSON.parse(bytes.toString('utf8'));
      available = base !== null && typeof base === 'object' && !Array.isArray(base);
    } catch { /* Invalid JSON stays Ignore-only without another read per poll. */ }
    baseChecks.set(log.directory, { stamp, available });
    return available;
  } catch {
    baseChecks.delete(log.directory);
    return false;
  }
}

export function getLegacyRecovery(home: Home): HomeRecoveryFile[] {
  const files: HomeRecoveryFile[] = [];
  try {
    const record = legacyMigration(home);
    if (!record) return files;
    const store = new HomeStore(home);
    for (const entry of legacyEntries(record)) {
      try {
        const source = readLegacySource(record, entry);
        if (source.hash === entry.hash) continue;
        const state = store.transaction(() => {
          const log = journal(home, entry.path);
          const flag = incident(log, source);
          return { detectedAt: flag.detectedAt, canImport: importable(source) && baseAvailable(log, flag) };
        }, [homeFileLocation(home, entry.path).path]);
        files.push({ file: entry.path, reason: 'legacy-change', canRestore: false, ...state });
      } catch { /* One unreadable legacy file or auxiliary journal must not hide other rows. */ }
    }
  } catch { /* A missing or unreadable migration record leaves the cockpit available. */ }
  return files;
}

function retainBase(home: Home, log: VersionLog, source: LegacySource): void {
  if (source.bytes === null) return;
  const path = join(log.directory, source.hash!);
  assertHomePath(log.root, path);
  // Retain the exact legacy bytes without changing HEAD or the live file's recovery state.
  replacePrivate(path, source.bytes, { layout: home.layout });
}

function recordSource(home: Home, record: MigrationRecord, source: LegacySource): void {
  const next = { ...source.entry, hash: source.hash, mtimeMs: source.mtimeMs };
  const index = record.files.findIndex(entry => entry.path === next.path);
  if (index < 0) record.files.push(next);
  else record.files[index] = next;
  writeMigrationRecord(home, record);
  homeChanged(home.root);
}

/** Both roots remain locked through the merge and baseline publication; no await under a lock. */
export function resolveLegacyRecovery(home: Home, file: string, detectedAt: string | undefined, action: 'import' | 'ignore'): void {
  homeFileSchema.parse(file);
  const store = new HomeStore(home, { requireBackup: true });
  const path = homeFileLocation(home, file).path;
  store.transaction(() => {
    const record = legacyMigration(home);
    const entry = record && legacyEntries(record).find(entry => entry.path === file);
    if (!record || !entry) return;
    const source = readLegacySource(record, entry);
    if (source.hash === entry.hash) return; // A resolved retry does not rewrite a live file.
    const log = journal(home, file);
    const flag = incident(log, source);
    if (detectedAt !== undefined && flag.detectedAt !== detectedAt) throw new Error('Recovery incident changed. Refresh and try again.');
    if (action === 'import') {
      if (!importable(source)) throw new Error('This legacy file cannot be imported. Ignore it to keep the live file.');
      assertHomePath(record.legacyRoot, join(record.legacyRoot, file));
      let base: Buffer | null;
      try { base = log.recoveryBytes({ ...flag, restoreHash: entry.hash }); }
      catch { throw new Error('The legacy merge base is missing or corrupt. Ignore this change or recover the base version before importing.'); }
      const current = readBytes(path);
      const before: Record<string, unknown> = base === null ? {} : JSON.parse(base.toString('utf8'));
      const legacy: Record<string, unknown> = JSON.parse(source.bytes!.toString('utf8'));
      const merged = mergeLegacyJson(file, before, legacy, current === null ? {} : JSON.parse(current.toString('utf8')));
      if (file === 'agent-accounts.json') preserveAccountRelocations(home, record, before, legacy, merged);
      // HomeStore takes its existing rotating backup before publishing merged bytes.
      store.writeJson(path, merged);
    }
    retainBase(home, log, source);
    recordSource(home, record, source);
  }, [home.workspaceConfig, home.workspaceUiState, path]);
}
