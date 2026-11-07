import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Home } from '../home/home.ts';
import { assertHomePath } from '../home/boundary.ts';
import { assertHomeReadable } from '../home/install-marker.ts';
import { migrationPrivacy } from '../home/migration-files.ts';
import { replacePrivate } from '../home/private-files.ts';
import { readBytes } from '../home/version-log.ts';
import { withHomeLock } from '../home/write-lock.ts';
import { stepArtifactSchema, type PlatformMigrationReport } from './types.ts';

/**
 * `<state>/server-migrate.json`: the group's durable plan. It is written beside the home migration
 * record, before the first platform move, so a crash between two instance moves is recovered from
 * the planned moves and the disk. Pending homes allow only migration-owned writes like this one.
 */
const reportSchema = z.object({
  moved: z.array(z.object({ stepId: z.string(), from: stepArtifactSchema, to: stepArtifactSchema, backup: stepArtifactSchema.optional() })),
  leftAloneForeign: z.array(stepArtifactSchema),
  errors: z.array(z.object({ artifact: stepArtifactSchema, message: z.string() })),
  details: z.array(z.string()).optional(),
});

const journalSchema = z.object({
  version: z.literal(1),
  /** `migrating` and `rolling-back` recover by rollback; `committing` recovers by finishing. */
  phase: z.enum(['migrating', 'committing', 'rolling-back']),
  instances: z.array(z.object({ instance: z.string().min(1), planned: reportSchema, moved: reportSchema.optional() })),
});

export interface ServerMigrateJournal {
  version: 1;
  phase: 'migrating' | 'committing' | 'rolling-back';
  instances: Array<{ instance: string; planned: PlatformMigrationReport; moved?: PlatformMigrationReport }>;
}

const journalPath = (target: Home) => join(target.state, 'server-migrate.json');

export function readServerMigrateJournal(target: Home): ServerMigrateJournal | undefined {
  const bytes = readBytes(journalPath(target));
  // zod omits absent optional keys, so the parsed value matches the exact-optional report type.
  return bytes === null ? undefined : journalSchema.parse(JSON.parse(bytes.toString('utf8'))) as ServerMigrateJournal;
}

export function writeServerMigrateJournal(target: Home, journal: ServerMigrateJournal): void {
  assertHomeReadable(target.config);
  const path = journalPath(target);
  assertHomePath(target.state, path);
  const bytes = `${JSON.stringify(journalSchema.parse(journal), null, 2)}\n`;
  withHomeLock(target.state, () => replacePrivate(path, bytes, migrationPrivacy));
}

export function removeServerMigrateJournal(target: Home): void {
  const path = journalPath(target);
  assertHomePath(target.state, path);
  withHomeLock(target.state, () => rmSync(path, { force: true }));
}
