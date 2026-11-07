import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { listBackups } from '../workspace/backups.ts';
import type { Home } from './home.ts';
import { digest, type OutsideWrite, type VersionLog } from './version-log.ts';

import { registryCount } from './registry-content.ts';

export function flagResetOnWrite(log: VersionLog, previous: Buffer | null, next: Buffer | null): void {
  if (previous && (registryCount(log.relativePath, previous) ?? 0) > 0 && registryCount(log.relativePath, next) === 0) {
    log.flagReset(previous, next, true);
  }
}

/** Called on recovery demand, never on a normal hot registry read. */
export function flagResetFromBackup(log: VersionLog, bytes: Buffer | null, home: Home | string = log.root, readOnly = false): OutsideWrite | undefined {
  if (log.relativePath !== 'config.json' || registryCount(log.relativePath, bytes) !== 0 || log.reset(readOnly) || log.accepted(bytes)) return;
  // The snapshot loader's recovery contract is separate; listing alone treats .bak as newest.
  const newest = listBackups('config.json', home)[0];
  if (!newest) return;
  const previous = readFileSync(newest.path);
  if ((registryCount(basename(log.relativePath), previous) ?? 0) > 0) {
    if (readOnly) return { restoreHash: digest(previous), observedHash: digest(bytes), detectedAt: new Date().toISOString() };
    log.flagReset(previous, bytes);
  }
}
