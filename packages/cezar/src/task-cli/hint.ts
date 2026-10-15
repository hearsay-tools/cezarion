import { discoverCockpit, type DiscoverOptions } from './discovery.ts';
import type { Cockpit } from './http.ts';

/**
 * Headless `run` stays headless (hearsay-tools/cezarion#504). A cockpit already serving this repo lists the run, but
 * cannot control it while this process owns it (hearsay-tools/cezarion#779, plan step 3), and gets none of its live
 * events — say so once, on stderr.
 *
 * Best-effort and never in the run's way: discovery runs ALONGSIDE the run instead of before it,
 * and the hint prints whenever discovery answers, until `stop()` (called when the run ends)
 * abandons it — cancelling any in-flight probe so it cannot hold the process open either.
 * hearsay-tools/cezarion#1039: a fixed 600 ms cap up front (300 ms per probe request) dropped the
 * hint whenever a loaded host answered `/api/v1/health` slower than that, while the run itself
 * took seconds. Overlapping removes the trade-off: the run never waits, and discovery gets the
 * run's whole duration and the ordinary probe timeout.
 */
export interface CockpitHintIo {
  discover?: (options: DiscoverOptions) => Promise<Cockpit>;
  write?: (line: string) => void;
}

export function startCockpitHint(repoDir: string, io: CockpitHintIo = {}): () => void {
  const controller = new AbortController();
  const discover = io.discover ?? discoverCockpit;
  const write = io.write ?? ((line: string) => console.error(line));
  void Promise.resolve()
    .then(() => discover({ repoDir, signal: controller.signal }))
    .then((found) => {
      if (!controller.signal.aborted) write(`a cockpit is running at ${found.origin}; use "cez task start" to run this task there instead`);
    }, () => { /* no cockpit, or abandoned: silent */ });
  return () => controller.abort();
}
