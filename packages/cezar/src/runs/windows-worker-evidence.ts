import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { windowsIdentityDirectory, windowsMigrateIdentity, windowsReadEither, windowsRemoveIdentity, windowsWriteIdentity } from '../delegation/windows-workspace-identity.ts';

export const isWindowsWorkerEvidence = process.platform === 'win32';

type Kind = 'identity' | 'execution' | 'processes';

/** Only ENOENT establishes absence. Duplicates and unreadable paths fail closed. */
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function windowsEvidencePath(dataDir: string, id: string, kind: Kind, create = false): string {
  z.string().uuid().parse(id);
  const runs = join(dataDir, 'runs');
  const directory = join(runs, 'worker-evidence');
  const name = `${id}.${kind}.json`;
  const legacy = join(runs, name), current = join(directory, name);
  // Validate the ancestors even when the private directory is absent. An empty,
  // tampered directory or redirected runs path is not evidence of absence.
  windowsIdentityDirectory(directory, false);
  const old = present(legacy), modern = present(current);
  if (old && modern) throw new Error(`Duplicate worker ${kind} evidence`);
  if (old) return legacy;
  if (create) windowsIdentityDirectory(directory, true);
  return current;
}

export function readWindowsEvidence(dataDir: string, id: string, kind: Kind, cap: number): string | undefined {
  z.string().uuid().parse(id);
  const name = `${id}.${kind}.json`, runs = join(dataDir, 'runs');
  return windowsReadEither(join(runs, name), join(runs, 'worker-evidence', name), cap);
}

export function writeWindowsEvidence(dataDir: string, id: string, kind: Kind, value: string, fresh = false): void {
  let path = windowsEvidencePath(dataDir, id, kind, true);
  const exists = present(path);
  if (fresh && exists) throw new Error(`Worker ${kind} evidence already exists`);
  const modern = join(dataDir, 'runs', 'worker-evidence', `${id}.${kind}.json`);
  if (exists && path !== modern) {
    windowsIdentityDirectory(join(dataDir, 'runs', 'worker-evidence'), true);
    windowsMigrateIdentity(path, modern);
    path = windowsEvidencePath(dataDir, id, kind);
    if (path !== modern) throw new Error(`Worker ${kind} evidence migration conflict`);
  }
  windowsWriteIdentity(path, value, exists, path === join(dataDir, 'runs', 'worker-evidence', `${id}.${kind}.json`));
}

export function removeWindowsEvidence(dataDir: string, id: string, kind: Kind): void {
  const path = windowsEvidencePath(dataDir, id, kind);
  if (!present(path)) return;
  windowsRemoveIdentity(path, path === join(dataDir, 'runs', 'worker-evidence', `${id}.${kind}.json`));
}

/** A failed or ambiguous lookup must not be treated as absent. */
export function windowsEvidenceAbsent(dataDir: string, id: string, kind: Kind): boolean {
  try { return !present(windowsEvidencePath(dataDir, id, kind)); } catch { return false; }
}
