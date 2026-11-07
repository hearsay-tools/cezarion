import { createHash } from 'node:crypto';
import { linkSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { atomicTmpPath, replacePrivate, syncDirectory } from './private-files.ts';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const versionSchema = z.object({ hash: hashSchema });
const outsideSchema = z.object({ restoreHash: hashSchema, observedHash: hashSchema, detectedAt: z.iso.datetime() });
export type OutsideWrite = z.infer<typeof outsideSchema>;
type Hash = z.infer<typeof hashSchema>;
export const OUTSIDE_WRITE_ENFORCEMENT = true;

export function readBytes(path: string): Buffer | null {
  try { return readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function digest(bytes: Buffer | null): Hash {
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

/** A journal belongs to the root that owns the live file, independent of runtime/env paths. */
export class VersionLog {
  readonly directory: string;
  constructor(readonly root: string, readonly relativePath: string) {
    this.directory = join(root, '.versions', relativePath);
  }

  record(name: string): unknown | undefined {
    const bytes = readBytes(join(this.directory, name));
    return bytes === null ? undefined : JSON.parse(bytes.toString('utf8'));
  }

  setRecord(name: string, record: unknown): void {
    replacePrivate(join(this.directory, name), `${JSON.stringify(record)}\n`);
  }

  private store(bytes: Buffer | null): Hash {
    const hash = digest(bytes);
    if (bytes !== null) replacePrivate(join(this.directory, hash!), bytes);
    return hash;
  }

  private clearPending(): void {
    rmSync(join(this.directory, 'PENDING'), { force: true });
    syncDirectory(this.directory);
  }

  /** Caller owns write.lock. Seed old installs without changing even one live byte. */
  inspect(bytes: Buffer | null): OutsideWrite | undefined {
    const record = this.record('HEAD');
    if (record === undefined) {
      this.setRecord('HEAD', { hash: this.store(bytes) });
      return;
    }
    const head = versionSchema.parse(record).hash;
    const actual = digest(bytes);
    const pendingRecord = this.record('PENDING');
    const pending = pendingRecord === undefined ? undefined : versionSchema.parse(pendingRecord);
    if (pending && (actual === pending.hash || actual === head)) {
      // Old bytes: crash before replacement. New bytes: crash after replacement. Both are ours.
      if (actual === pending.hash) this.setRecord('HEAD', { hash: pending.hash });
      this.clearPending();
    } else if (actual !== head) {
      if (this.record('OUTSIDE') === undefined) this.setRecord('OUTSIDE', {
        restoreHash: head, observedHash: actual, detectedAt: new Date().toISOString(),
      });
    }
    return this.outside();
  }

  outside(): OutsideWrite | undefined {
    const record = this.record('OUTSIDE');
    return record === undefined ? undefined : outsideSchema.parse(record);
  }

  /** Crash-safe journal order: durable bytes, PENDING, replace, HEAD, clear PENDING. */
  replace(path: string, bytes: Buffer | null): void {
    const hash = this.store(bytes);
    this.setRecord('PENDING', { hash });
    if (bytes === null) {
      rmSync(path, { force: true });
      // Removing an already absent file must also work before its parent directory exists.
      try { syncDirectory(dirname(path)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } else replacePrivate(path, bytes);
    this.setRecord('HEAD', { hash });
    this.clearPending();
  }

  /** Install locks must also exclude older binaries, which create their lock with wx. */
  createExclusive(path: string, bytes: Buffer): void {
    const hash = this.store(bytes);
    this.setRecord('PENDING', { hash });
    const stage = atomicTmpPath(path);
    try {
      replacePrivate(stage, bytes);
      linkSync(stage, path);
      syncDirectory(dirname(path));
      this.setRecord('HEAD', { hash });
      this.clearPending();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') this.clearPending();
      throw error;
    } finally { rmSync(stage, { force: true }); }
  }

  reset(): OutsideWrite | undefined {
    const record = this.record('RESET');
    return record === undefined ? undefined : outsideSchema.parse(record);
  }

  flagReset(previous: Buffer, observed: Buffer | null): void {
    if (this.reset()) return;
    this.setRecord('RESET', { restoreHash: this.store(previous), observedHash: digest(observed), detectedAt: new Date().toISOString() });
  }

  accepted(bytes: Buffer | null): boolean {
    const record = this.record('ACCEPTED');
    return record !== undefined && versionSchema.parse(record).hash === digest(bytes);
  }

  /** Resolve without rewriting the operator's bytes or changing their mtime. */
  accept(path: string): void {
    const bytes = readBytes(path);
    this.setRecord('HEAD', { hash: this.store(bytes) });
    this.clearPending();
    this.clearRecovery(bytes);
  }

  clearRecovery(bytes: Buffer | null): void {
    // Record acceptance before clearing flags: an empty accepted registry must not re-alert.
    this.setRecord('ACCEPTED', { hash: digest(bytes) });
    for (const name of ['OUTSIDE', 'RESET']) rmSync(join(this.directory, name), { force: true });
    syncDirectory(this.directory);
  }

  recoveryBytes(flag: OutsideWrite): Buffer | null {
    const bytes = flag.restoreHash === null ? null : readBytes(join(this.directory, flag.restoreHash));
    if (digest(bytes) !== flag.restoreHash) throw new Error(`Missing or corrupt pinned HomeStore version: ${this.relativePath}`);
    return bytes;
  }

  restore(path: string): void {
    const outside = this.outside();
    if (!outside) return;
    const bytes = this.recoveryBytes(outside);
    this.replace(path, bytes);
    this.clearRecovery(bytes);
  }
}
