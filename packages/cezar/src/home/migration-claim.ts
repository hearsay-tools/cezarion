import { closeSync, fsyncSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { recordedProcessLive } from '../delegation/process-liveness.ts';
import { assertHomePath } from './boundary.ts';
import { ownProcessStartToken } from './process-identity.ts';
import { privateDirectory, syncDirectory } from './private-files.ts';
import { migrationPrivacy } from './migration-files.ts';
import { withHomeLock } from './write-lock.ts';

const holderSchema = z.object({ pid: z.number().int().positive(), startToken: z.string().optional() });

export function migrationHolderLive(root: string): boolean {
  const path = join(root, '.migrating');
  try {
    const holder = holderSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return holder.success ? recordedProcessLive(holder.data) : Date.now() - statSync(path).mtimeMs < 30_000;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (error instanceof SyntaxError) return Date.now() - statSync(path).mtimeMs < 30_000;
    throw error;
  }
}

export function claimMigration(root: string): () => void {
  const path = join(root, '.migrating');
  assertHomePath(root, path);
  privateDirectory(root, migrationPrivacy);
  const contents = JSON.stringify({ pid: process.pid, startToken: ownProcessStartToken() });
  const claim = () => {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(root);
  };
  try { claim(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (migrationHolderLive(root)) throw new Error(`Home migration already running: ${path}`);
    // Serialize stale removal and exclusive create. A second reclaimer sees the new live holder.
    withHomeLock(root, () => {
      if (migrationHolderLive(root)) throw new Error(`Home migration already running: ${path}`);
      rmSync(path, { force: true });
      claim();
    });
  }
  return () => {
    if (readFileSync(path, 'utf8') !== contents) throw new Error(`Migration claim changed: ${path}`);
    rmSync(path); syncDirectory(root);
  };
}
