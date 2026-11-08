import { readFileSync } from 'node:fs';

/** The final hang guard, even when a broken browser keeps producing output. */
export const LAUNCH_HANG_GUARD_MS = 120_000;
const PROCESS_SAMPLE_MS = 1_000;

/** Linux CPU ticks and page faults expose cold binary loading before the first stderr byte.
 * Unavailable procfs (including other platforms) falls back to pipe and stderr progress. */
export function chromiumProcessProgress(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces and parentheses; fields after its final ')' start at field 3.
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const counters = [fields[7], fields[9], fields[11], fields[12]]; // minflt, majflt, utime, stime
    return counters.every(value => value !== undefined && /^\d+$/.test(value)) ? counters.join(':') : undefined;
  } catch { return undefined; }
}

export function watchChromiumLaunch(pid: number | undefined, silenceMs: number, readProgress = chromiumProcessProgress) {
  let silenceTimer: NodeJS.Timeout;
  let hardTimer: NodeJS.Timeout;
  let sampleTimer: NodeJS.Timeout | undefined;
  let lastProgress = Date.now();
  let previous = pid === undefined ? undefined : readProgress(pid);
  const expired = new Promise<'stall' | 'hard'>(resolve => {
    silenceTimer = setTimeout(() => resolve('stall'), silenceMs);
    hardTimer = setTimeout(() => resolve('hard'), LAUNCH_HANG_GUARD_MS);
  });
  const progress = () => { lastProgress = Date.now(); silenceTimer.refresh(); };
  if (pid !== undefined) sampleTimer = setInterval(() => {
    if (Date.now() - lastProgress < PROCESS_SAMPLE_MS) return;
    const current = readProgress(pid);
    if (current !== undefined && previous !== undefined && current !== previous) progress();
    if (current !== undefined) previous = current;
  }, PROCESS_SAMPLE_MS);
  return {
    expired,
    progress,
    stop() { clearTimeout(silenceTimer); clearTimeout(hardTimer); clearInterval(sampleTimer); },
  };
}
