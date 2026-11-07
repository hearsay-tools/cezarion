import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export function privateDirectory(path: string): void {
  const created = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!created) return;
  syncDirectory(dirname(created));
  let directory = created;
  for (const part of relative(created, path).split(/[\\/]/).filter(Boolean)) {
    syncDirectory(directory);
    directory = join(directory, part);
  }
  syncDirectory(directory);
}

export function atomicTmpPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/** Flush the directory entry as well as file bytes. Windows does not open directories. */
export function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Private, durable atomic replacement. A failed write removes only its own staging file. */
export function replacePrivate(path: string, bytes: string | Buffer): void {
  privateDirectory(dirname(path));
  const stage = atomicTmpPath(path);
  try {
    const fd = openSync(stage, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(stage, path);
    syncDirectory(dirname(path));
  } finally { rmSync(stage, { force: true }); }
}
