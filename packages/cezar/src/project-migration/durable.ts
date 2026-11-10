import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { syncDirectory } from '../home/private-files.ts';

/**
 * The migration's durability: every rename, creation and removal it makes is followed by an fsync
 * of the parent directory, and every file another program rewrote (Git's worktree links, SQLite's
 * checkpoint) by an fsync of that file, before the step's done mark is written. Otherwise a power
 * loss could keep the mark and lose the change, and a resume would skip it. One object, so tests
 * observe each call.
 */
export const durable = {
  directory(path: string): void { syncDirectory(path); },
  file(path: string): void {
    // Windows opens no handle that FlushFileBuffers accepts read-only; its renames are write-through.
    if (process.platform === 'win32') return;
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  },
};

/** Atomic replacement with exact permission bits: temp file, fsync, rename, directory fsync. */
export function replaceDurably(path: string, content: string, mode: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', mode);
  try {
    try { fchmodSync(fd, mode); writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    durable.directory(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
}
