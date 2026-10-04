import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const identitySchema = z.object({ path: z.string(), dev: z.number(), ino: z.number(), birthtimeMs: z.number() }).strict();
const removalsSchema = z.array(identitySchema).max(32);
export type FallbackRemoval = z.infer<typeof identitySchema>;
const FILE = '.cez-fallback-removal.json';

/** A recursive rm can remove the owner marker before failing to remove its directory.
 * This private checkpoint preserves that already-verified authority across retry/restart,
 * bound to the exact directory incarnation, never a replacement at the same pathname. */
export function readFallbackRemovals(local: string): FallbackRemoval[] {
  let fd: number;
  try { fd = openSync(join(local, FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077)) throw Error('Unsafe fallback removal checkpoint');
    const buffer = Buffer.alloc(16385), count = readSync(fd, buffer, 0, buffer.length, 0);
    return removalsSchema.parse(JSON.parse(buffer.subarray(0, count).toString('utf8')));
  } finally { closeSync(fd); }
}

export function fallbackIdentity(path: string): FallbackRemoval {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== resolve(path)) throw Error('Unsafe fallback directory');
  return { path, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

export function checkpointFallbackRemoval(local: string, path: string, records: FallbackRemoval[]): void {
  const identity = fallbackIdentity(path);
  const next = removalsSchema.parse([...records.filter(record => record.path !== path), identity]);
  mkdirSync(local, { recursive: true });
  if (!lstatSync(local).isDirectory() || realpathSync(local) !== resolve(local)) throw Error('Unsafe fallback pointer directory');
  const target = join(local, FILE), temporary = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}
