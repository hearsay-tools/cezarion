import type { ChildProcess } from 'node:child_process';

/**
 * How long a child that handles SIGTERM gets to exit before SIGKILL (hearsay-tools/cezarion#980).
 * A cockpit's graceful shutdown is synchronous disk work on its main thread: closing `runs.db`
 * checkpoints the WAL and fsyncs it. Under pack-suite writeback pressure that close alone measured
 * 0.5-2.3 s (XFS log force), and a SIGTERM that lands during an earlier fsync waits up to 2.4 s
 * more before its handler runs, so 3 s was under the measured tail. A child that ignores SIGTERM
 * never exits, so this bound still catches it and fails with the named error below.
 */
export const STOP_CHILD_TIMEOUT_MS = 10_000;

export async function stopChild(child: ChildProcess, name: string, timeoutMs = STOP_CHILD_TIMEOUT_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
    // e2e-wait: process-deadline — bounded child termination escalates to SIGKILL
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      child.kill('SIGKILL');
      reject(new Error(`${name} ignored SIGTERM for ${timeoutMs}ms; sent SIGKILL`));
    }, timeoutMs);
    child.kill('SIGTERM');
  });
}
