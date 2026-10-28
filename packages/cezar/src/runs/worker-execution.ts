import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { windowsIdentityDirectory } from '../delegation/windows-workspace-identity.ts';

const decimalIdentity = z.string().regex(/^\d{1,20}$/);
const aliasObjectIdentity = z.object({ dev: z.string().regex(/^\d{1,20}:\d{1,20}$/), ino: decimalIdentity }).strict();
/** Retention only. This evidence never permits a signal. */
export const workerAliasRetentionSchema = z.object({
  generation: z.string().uuid(), resourceId: z.string().uuid(), bootId: z.string().uuid(),
  roots: z.array(z.object({ path: z.string().max(4096).refine(isAbsolute), identity: aliasObjectIdentity.nullable() }).strict()).min(1).max(16),
  processes: z.array(z.object({ pid: z.number().int().positive(), start: decimalIdentity,
    identities: z.array(aliasObjectIdentity).min(1).max(64) }).strict()).min(1).max(64),
}).strict();
export type WorkerAliasRetention = z.infer<typeof workerAliasRetentionSchema>;

/** Terminal task intent survives loss/quarantine of the public run index. Starting a new
 * generation replaces this entire checkpoint, so an old cleanup cannot authorize reuse. */
export const workerExecutionSchema = z.object({
  generation: z.string().uuid(), phase: z.enum(['queued', 'starting', 'complete']), neverMaterialized: z.literal(true).optional(),
  // Settlement after a same-boot crash with unverified holders is not exit proof (hearsay-tools/cezarion#839).
  abandoned: z.literal(true).optional(),
  scratchCleanup: z.object({ resourceId: z.string().uuid(), path: z.string().refine(isAbsolute) }).strict().optional(),
  aliasRetention: workerAliasRetentionSchema.optional(),
}).strict().refine(proof => ((!proof.neverMaterialized && !proof.scratchCleanup && !proof.abandoned) || proof.phase === 'complete') &&
  !(proof.abandoned && proof.neverMaterialized) && (!proof.aliasRetention || (!proof.neverMaterialized && proof.aliasRetention.generation === proof.generation)));
export type WorkerExecution = z.infer<typeof workerExecutionSchema>;

/** Presence, not parseability, reserves scratch. Unknown evidence must never turn into an
 * orphan merely because runs.json was missing, partly salvaged, or unreadable. Undefined
 * means enumeration itself is uncertain: callers retain all scratch and retry later. */
export function workerEvidenceRunIds(dataDir: string): string[] | undefined {
  const dir = join(dataDir, 'runs');
  try {
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== resolve(dir)) return undefined;
    const names = readdirSync(dir);
    if (process.platform === 'win32') {
      const evidence = join(dir, 'worker-evidence');
      try {
        const info = lstatSync(evidence);
        if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(evidence) !== resolve(evidence)) return undefined;
        windowsIdentityDirectory(evidence, false);
        names.push(...readdirSync(evidence));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined; }
    }
    return [...new Set(names.flatMap(name => {
      const match = /^([0-9a-f-]{36})\.(?:identity|execution|processes)\.json(?:\..*\.tmp)?$/i.exec(name);
      return match && z.string().uuid().safeParse(match[1]).success ? [match[1]!] : [];
    }))];
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined; }
}
