import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Home } from './home.ts';
import { recordedProcessLive } from '../core/process-stat.ts';
import { assertHomeReadable } from './install-marker.ts';
import { privateDirectory, replacePrivate } from './private-files.ts';
import { withHomeLock } from './write-lock.ts';
import { ownProcessStartToken } from './process-identity.ts';
import { assertHomePath } from './boundary.ts';

const leaseSchema = z.object({ pid: z.number().int().positive(), startToken: z.string().optional(),
  installId: z.uuid(), port: z.number().int().nonnegative(), instance: z.string() });
export type CockpitLease = z.infer<typeof leaseSchema>;

/** Presence is advisory. It never excludes another cockpit or a CLI writer. */
export function readCockpitLeases(home: Home): CockpitLease[] {
  assertHomeReadable(home.root);
  assertHomePath(home.root, join(home.root, '.locks', 'cockpits'));
  return withHomeLock(home.root, () => {
    const directory = join(home.root, '.locks', 'cockpits');
    let names: string[];
    try { names = readdirSync(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const leases: CockpitLease[] = [];
    for (const name of names.filter(name => /^\d+\.lease$/.test(name))) {
      const path = join(directory, name);
      const lease = leaseSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (recordedProcessLive(lease)) leases.push(lease);
      else rmSync(path, { force: true });
    }
    return leases;
  });
}

export function holdCockpitLease(home: Home, port: number, instance = 'default'): () => void {
  const marker = assertHomeReadable(home.root);
  const path = join(home.root, '.locks', 'cockpits', `${process.pid}.lease`);
  assertHomePath(home.root, path);
  const lease = { pid: process.pid, startToken: ownProcessStartToken(), installId: marker.installId, port, instance };
  withHomeLock(home.root, () => {
    readCockpitLeases(home);
    privateDirectory(join(home.root, '.locks', 'cockpits'));
    replacePrivate(path, JSON.stringify(lease));
  });
  return () => {
    assertHomeReadable(home.root);
    assertHomePath(home.root, path);
    withHomeLock(home.root, () => { rmSync(path, { force: true }); });
  };
}
