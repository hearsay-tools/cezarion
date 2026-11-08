/** Main-thread measurements only: worker CPU does not count as loop blocking. */
import { readFileSync } from 'node:fs';

export function timingSnapshot() {
  const cpu = process.threadCpuUsage();
  // Linux reports cumulative time waiting to run, in nanoseconds. Other hosts
  // (or restricted procfs mounts) still report CPU and elapsed time.
  let queueWaitMs = null;
  if (process.platform === 'linux') {
    try { queueWaitMs = Number(readFileSync('/proc/thread-self/schedstat', 'utf8').trim().split(/\s+/)[1]) / 1e6; }
    catch { /* Optional diagnostic; never required to measure CPU. */ }
  }
  return { at: performance.now(), cpuMs: (cpu.user + cpu.system) / 1000, queueWaitMs };
}

export function timingDelta(start, end) {
  const elapsedMs = end.at - start.at;
  const mainThreadCpuMs = end.cpuMs - start.cpuMs;
  const queueWaitMs = start.queueWaitMs === null || end.queueWaitMs === null ? null : end.queueWaitMs - start.queueWaitMs;
  // Residual includes timer/IO sleep and measurement overhead, not just IO.
  return { elapsedMs, mainThreadCpuMs, queueWaitMs,
    blockedMs: queueWaitMs === null ? null : Math.max(0, elapsedMs - mainThreadCpuMs - queueWaitMs) };
}
