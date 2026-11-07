import type { Home } from './home.ts';
import { homeFileSchema } from '@open-mercato/cezar-contract/home-recovery';
import { homeChanged } from './changes.ts';
import { flagResetFromBackup, flagResetOnWrite } from './reset-detection.ts';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { backupBeforeWrite } from '../workspace/backups.ts';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import { assertHomeWritable, createInstallMarker, readInstallMarker, underTestRunner } from './install-marker.ts';
import { OUTSIDE_WRITE_ENFORCEMENT, readBytes, VersionLog, type OutsideWrite } from './version-log.ts';
import { withHomeLock } from './write-lock.ts';
import { assertHomePaths } from './boundary.ts';
import { homeEntryAuthorization, registryFiles, seedHomeRegistry } from './entry-authorization.ts';

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
  constructor(private readonly home: Home | string) { this.root = typeof home === 'string' ? home : home.root; }

  private journal(path: string): VersionLog {
    const rel = relative(resolve(this.root), resolve(path));
    if (!homeFileSchema.safeParse(rel.split(sep).join('/')).success) throw new Error(`Not a HomeStore file: ${path}`);
    return new VersionLog(this.root, rel);
  }

  /** Synchronous transactions never retain the filesystem lock over an event-loop yield. */
  transaction<T>(operation: () => T, writePaths: readonly string[] = []): T {
    const marker = readInstallMarker(this.root);
    const authorization = homeEntryAuthorization(this.root);
    const entry = authorization && (!marker || !authorization.seeded) ? authorization : undefined;
    if (marker || !entry) assertHomeWritable(this.root);
    const files = entry ? registryFiles(entry.home) : [];
    this.assertBoundary(writePaths, true);
    // Seeding is auxiliary. Check every path before the first mutation, but skip unsafe ones.
    const seedable = files.filter(path => {
      try { this.assertBoundary([path]); return true; } catch { return false; }
    });
    return withHomeLock(this.root, () => {
      if (entry) createInstallMarker(this.root, underTestRunner() ? 'test' : entry.kind);
      assertHomeWritable(this.root);
      if (entry) entry.seeded = seedHomeRegistry(this, seedable) && seedable.length === files.length;
      return operation();
    });
  }

  assertBoundary(paths: readonly string[], backups = false): Map<string, unknown> {
    const unavailable = new Map<string, unknown>();
    const targets = [...paths];
    for (const path of paths) {
      if (!/\.(?:json|bak|lock)$/.test(path)) continue;
      const log = this.journal(path);
      targets.push(join(log.directory, 'HEAD')); // Reads follow HEAD; other records publish by replacement.
    }
    assertHomePaths(this.root, targets);
    if (backups) for (const path of paths) {
      const file = this.journal(path).relativePath;
      try { assertHomePaths(this.root, [join(typeof this.home === 'string' ? join(this.root, 'backups') : this.home.backups, file)]); }
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
      return withHomeLock(this.root, () => {
        const bytes = readBytes(path);
        log.inspect(bytes);
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
      if (!marker || (marker.kind === 'live' && underTestRunner())) return false;
      assertCezarHomeWriteIsSandboxed(this.root);
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

  writeJson(path: string, value: unknown): void {
    this.replace(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  }

  replace(path: string, bytes: Buffer | null): void {
    const unavailable = this.assertBoundary([path], true).get(path);
    this.transaction(() => {
      const log = this.journal(path);
      const previous = readBytes(path);
      this.checkOutside(path, log, previous);
      backupBeforeWrite(path, bytes, { home: this.home, unavailable });
      flagResetOnWrite(log, previous, bytes);
      log.replace(path, bytes);
      homeChanged(this.root);
    });
  }

  private checkOutside(path: string, log: VersionLog, previous: Buffer | null): void {
    const outside = log.inspect(previous);
    if (outside && OUTSIDE_WRITE_ENFORCEMENT) {
      homeChanged(this.root);
      throw new HomeOutsideWriteError(path);
    }
  }

  outsideWrite(path: string): OutsideWrite | undefined {
    this.assertBoundary([path]);
    return this.transaction(() => {
      const log = this.journal(path);
      return log.inspect(readBytes(path));
    });
  }

  createExclusive(path: string, bytes: Buffer): void {
    const unavailable = this.assertBoundary([path], true).get(path);
    this.transaction(() => {
      const log = this.journal(path);
      this.checkOutside(path, log, readBytes(path));
      // Exclusive publication can only replace absence, which needs no snapshot.
      backupBeforeWrite(path, bytes, { home: this.home, unavailable });
      log.createExclusive(path, bytes);
      homeChanged(this.root);
    });
  }

  restoreOutsideWrite(path: string): void {
    this.assertBoundary([path]);
    this.restoreRecovery(path);
  }

  /** Bounded flag reads; outside inspection still owns the normal per-file lock. */
  recovery(path: string): { reason: 'outside-write' | 'reset'; detectedAt: string; canRestore: boolean } | undefined {
    if (!this.canJournal()) return;
    this.assertBoundary([path]);
    return this.transaction(() => {
      const log = this.journal(path);
      const bytes = readBytes(path);
      const outside = log.inspect(bytes);
      if (!outside) flagResetFromBackup(log, bytes);
      const flag = outside ?? log.reset();
      return flag ? { reason: outside ? 'outside-write' as const : 'reset' as const, detectedAt: flag.detectedAt, canRestore: true } : undefined;
    });
  }

  /** Explicit restore is the sole replacement that can bypass an unresolved outside write. */
  restoreFile(path: string, bytes: Buffer | null): void {
    const unavailable = this.assertBoundary([path], true).get(path);
    this.transaction(() => {
      const log = this.journal(path);
      log.inspect(readBytes(path));
      backupBeforeWrite(path, bytes, { home: this.home, unavailable });
      log.replace(path, bytes);
      log.clearRecovery(bytes);
      homeChanged(this.root);
    });
  }

  restoreRecovery(path: string): string | undefined {
    this.assertBoundary([path], true);
    return this.transaction(() => {
      const log = this.journal(path);
      const flag = log.inspect(readBytes(path)) ?? log.reset();
      if (!flag) return;
      this.restoreFile(path, log.recoveryBytes(flag));
      return flag.detectedAt;
    });
  }

  acceptOutsideWrite(path: string): void {
    this.assertBoundary([path]);
    this.transaction(() => {
      const log = this.journal(path);
      log.inspect(readBytes(path));
      log.accept(path);
      homeChanged(this.root);
    });
  }

}

export function readHomeFile(path: string): string {
  return new HomeStore(homeFileRoot(path)).read(path);
}

/** Managed-layout files stay outside HomeStore, but their entry's first write still marks it. */
export function prepareAuthorizedHomeWrite(home: Home): void {
  if (homeEntryAuthorization(home.root)) new HomeStore(home).transaction(() => {});
}

/** Callers preserve their existing write-failure surface; best-effort writers can warn by type. */
export class HomeOutsideWriteError extends Error {
  constructor(path: string) { super(`Outside write to ${path}; restore or accept it first`); this.name = 'HomeOutsideWriteError'; }
}
