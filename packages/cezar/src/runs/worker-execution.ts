import { legacyRunsBeside, runDataDir } from '../legacy-runs.ts';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { describeProcesses } from '../delegation/process-liveness.ts';

/** Terminal task intent survives loss/quarantine of the public run index. Starting a new
 * generation replaces this entire checkpoint, so an old cleanup cannot authorize reuse. */
export const workerExecutionSchema = z.object({
  generation: z.string().uuid(), phase: z.enum(['queued', 'starting', 'complete']), neverMaterialized: z.literal(true).optional(),
  // Settlement after a same-boot crash with unverified holders is not exit proof (hearsay-tools/cezarion#839).
  abandoned: z.literal(true).optional(),
  scratchCleanup: z.object({ resourceId: z.string().uuid(), path: z.string().refine(isAbsolute) }).strict().optional(),
}).strict().refine(proof => ((!proof.neverMaterialized && !proof.scratchCleanup && !proof.abandoned) || proof.phase === 'complete') &&
  !(proof.abandoned && proof.neverMaterialized));
export type WorkerExecution = z.infer<typeof workerExecutionSchema>;

/** Presence, not parseability, reserves scratch. Unknown evidence must never turn into an
 * orphan merely because runs.json was missing, partly salvaged, or unreadable. Undefined
 * means enumeration itself is uncertain: callers retain all scratch and retry later. A task the
 * project move left in `.ai/cezar/` keeps its evidence there; only such a task's own evidence
 * files reserve it, so a kept task that never was a worker stays deletable. */
export function workerEvidenceRunIds(dataDir: string): string[] | undefined {
  let kept: Set<string>;
  try { kept = new Set(legacyRunsBeside(dataDir)); } catch { return undefined; } // an unreadable list: uncertain
  const own = evidenceIdsIn(join(dataDir, 'runs'));
  // Every listed task resolves to the same legacy directory, `.ai/cezar/` beside `dataDir`.
  const legacy = kept.size === 0 ? [] : evidenceIdsIn(join(runDataDir(dataDir, [...kept][0]!), 'runs'));
  if (own === undefined || legacy === undefined) return undefined;
  return [...new Set([...own, ...legacy.filter(id => kept.has(id))])];
}

function evidenceIdsIn(dir: string): string[] | undefined {
  try {
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== resolve(dir)) return undefined;
    return readdirSync(dir).flatMap(name => {
      const match = /^([0-9a-f-]{36})\.(?:identity|execution|processes)\.json(?:\..*\.tmp)?$/i.exec(name);
      return match && z.string().uuid().safeParse(match[1]).success ? [match[1]!] : [];
    });
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined; }
}

/** Why a worker execution may not start, and the command that gets past it (hearsay-tools/squawk#867). */
export class WorkerAdmissionRefusal extends Error {
  constructor(cause: string, readonly next: string) { super(cause); }
}

export const SPAWN_NEXT = 'spawn a new worker with the instruction';

/** The previous execution when it lets a new one start: complete, or queued and never started. */
export function admissibleExecution(prior: WorkerExecution | undefined): WorkerExecution {
  if (prior?.abandoned) throw new WorkerAdmissionRefusal('the worker execution was abandoned', SPAWN_NEXT);
  if (!prior || (prior.phase !== 'queued' && prior.phase !== 'complete')) {
    throw new WorkerAdmissionRefusal(`the previous execution is not proven finished (checkpoint ${prior?.phase ?? 'missing'})`,
      `retry the same command after it ends; if this repeats, ${SPAWN_NEXT}`);
  }
  return prior;
}

/** The refusal for live holders of the worker's paths; no PID means the holder proof was unreadable. */
export function holderRefusal(holders: readonly number[]): WorkerAdmissionRefusal {
  return holders.length
    ? new WorkerAdmissionRefusal(`processes ${describeProcesses(holders)} still hold the worker's worktree or scratch`, 'end them, then retry the same command')
    : new WorkerAdmissionRefusal("the worker's worktree or scratch is not proven free of processes", `retry the same command; if this repeats, ${SPAWN_NEXT}`);
}

/** The refusal a failed admission returns: its own cause and next step. Only an error without
 *  a message falls back to `fallback`. */
export function admissionRefusal(error: unknown, fallback: string): { ok: false; error: string; next?: string } {
  if (error instanceof WorkerAdmissionRefusal) return { ok: false, error: error.message, next: error.next };
  return { ok: false, error: error instanceof Error && error.message ? error.message : fallback };
}
