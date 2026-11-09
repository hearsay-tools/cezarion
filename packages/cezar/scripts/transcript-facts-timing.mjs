/** Main-thread measurements only: worker CPU does not count as loop blocking. */
import { readFileSync } from 'node:fs';

export function readQueueWaitMs({ read = readFileSync, platform = process.platform } = {}) {
  // Linux schedstat field 2 is cumulative run-queue wait in nanoseconds.
  if (platform !== 'linux') return null;
  try {
    const waitNs = Number(read('/proc/thread-self/schedstat', 'utf8').trim().split(/\s+/)[1]);
    return Number.isFinite(waitNs) && waitNs >= 0 ? waitNs / 1e6 : null;
  }
  catch { return null; /* Optional diagnostic on restricted procfs mounts. */ }
}

export function timingSnapshot({ now = () => performance.now(), readQueue = readQueueWaitMs,
  readCpu = () => process.threadCpuUsage() } = {}) {
  const cpu = readCpu();
  const queueBeforeMs = readQueue();
  const at = now();
  const queueAfterMs = readQueue();
  return { at, cpuMs: (cpu.user + cpu.system) / 1000, queueBeforeMs, queueAfterMs };
}

export function timingDelta(start, end) {
  const elapsedMs = end.at - start.at;
  const mainThreadCpuMs = end.cpuMs - start.cpuMs;
  // Previous AFTER -> next BEFORE is contained in the wall-clock interval.
  // Subtract only this inner queue-wait delta. A pause between a scheduler
  // read and the clock must never credit wait from outside the interval.
  const queueWaitMs = start.queueAfterMs === null || end.queueBeforeMs === null ? null
    : Math.max(0, Math.min(elapsedMs, end.queueBeforeMs - start.queueAfterMs));
  // Residual includes timer/IO sleep and measurement overhead, not just IO.
  return { elapsedMs, mainThreadCpuMs, queueWaitMs,
    blockedMs: queueWaitMs === null ? null : Math.max(0, elapsedMs - mainThreadCpuMs - queueWaitMs) };
}

/** Timer samples exclude their planned sleep; requests have no planned sleep. */
export function blockingBudget(sample, periodMs = 0) {
  const mode = sample.queueWaitMs === null ? 'cpu-only' : 'scheduler-adjusted';
  const blockingMs = sample.queueWaitMs === null ? sample.mainThreadCpuMs
    : Math.max(0, sample.elapsedMs - periodMs - sample.queueWaitMs);
  return { mode, blockingMs: Math.max(0, periodMs > 0 ? Math.max(sample.mainThreadCpuMs, blockingMs) : blockingMs) };
}
