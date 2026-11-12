import { logPrefix } from './display.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assertSquawkHomeWriteIsSandboxed } from '../paths.ts';
import { assertTestHomeOutsideAccountHome } from './protected-roots.ts';
import { replacePrivate } from './private-files.ts';
import { withHomeLock } from './write-lock.ts';
import { assertHomeMetadata } from './boundary.ts';

export const installMarkerSchema = z.object({
  installId: z.uuid(), kind: z.enum(['live', 'dev', 'test']), createdAt: z.iso.datetime(),
  migratedFrom: z.string().optional(), state: z.enum(['pending', 'committed']).optional(),
}).passthrough();
export type InstallMarker = z.infer<typeof installMarkerSchema>;

export function underTestRunner(): boolean {
  return !!(process.env.VITEST || process.env.NODE_TEST_CONTEXT || process.env.JEST_WORKER_ID
    || Object.keys(process.env).some(key => key.startsWith('STRYKER_')));
}

export function readInstallMarker(root: string): InstallMarker | undefined {
  try { return installMarkerSchema.parse(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'))); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export function assertHomeReadable(root: string): InstallMarker {
  const marker = readInstallMarker(root);
  if (marker?.kind === 'live' && underTestRunner()) throw new Error(`${logPrefix()} refusing to write live home ${root} from a test runner`);
  assertSquawkHomeWriteIsSandboxed(root);
  if (!marker) throw new Error(`${logPrefix()} refusing to write home ${root} without an install marker; start it through a CLI entry point`);
  return marker;
}

export function assertHomeWritable(root: string): InstallMarker {
  const marker = assertHomeReadable(root);
  if (marker.state === 'pending') throw new Error(`${logPrefix()} refusing to write pending migration home ${root}; finish or roll back the migration first`);
  return marker;
}

/** The migration alone replaces marker state. Normal entry preparation never overwrites it. */
export function writeMigrationMarker(root: string, migratedFrom: string, state: 'pending' | 'committed'): InstallMarker {
  const existing = readInstallMarker(root);
  if (existing) assertHomeReadable(root);
  assertHomeMetadata(root);
  return withHomeLock(root, () => {
    const marker = readInstallMarker(root) ?? { installId: randomUUID(), kind: underTestRunner() ? 'test' : 'live', createdAt: new Date().toISOString() };
    const next = installMarkerSchema.parse({ ...marker, kind: marker.kind === 'test' ? 'test' : 'live', migratedFrom, state });
    replacePrivate(join(root, 'install.json'), `${JSON.stringify(next, null, 2)}\n`, { layout: 'split' });
    return next;
  });
}

/**
 * Only sandbox construction and marker-creating entry points call this. Never downgrades live.
 * A test request refuses an account root in every process, before it can return an existing marker.
 */
export function createInstallMarker(root: string, kind: InstallMarker['kind']): InstallMarker {
  if (kind === 'test') assertTestHomeOutsideAccountHome(root);
  assertSquawkHomeWriteIsSandboxed(root);
  const marker = readInstallMarker(root);
  if (marker) return marker;
  assertHomeMetadata(root);
  return withHomeLock(root, () => {
    const existing = readInstallMarker(root);
    if (existing) return existing;
    const marker = { installId: randomUUID(), kind, createdAt: new Date().toISOString() };
    replacePrivate(join(root, 'install.json'), `${JSON.stringify(marker, null, 2)}\n`);
    return marker;
  });
}
