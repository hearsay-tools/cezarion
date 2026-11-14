import { legacyRunsBeside, runDataDir } from './legacy-runs.ts';
import { windowsAutosaveProcessLive, windowsAutosaveProcessToken } from './autosave-windows.ts';
import { autosaveGroupAliveSync } from './autosave-group.ts';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { describeProcesses, processesWithCwdUnder, processStartToken, processPredatesCurrentBoot, recordedProcessLive } from './delegation/process-liveness.ts';
import { saveHolders } from './autosave-holders.ts';

const processSchema = z.object({ pid: z.number().int().positive(), startToken: z.string().optional() });
/** Private safety evidence, independent of the run store's ownership/session lifetime. */
const cleanupSchema = z.object({
  version: z.literal(1), cwd: z.string().min(1), controller: processSchema,
  processes: z.array(processSchema), groups: z.array(z.number().int().min(2)),
  uncertain: z.boolean(), message: z.string(),
  /** The save's owner marker; absent in evidence written before hearsay-tools/squawk#963. */
  marker: z.string().optional(),
});
export type AutosaveCleanupProof = Pick<z.infer<typeof cleanupSchema>, 'processes' | 'groups' | 'uncertain' | 'marker'>;
const processLive = (entry: { pid: number; startToken?: string | undefined }) => process.platform === 'win32' ? windowsAutosaveProcessLive(entry) : recordedProcessLive(entry);
const pathFor = (dataDir: string, id: string) => join(runDataDir(dataDir, z.uuid().parse(id)), 'runs', `${id}.autosave-cleanup.json`);

/** Write before releasing execution. A failed write never authorizes settlement. */
export function retainAutosaveCleanup(dataDir: string, id: string, cwd: string, message: string, proof: AutosaveCleanupProof): void {
  const path = pathFor(dataDir, id);
  const record = cleanupSchema.parse({ version: 1, cwd, message, ...proof,
    controller: { pid: process.pid, startToken: process.platform === 'win32' ? windowsAutosaveProcessToken(process.pid) : processStartToken(process.pid) } });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export function clearAutosaveCleanup(dataDir: string, id: string): void {
  // Legacy history IDs cannot own this UUID-scoped optional evidence.
  if (!z.uuid().safeParse(id).success) return;
  rmSync(pathFor(dataDir, id), { force: true });
}

/** Names reserve orphan scratch even when its run row is no longer loaded; a task the project
 *  move left in `.ai/cezar/` keeps its evidence there. */
export function autosaveCleanupIds(dataDir: string): string[] | undefined {
  try { return [...readdirSync(join(dataDir, 'runs')).flatMap(name => {
    const id = name.replace(/\.autosave-cleanup\.json$/, '');
    return id !== name && z.uuid().safeParse(id).success && autosaveCleanupBlocker(dataDir, id) ? [id] : [];
  }), ...legacyRunsBeside(dataDir).filter(id => autosaveCleanupBlocker(dataDir, id))]; } catch { return undefined; }
}

/** Synchronous admission/cleanup proof, with no signalling or invented timeout release. */
export function autosaveCleanupBlocker(dataDir: string, id: string): string | undefined {
  if (!z.uuid().safeParse(id).success) return undefined;
  const path = pathFor(dataDir, id);
  let record: z.infer<typeof cleanupSchema>;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return 'autosave cleanup evidence unreadable; worktree reuse blocked';
    record = cleanupSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'autosave cleanup evidence unreadable; worktree reuse blocked';
  }
  // A live controller continues observing identities and ancestry, including
  // holders that move cwd. Closing its store is not evidence that cleanup ended.
  if (processLive(record.controller)) return record.message;
  const pids = record.processes.filter(processLive).map(entry => entry.pid);
  const groups = processPredatesCurrentBoot(record.controller) ? [] : record.groups.filter(autosaveGroupAliveSync);
  // Only the save's own processes in the worktree block, never unrelated work there (hearsay-tools/squawk#963).
  const scan = processesWithCwdUnder(record.cwd);
  const holders = scan === 'unknown' ? scan : saveHolders(scan, record.marker, pids);
  if (record.uncertain || pids.length || groups.length || holders === 'unknown' || holders.length) {
    return `autosave cleanup pending; retained PIDs: ${describeProcesses([...new Set([...pids, ...(holders === 'unknown' ? [] : holders)])]) || 'none'}; ` +
      `process groups: ${groups.join(', ') || 'none'}${record.uncertain || holders === 'unknown' ? '; process inspection uncertain' : ''}; worktree reuse blocked`;
  }
  // Reads never unlink evidence: another process may have published a newer
  // save while this snapshot was being probed. Expired bytes are nonblocking;
  // the next owned save atomically replaces them, or history deletion removes them.
  return undefined;
}
