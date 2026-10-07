/** A desktop child follows its supervisor down, without confusing EPERM with death. */
export function supervisorGone(pid: number, initialPpid: number, ppid: number, probe = process.kill): boolean {
  if (initialPpid > 1 && ppid !== initialPpid) return true;
  try { probe(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
export function watchSupervisor(shutdown: () => void, env = process.env): () => void {
  const pid = Number(env.CEZ_SUPERVISOR_PID);
  if (env.CEZ_DESKTOP !== '1' || !Number.isInteger(pid) || pid <= 1) return () => {};
  const initialPpid = process.ppid;
  const timer = setInterval(() => {
    if (!supervisorGone(pid, initialPpid, process.ppid)) return;
    clearInterval(timer);
    shutdown();
  }, 2_000);
  timer.unref();
  return () => clearInterval(timer);
}
