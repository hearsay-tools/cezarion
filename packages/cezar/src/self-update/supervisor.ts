/** A desktop child follows its supervisor down, without confusing EPERM with death. */
export function supervisorGone(pid: number, initialPpid: number, ppid: number, probe = process.kill): boolean {
  if (initialPpid > 1 && ppid !== initialPpid) return true;
  try { probe(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/**
 * Follow the desktop shell. Two stop paths, each calling `shutdown` at most once between them:
 * the supervisor pid going away (a force-quit shell), and, when the shell opts in with
 * `CEZ_SUPERVISOR_STDIN=1`, the end of stdin, which is how the shell asks for a graceful stop on
 * quit or before a version switch. A pipe closes the same way on Windows, where no POSIX signal
 * reaches us. Without the opt-in, an older shell's `/dev/null` stdin must not read as a stop.
 */
export function watchSupervisor(shutdown: () => void, env = process.env, stdin: NodeJS.ReadableStream = process.stdin): () => void {
  if (env.CEZ_DESKTOP !== '1') return () => {};
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancel();
    shutdown();
  };
  const cancels: Array<() => void> = [];
  const cancel = () => { for (const fn of cancels.splice(0)) fn(); };
  if (env.CEZ_SUPERVISOR_STDIN === '1') {
    stdin.once('end', stop).once('close', stop).once('error', stop);
    stdin.resume();
    cancels.push(() => { stdin.off('end', stop).off('close', stop).off('error', stop); });
  }
  const pid = Number(env.CEZ_SUPERVISOR_PID);
  if (Number.isInteger(pid) && pid > 1) {
    const initialPpid = process.ppid;
    const timer = setInterval(() => {
      if (supervisorGone(pid, initialPpid, process.ppid)) stop();
    }, 2_000);
    timer.unref();
    cancels.push(() => clearInterval(timer));
  }
  return cancel;
}
