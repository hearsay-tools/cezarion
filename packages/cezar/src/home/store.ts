import type { Home } from './home.ts';
import { existsSync } from 'node:fs';
import { registryCount } from './registry-content.ts';
import { homeChanged } from './changes.ts';
import { flagResetFromBackup, flagResetOnWrite } from './reset-detection.ts';
import { basename, dirname, join } from 'node:path';
import { backupBeforeWrite } from '../workspace/backups.ts';
import { assertSquawkHomeWriteIsSandboxed } from '../paths.ts';
import { assertHomeReadable, assertHomeWritable, createInstallMarker, readInstallMarker, underTestRunner } from './install-marker.ts';
import { digest, OUTSIDE_WRITE_ENFORCEMENT, readBytes, VersionLog, type OutsideWrite } from './version-log.ts';
import { withHomeLock } from './write-lock.ts';
import { assertHomePaths } from './boundary.ts';
import { homeEntryAuthorization, registryFiles, seedHomeRegistry } from './entry-authorization.ts';
import { homePathLocation } from './file-location.ts';
import { assertNoMigration } from './migration-guard.ts';

/** A path-derived reader preserves APIs that already accept a resolved Home path (ADR 0059). */
export function homeFileRoot(path: string): string {
  const parent = dirname(path);
  // An explicit CEZ_HOME may itself be named remote-settings or server-instances.
  try { if (readInstallMarker(parent)) return parent; } catch { return parent; }
  return ['remote-settings', 'server-instances'].includes(basename(parent)) ? dirname(parent) : parent;
}

/** Registry files only. No ambient paths, no user settings, no layout selection. */
export class HomeStore {
  readonly root: string;
  private writeDepth = 0;
  constructor(private readonly home: Home | string, private readonly options: { requireBackup?: boolean } = {}) { this.root = typeof home === 'string' ? home : home.root; }

  private journal(path: string, reportOnly = false): VersionLog {
    const { root, file } = homePathLocation(this.home, path);
    return new VersionLog(root, file, {}, reportOnly);
  }

  private lockRoot(path: string): string {
    if (typeof this.home !== 'string') {
      if ([this.home.config, this.home.remoteSettings].includes(path)) return this.home.config;
      if ([this.home.state, this.home.serverInstances].includes(path)) return this.home.state;
    }
    return this.journal(path).root;
  }

  /** Synchronous transactions never retain the filesystem lock over an event-loop yield. */
  transaction<T>(operation: (reportOnly?: boolean) => T, writePaths: readonly string[] = [], readOnly = false): T {
    if (!readOnly && this.writeDepth === 0) assertNoMigration(this.root);
    const authorization = homeEntryAuthorization(this.root);
    const beforeWrite = readOnly ? undefined : authorization?.beforeWrite;
    if (authorization && beforeWrite) {
      // Consume first: preparation writes through this store, and a refusal stays armed for the next write.
      authorization.beforeWrite = undefined;
      try { beforeWrite(); } catch (error) { authorization.beforeWrite = beforeWrite; throw error; }
    }
    const marker = readInstallMarker(this.root);
    const entry = authorization && (!marker || !authorization.seeded) ? authorization : undefined;
    if (readOnly) assertHomeReadable(this.root);
    if (!readOnly && (marker || !entry)) assertHomeWritable(this.root);
    const files = entry ? registryFiles(entry.home) : [];
    this.assertBoundary(writePaths, true);
    // Seeding is auxiliary. Check every path before the first mutation, but skip unsafe ones.
    const seedable = files.filter(path => {
      try { this.assertBoundary([path]); return true; } catch { return false; }
    });
    const roots = [...new Set([...(entry ? [this.root] : []), ...writePaths.map(path => this.lockRoot(path))])];
    if (!roots.length) roots.push(this.root);
    // Entry seeding takes config before state too; keep that order for multi-file callers.
    roots.sort((a, b) => Number(b === this.root) - Number(a === this.root));
    const operationWithEntry = () => {
      if (!readOnly) assertNoMigration(this.root, true);
      const reportOnly = readOnly && (existsSync(join(this.root, '.migrating')) || readInstallMarker(this.root)?.state === 'pending');
      if (entry && !reportOnly) createInstallMarker(this.root, underTestRunner() ? 'test' : entry.kind);
      if (!readOnly) assertHomeWritable(this.root);
      if (entry && !reportOnly) entry.seeded = seedHomeRegistry(this, seedable, entry.home) && seedable.length === files.length;
      if (!readOnly) this.writeDepth++;
      try { return operation(reportOnly); } finally { if (!readOnly) this.writeDepth--; }
    };
    return roots.reduceRight<() => T>((next, root) => () => withHomeLock(root, next), operationWithEntry)();
  }

