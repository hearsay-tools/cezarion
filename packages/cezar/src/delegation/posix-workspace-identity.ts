import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import type { IdentityFileStore } from './identity-file-store.ts';
import { entryExists as exists } from './entry-exists.ts';

async function directory(dir: string, create: boolean): Promise<void> {
  if (create) await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (await exists(dir)) {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir || (info.mode & 0o077) !== 0) {
      throw new Error('Unsafe owned workspace receipt directory');
    }
  }
}
async function read(path: string, cap: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe owned workspace identity file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > cap || (opened.mode & 0o077) !== 0) throw new Error('Unsafe owned workspace identity file');
    const buffer = Buffer.alloc(cap + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > cap) throw new Error('Oversized owned workspace identity file');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
async function write(path: string, content: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
async function replace(path: string, content: string, cap: number, assertCurrent?: () => void): Promise<void> {
  if (await exists(path)) await read(path, cap);
  assertCurrent?.();
  const temporary = `${path}.${randomUUID()}.tmp`;
  await write(temporary, content);
  try { assertCurrent?.(); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

/** Mode bits and no-follow opens: the directory is 0700, each file 0600, and a replace renames a temporary file. */
export const posixIdentityFileStore: IdentityFileStore = {
  directory,
  read: (path, cap) => read(path, cap),
  write: (path, content) => write(path, content),
  replace,
};
