import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { trackChildExit } from './agent-runner.ts';

/** Send SIGTERM once, then SIGKILL after the grace period unless the process exits.
 * Track real exit: ChildProcess.killed only records signal delivery. */
export function modelProbeTeardown(child: ChildProcessWithoutNullStreams, graceMs: number): () => void {
  const hasExited = trackChildExit(child);
  let signalled = false;
  return () => {
    if (signalled || hasExited()) return;
    signalled = true;
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (hasExited()) return;
      child.kill('SIGKILL');
    }, graceMs);
    escalation.unref?.();
  };
}