  assertBoundary(paths: readonly string[], backups = false): Map<string, unknown> {
    const unavailable = new Map<string, unknown>();
    assertHomePaths(this.root, [join(this.root, 'install.json')]);
    const files = paths.filter(path => /\.(?:json|bak|lock)$/.test(path));
    for (const path of paths) {
      const targets = [path];
      if (files.includes(path)) targets.push(join(this.journal(path).directory, 'HEAD'));
      assertHomePaths(this.lockRoot(path), targets);
    }
    if (backups) for (const path of files) {
      const file = this.journal(path).relativePath;
      const root = typeof this.home === 'string' ? this.root : this.home.state;
      try { assertHomePaths(root, [join(typeof this.home === 'string' ? join(root, 'backups') : this.home.backups, file)]); }
      catch (error) { unavailable.set(path, error); }
    }
    return unavailable;
  }

  read(path: string): string {
    const log = this.journal(path);
    // Reading an old or protected home never creates a marker or lets a test mutate a live home.
    if (!this.canJournal()) return this.requiredBytes(path).toString('utf8');
    try {
      this.assertBoundary([path]);
      return withHomeLock(log.root, () => {
        const bytes = readBytes(path);
        // A pending transition can happen while waiting. Ordinary reads do not probe .migrating:
        // their legacy journal is excluded from copied files and the legacy hash comparison.
        if (this.canJournal()) log.inspect(bytes);
        return this.requiredBytes(path, bytes).toString('utf8');
      });
    } catch {
      // Auxiliary failures must never hide readable saved data. Only this live read may throw.
      return this.requiredBytes(path).toString('utf8');
    }
  }

  private canJournal(): boolean {
    try {
      const marker = readInstallMarker(this.root);
      if (!marker || marker.state === 'pending' || (marker.kind === 'live' && underTestRunner())) return false;
      assertSquawkHomeWriteIsSandboxed(this.root);
      return true;
    } catch {
      // Invalid marker or protected passwd-home: reads remain read-only and keep saved data visible.
      return false;
    }
  }

  private requiredBytes(path: string, bytes = readBytes(path)): Buffer {
    if (bytes !== null) return bytes;
    throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
  }

