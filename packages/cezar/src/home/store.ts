import type { Home } from './home.ts';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { backupBeforeWrite, isBackupFile } from '../workspace/backups.ts';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import { assertHomeWritable, readInstallMarker, underTestRunner } from './install-marker.ts';
import { OUTSIDE_WRITE_ENFORCEMENT, readBytes, VersionLog, type OutsideWrite } from './version-log.ts';
import { withHomeLock } from './write-lock.ts';
import { assertHomeDirectory, assertHomePath } from './boundary.ts';

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
  constructor(home: Home | string) { this.root = typeof home === 'string' ? home : home.root; }

  private journal(path: string): VersionLog {
    const rel = relative(resolve(this.root), resolve(path));
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Path outside HomeStore: ${path}`);
    const parts = rel.split(sep);
    const allowed = /^(?:config\.json(?:\.bak)?|agent-accounts\.json|ui-state\.json|server\.json|server\.install\.lock)$/;
    if (!(parts.length === 1 && allowed.test(rel)) && !(parts.length === 2
      && ['remote-settings', 'server-instances'].includes(parts[0]!)
      && /^[a-zA-Z0-9-]+\.(?:json|install\.lock)$/.test(parts[1]!))) throw new Error(`Not a HomeStore file: ${path}`);
    return new VersionLog(this.root, rel);
  }

  /** Synchronous transactions never retain the filesystem lock over an event-loop yield. */
  transaction<T>(operation: () => T, writePaths: readonly string[] = []): T {
    assertHomeWritable(this.root);
    this.assertBoundary(writePaths);
    return withHomeLock(this.root, () => { assertHomeWritable(this.root); return operation(); });
  }

  assertBoundary(paths: readonly string[]): void {
    for (const path of paths) {
      assertHomePath(this.root, path);
      if (!/\.(?:json|bak|lock)$/.test(path)) assertHomeDirectory(this.root, path);
    }
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
    this.assertBoundary([path]);
    this.transaction(() => {
      assertCezarHomeWriteIsSandboxed(path);
      if (isBackupFile(basename(path))) backupBeforeWrite(path, value);
      this.replace(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    });
  }

  replace(path: string, bytes: Buffer | null): void {
    this.assertBoundary([path]);
    this.transaction(() => {
      assertCezarHomeWriteIsSandboxed(path);
      const log = this.journal(path);
      const outside = log.inspect(readBytes(path));
      if (outside && OUTSIDE_WRITE_ENFORCEMENT) throw new Error(`Outside write to ${path}; restore or accept it first`);
      log.replace(path, bytes);
    });
  }

  outsideWrite(path: string): OutsideWrite | undefined {
    this.assertBoundary([path]);
    return this.transaction(() => {
      const log = this.journal(path);
      return log.inspect(readBytes(path));
    });
  }

  createExclusive(path: string, bytes: Buffer): void {
    this.assertBoundary([path]);
    this.transaction(() => {
      const log = this.journal(path);
      log.inspect(readBytes(path));
      log.createExclusive(path, bytes);
    });
  }

  restoreOutsideWrite(path: string): void {
    this.assertBoundary([path]);
    this.transaction(() => this.journal(path).restore(path));
  }
}

export function readHomeFile(path: string): string {
  return new HomeStore(homeFileRoot(path)).read(path);
}
