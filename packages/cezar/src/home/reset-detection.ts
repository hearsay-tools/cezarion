import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { listBackups } from '../workspace/backups.ts';
import type { VersionLog } from './version-log.ts';

/** Count only registry collections. Other home files never acquire a reset flag. */
export function registryCount(file: string, bytes: Buffer | null): number | undefined {
  const key = file === 'config.json' ? 'projects' : file === 'agent-accounts.json' ? 'accounts' : undefined;
  if (!key || bytes === null) return undefined;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const entries: unknown = (value as Record<string, unknown>)[key];
    return Array.isArray(entries) ? entries.length : 0;
  } catch { return undefined; }
}

export function flagResetOnWrite(log: VersionLog, previous: Buffer | null, next: Buffer | null): void {
  if (previous && (registryCount(log.relativePath, previous) ?? 0) > 0 && registryCount(log.relativePath, next) === 0) {
    log.flagReset(previous, next);
  }
}

/** Called on recovery demand, never on a normal hot registry read. */
export function flagResetFromBackup(log: VersionLog, bytes: Buffer | null): void {
  if (log.relativePath !== 'config.json' || registryCount(log.relativePath, bytes) !== 0 || log.reset() || log.accepted(bytes)) return;
  // The snapshot loader's recovery contract is separate; listing alone treats .bak as newest.
  const newest = listBackups('config.json', log.root)[0];
  if (!newest) return;
  const previous = readFileSync(newest.path);
  if ((registryCount(basename(log.relativePath), previous) ?? 0) > 0) log.flagReset(previous, bytes);
}
