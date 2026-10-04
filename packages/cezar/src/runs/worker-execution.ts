import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/** Terminal task intent survives loss/quarantine of the public run index. Starting a new
 * generation replaces this entire checkpoint, so an old cleanup cannot authorize reuse. */
export const workerExecutionSchema = z.object({
  generation: z.string().uuid(), phase: z.enum(['queued', 'starting', 'complete']), neverMaterialized: z.literal(true).optional(),
  scratchCleanup: z.object({ resourceId: z.string().uuid(), path: z.string().refine(isAbsolute) }).strict().optional(),
}).strict().refine(proof => (!proof.neverMaterialized && !proof.scratchCleanup) || proof.phase === 'complete');
export type WorkerExecution = z.infer<typeof workerExecutionSchema>;

/** Presence, not parseability, reserves scratch. Unknown evidence must never turn into an
 * orphan merely because runs.json was missing, partly salvaged, or unreadable. Undefined
 * means enumeration itself is uncertain: callers retain all scratch and retry later. */
export function workerEvidenceRunIds(dataDir: string): string[] | undefined {
  const dir = join(dataDir, 'runs');
  try {
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== resolve(dir)) return undefined;
    return [...new Set(readdirSync(dir).flatMap(name => {
      const match = /^([0-9a-f-]{36})\.(?:identity|execution|processes)\.json(?:\..*\.tmp)?$/i.exec(name);
      return match && z.string().uuid().safeParse(match[1]).success ? [match[1]!] : [];
    }))];
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined; }
}
