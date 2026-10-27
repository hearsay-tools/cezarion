import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isWindowsWorkerEvidence, windowsEvidenceAbsent } from './windows-worker-evidence.ts';

export function executionEvidenceAbsent(dataDir: string, id: string, path: string): boolean {
  return isWindowsWorkerEvidence ? windowsEvidenceAbsent(dataDir, id, 'execution') : !existsSync(path);
}

/** Read a bounded POSIX private record without following its final component. */
export function readPrivateWorkerFile(path: string, cap: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > cap || (info.mode & 0o077)) throw new Error('Unsafe private worker record');
    const buffer = Buffer.alloc(cap + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count > cap) throw new Error('Oversized private worker record');
    return buffer.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}

/** Publish a complete private record after validating the prior directory entry. */
export function replacePrivateWorkerFile(path: string, content: string, fresh = false): void {
  try {
    const existing = lstatSync(path);
    if (fresh || !existing.isFile() || existing.isSymbolicLink()) throw new Error('Unsafe private worker record');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
}
