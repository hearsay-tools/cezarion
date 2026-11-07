import { join } from 'node:path';
import { z } from 'zod';
import type { Home } from './home.ts';
import { assertHomePath } from './boundary.ts';
import { assertHomeReadable } from './install-marker.ts';
import { migrationPrivacy } from './migration-files.ts';
import { replacePrivate } from './private-files.ts';
import { readBytes } from './version-log.ts';

const relativePath = z.string().min(1).refine(path => !path.includes('\\') && !path.startsWith('/')
  && !path.split('/').some(part => part === '..' || part === '.' || part === '') && !/^[a-z]:/i.test(path));
export const migrationRootsSchema = z.object({ config: z.string(), state: z.string(), data: z.string(), cache: z.string(), runtime: z.string() });
export const movedHomeSchema = z.object({ version: z.literal(1), roots: migrationRootsSchema, migratedAt: z.iso.datetime() });
export const migrationFileSchema = z.object({
  path: relativePath, hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), mtimeMs: z.number().nullable(),
  target: z.object({ kind: z.enum(['config', 'state', 'data']), path: relativePath }).nullable(),
}).passthrough();
export const migrationRecordSchema = z.object({
  version: z.literal(1), legacyRoot: z.string(), roots: migrationRootsSchema,
  createdAt: z.iso.datetime(), backup: z.string(), files: z.array(migrationFileSchema),
  /** Set only when a commit:false run finished its copy; boot serves such a pending home read-only. */
  stagedAt: z.iso.datetime().optional(),
  deferredAccounts: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), configDir: z.string() })),
  notMoved: z.array(z.object({ id: z.string(), configDir: z.string(), reason: z.enum(['omp-profile-root-inside-legacy-home', 'duplicate-account-id']) })),
}).passthrough();
export type MigrationRecord = z.infer<typeof migrationRecordSchema>;
export type MigrationFile = z.infer<typeof migrationFileSchema>;

export function migrationRoots(home: Home): z.infer<typeof migrationRootsSchema> {
  return { config: home.config, state: home.state, data: home.data, cache: home.cache, runtime: home.runtime };
}

/** One versioned reader/writer pair, also used by the legacy canary's Import and Ignore. */
export function readMigrationRecord(home: Home): MigrationRecord | undefined {
  const bytes = readBytes(join(home.state, 'migration.json'));
  return bytes === null ? undefined : migrationRecordSchema.parse(JSON.parse(bytes.toString('utf8')));
}

/** Caller owns config then state write.lock; pending homes permit only migration-owned writes. */
export function writeMigrationRecord(home: Home, value: MigrationRecord): void {
  assertHomeReadable(home.config);
  const path = join(home.state, 'migration.json');
  assertHomePath(home.state, path);
  replacePrivate(path, `${JSON.stringify(migrationRecordSchema.parse(value), null, 2)}\n`, migrationPrivacy);
}
