import type { ProcessWaitResult } from '@open-mercato/cezar-contract';
import { recordedProcessLive } from '../delegation/process-liveness.ts';
import { readExitCode, type ExitFileRoots } from './exit-file.ts';

/**
 * Watches a background command for a process wait (hearsay-tools/cezarion#1446). Shaped like
 * `CiWatcherSupervisor`: `watch` settles once with the first outcome, and an aborted watch never
 * settles. Node has no pidfd and the command is not Cezar's child, so it polls: the exit file
 * first (a finished command's code wins even if its PID was since reused), then the process
 * incarnation, then the deadline.
 */
export const PROCESS_POLL_MS = 5_000;
const DIAGNOSTIC_MAX = 512;

export type ProcessWatchRequest = { pid: number; startToken?: string; exitFile?: string; deadline: string; roots: ExitFileRoots };

/** One check, or undefined while the process still runs before its deadline. Never throws. */
export function probeProcessWait(request: ProcessWatchRequest, now: number): ProcessWaitResult | undefined {
  const observedAt = new Date(now).toISOString();
  try {
    if (request.exitFile !== undefined) {
      const read = readExitCode(request.exitFile, request.roots);
      if (read.present) return { outcome: 'exit_file', observedAt, ...(read.exitCode === undefined ? { exitFileNote: 'not-an-exit-code' as const } : { exitCode: read.exitCode }) };
    }
    if (!recordedProcessLive({ pid: request.pid, ...(request.startToken === undefined ? {} : { startToken: request.startToken }) })) return { outcome: 'exited', observedAt };
    if (now >= Date.parse(request.deadline)) return { outcome: 'deadline', observedAt };
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: 'error', observedAt, diagnostic: message.slice(0, DIAGNOSTIC_MAX) };
  }
}

export class ProcessWaitSupervisor {
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly watches = new Set<AbortController>();

  constructor(options: { pollMs?: number; now?: () => number } = {}) {
    this.pollMs = options.pollMs ?? PROCESS_POLL_MS;
    this.now = options.now ?? Date.now;
  }

  watch(request: ProcessWatchRequest, signal: AbortSignal): Promise<ProcessWaitResult> {
    return new Promise(resolve => {
      const local = new AbortController();
      this.watches.add(local);
      const stopped = AbortSignal.any([signal, local.signal]);
      let timer: NodeJS.Timeout | undefined;
      const stop = () => { clearTimeout(timer); this.watches.delete(local); };
      stopped.addEventListener('abort', stop, { once: true });
      const tick = () => {
        if (stopped.aborted) return;
        const now = this.now();
        const result = probeProcessWait(request, now);
        if (result) { stop(); resolve(result); return; }
        // The deadline is honoured on time, not up to one poll late.
        timer = setTimeout(tick, Math.max(0, Math.min(this.pollMs, Date.parse(request.deadline) - now)));
        timer.unref?.();
      };
      tick();
    });
  }

  close(): void {
    for (const watch of this.watches) watch.abort();
    this.watches.clear();
  }
}
