/** Boot may wait about 3.5 seconds for another process importing runs.json. */
export const OPEN_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

/** Block only during open, when there is nothing else to run. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
