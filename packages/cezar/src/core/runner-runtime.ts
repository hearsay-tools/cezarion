import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isSignalTerminationExit } from './agent-runner.ts';

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

/** Post-exit drain budget for output a pipe-inheriting descendant still writes. */
export const EXIT_DRAIN_MS = 250;
/** A crash's final diagnostic is worth more than settling fast (hearsay-tools/cezarion#887). */
export const CRASH_EXIT_DRAIN_MS = 750;
/** Wall-clock ceiling on either drain, however stalled the host is. */
export const EXIT_DRAIN_CAP_MS = 2_000;
const EXIT_DRAIN_TICK_MS = 25;

/** A nonzero exit code the process chose, not a signal teardown. */
export function isCrashExit(code: number | null): boolean {
  return code !== null && code !== 0 && !isSignalTerminationExit(code);
}

/** The drain budget for an exit: longer after a crash, the default otherwise. */
export function exitDrainBudget(code: number | null): number {
  return isCrashExit(code) ? CRASH_EXIT_DRAIN_MS : EXIT_DRAIN_MS;
}

/**
 * Call `onExpired` once `budgetMs` of drain time has passed, then return a cancel.
 *
 * hearsay-tools/cezarion#887: a plain wall-clock timer lost late crash stderr under load
 * in two ways. A host stall delays the descendant's write and this timer alike, so the
 * overdue timer closes the pipes first; and an overdue timer runs before the poll phase
 * that reads output already written. Time is therefore counted in short ticks, a stalled
 * tick counts as at most two, and expiry waits one `setImmediate` (after poll).
 * `EXIT_DRAIN_CAP_MS` still bounds the drain in wall-clock time. `ref` keeps the
 * event loop alive for a caller that awaits the drain.
 */
export function afterExitDrain(onExpired: () => void, budgetMs = EXIT_DRAIN_MS, ref = false): () => void {
  const started = Date.now();
  let last = started;
  let drained = 0;
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;
  let immediate: NodeJS.Immediate | undefined;
  const tick = (): void => {
    const now = Date.now();
    // A timer never fires early, so a tick is worth at least one tick (which also
    // keeps fake timers that leave Date alone working) and at most two.
    drained += Math.min(Math.max(EXIT_DRAIN_TICK_MS, now - last), EXIT_DRAIN_TICK_MS * 2);
    last = now;
    if (drained < budgetMs && now - started < EXIT_DRAIN_CAP_MS) {
      timer = setTimeout(tick, EXIT_DRAIN_TICK_MS);
      if (!ref) timer.unref?.();
      return;
    }
    // Never unref this one: an unref'd immediate does not wake a poll phase that
    // is blocked on a held pipe, so it would wait for the descendant to exit.
    immediate = setImmediate(() => { if (!cancelled) onExpired(); });
  };
  timer = setTimeout(tick, Math.min(EXIT_DRAIN_TICK_MS, budgetMs));
  if (!ref) timer.unref?.();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    if (immediate) clearImmediate(immediate);
  };
}

/** A descendant can inherit the CLI's pipes. After confirmed CLI exit, allow
 * buffered final frames to drain, then bound both pipes so result/close settles.
 * Never use pipe closure as evidence of process exit. */
export function boundOutputDrainAfterExit(child: ChildProcessWithoutNullStreams): void {
  child.once('exit', (code) => {
    const cancel = afterExitDrain(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, exitDrainBudget(code));
    child.once('close', cancel);
  });
}
