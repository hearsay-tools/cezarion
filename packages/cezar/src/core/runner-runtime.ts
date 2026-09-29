import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Default wall-clock cap for a single run before SIGTERM → SIGKILL.
 *  Managed workflow sessions default to `timeoutMs: 0` to disable it entirely. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
/** Grace period between SIGTERM and SIGKILL when a timeout fires. */
export const KILL_GRACE_MS = 10_000;
/** After `end()` closes stdin, bound an EOF-ignoring subprocess with
 *  SIGTERM, then SIGKILL. */
export const EOF_TERM_GRACE_MS = 8_000;
export const EOF_KILL_GRACE_MS = 4_000;
/** Reopen window after a turn ends before an auto-ended session closes stdin. */
export const AUTO_END_DELAY_MS = 250;

/** Managed open turns fail after this long without native stream activity. */
export const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 30 * 60_000;

/** A descendant can inherit the CLI's pipes. After confirmed CLI exit, allow
 * buffered final frames to drain, then bound both pipes so result/close settles.
 * Never use pipe closure as evidence of process exit. */
export function boundOutputDrainAfterExit(child: ChildProcessWithoutNullStreams): void {
  child.once('exit', () => {
    const timer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, 250);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  });
}
