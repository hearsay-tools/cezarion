import fs from 'node:fs';

type Diagnostic = (message: string) => void;
export function groupInspectionFailed(pid: number, error: unknown, diagnostic: Diagnostic): void {
  diagnostic(`process group ${pid} inspection failed (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
}

/** Only ESRCH proves absence; a signal permission error retains the guard. */
export function autosaveGroupExists(pid: number, diagnostic: Diagnostic): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    groupInspectionFailed(pid, error, diagnostic); return true;
  }
}

/** Shared by live async observation and synchronous durable admission recovery. */
export function autosaveGroupSnapshotAlive(pid: number, stats: readonly string[], diagnostic: Diagnostic): boolean {
  let zombie = false;
  for (const stat of stats) {
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (Number(fields[2]) !== pid) continue;
    if (fields[0] !== 'Z' && fields[0] !== 'X') { diagnostic(`process group ${pid} alive`); return true; }
    zombie = true;
  }
  if (zombie) return false;
  // An empty scan is not proof: recheck the kernel's group lookup.
  return autosaveGroupExists(pid, diagnostic);
}

export function autosaveGroupAliveSync(pid: number): boolean {
  const diagnostic = () => {};
  if (!autosaveGroupExists(pid, diagnostic)) return false;
  if (process.platform !== 'linux') return true;
  try {
    const stats: string[] = [];
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try { stats.push(fs.readFileSync(`/proc/${entry}/stat`, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
    }
    return autosaveGroupSnapshotAlive(pid, stats, diagnostic);
  } catch { return true; }
}