  writeJson(path: string, value: unknown, recoveredBase?: Buffer): void {
    this.replace(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), recoveredBase);
  }

  replace(path: string, bytes: Buffer | null, recoveredBase?: Buffer): void {
    const unavailable = this.assertBoundary([path], true).get(path);
    this.transaction(() => {
      const log = this.journal(path);
      const previous = readBytes(path);
      const restoredDeletion = this.checkOutside(path, log, previous, recoveredBase);
      backupBeforeWrite(path, bytes, { home: this.home, unavailable, required: this.options.requireBackup });
      const reset = log.reset(); // Finish any reset whose primary committed before a crash.
      const keepAcceptance = !reset && registryCount(log.relativePath, previous) === 0 && log.accepted(previous);
      flagResetOnWrite(log, previous, bytes);
      log.replace(path, bytes);
      log.reset(); // The durable reset now survives later ordinary writes.
      if (keepAcceptance || restoredDeletion) log.clearRecovery(bytes);
      homeChanged(this.root);
    }, [path]);
  }

  private checkOutside(path: string, log: VersionLog, previous: Buffer | null, recoveredBase?: Buffer): boolean {
    const outside = log.inspect(previous);
    if (outside && OUTSIDE_WRITE_ENFORCEMENT) {
      // Only the registry loader self-heals deletions. Prove its unmodified backup base is
      // the pinned version before permitting the merged save; outside content still refuses.
      if (log.relativePath === 'config.json' && previous === null && recoveredBase !== undefined
        && digest(recoveredBase) === outside.restoreHash) return true;
      homeChanged(this.root);
      throw new HomeOutsideWriteError(path);
    }
    return false;
  }

  outsideWrite(path: string): OutsideWrite | undefined {
    if (readInstallMarker(this.root)?.state === 'pending') return;
    this.assertBoundary([path]);
    return this.transaction(reportOnly => {
      const log = this.journal(path, reportOnly);
      return log.inspect(readBytes(path));
    }, [path], true);
  }

  createExclusive(path: string, bytes: Buffer): void {
    this.assertBoundary([path], true);
    this.transaction(() => {
      const log = this.journal(path);
      this.checkOutside(path, log, readBytes(path));
      // Exclusive publication can only replace absence, which needs no snapshot.
      log.createExclusive(path, bytes);
      homeChanged(this.root);
    }, [path]);
  }

  restoreOutsideWrite(path: string): void {
    this.assertBoundary([path]);
    this.restoreRecovery(path);
  }

  /** Bounded flag reads; outside inspection still owns the normal per-file lock. */
  recovery(path: string): { reason: 'outside-write' | 'reset'; detectedAt: string; canRestore: boolean; restoreHash: string | null } | undefined {
    if (!this.canJournal()) return;
    this.assertBoundary([path]);
    // Observing a never-created optional file must not create its first journal.
    if (!existsSync(path) && !existsSync(this.journal(path).directory)) return;
    return this.transaction(reportOnly => {
      const log = this.journal(path, reportOnly);
      const bytes = readBytes(path);
      const outside = log.inspect(bytes);
      if (!outside) flagResetFromBackup(log, bytes, this.home);
      const flag = outside ?? log.reset();
      let canRestore = true;
      if (flag) try { log.recoveryBytes(flag); } catch { canRestore = false; }
      return flag ? { reason: outside ? 'outside-write' as const : 'reset' as const, detectedAt: flag.detectedAt, canRestore, restoreHash: flag.restoreHash } : undefined;
    }, [path], true);
  }

  /** Explicit restore resolves any incident; normal writes only self-heal a proven registry deletion. */
  restoreFile(path: string, bytes: Buffer | null, keepReset = false): void {
    const unavailable = this.assertBoundary([path], true).get(path);
    this.transaction(() => {
      const log = this.journal(path);
      log.inspect(readBytes(path));
      backupBeforeWrite(path, bytes, { home: this.home, unavailable, required: this.options.requireBackup });
      log.replace(path, bytes);
      log.clearRecovery(bytes, keepReset);
      homeChanged(this.root);
    }, [path]);
  }

  restoreRecovery(path: string, detectedAt?: string): string | undefined {
    this.assertBoundary([path], true);
    return this.transaction(() => {
      const log = this.journal(path);
      const outside = log.inspect(readBytes(path));
      const reset = log.reset();
      const flag = outside ?? reset;
      if (!flag) return;
      assertRecoveryIncident(flag, detectedAt);
      // Restoring an outside write must not accept a separate, unresolved registry reset.
      this.restoreFile(path, log.recoveryBytes(flag), Boolean(outside && reset));
      return flag.detectedAt;
    }, [path]);
  }

  /** Stale cockpit retries cannot accept a different incident or an unflagged file. */
  acceptRecovery(path: string, detectedAt?: string): void {
    this.assertBoundary([path]);
    this.transaction(() => {
      const log = this.journal(path);
      const flag = log.inspect(readBytes(path)) ?? log.reset();
      if (!flag) return;
      assertRecoveryIncident(flag, detectedAt);
      this.acceptOutsideWrite(path);
    }, [path]);
  }

  acceptOutsideWrite(path: string): void {
    this.assertBoundary([path]);
    this.transaction(() => {
      const log = this.journal(path);
      log.inspect(readBytes(path));
      log.accept(path);
      homeChanged(this.root);
    }, [path]);
  }

}

function assertRecoveryIncident(flag: OutsideWrite, detectedAt: string | undefined): void {
  if (detectedAt !== undefined && flag.detectedAt !== detectedAt) {
    throw new Error('Recovery incident changed. Refresh and try again.');
  }
}

export function readHomeFile(path: string, home?: Home): string {
  return new HomeStore(home ?? homeFileRoot(path)).read(path);
}

/** Managed-layout files stay outside HomeStore, but their entry's first write still marks it. */
export function prepareAuthorizedHomeWrite(home: Home): void {
  if (homeEntryAuthorization(home.root)) new HomeStore(home).transaction(() => {});
}

/** Callers preserve their existing write-failure surface; best-effort writers can warn by type. */
export class HomeOutsideWriteError extends Error {
  constructor(path: string) { super(`Outside write to ${path}; restore or accept it first`); this.name = 'HomeOutsideWriteError'; }
}
