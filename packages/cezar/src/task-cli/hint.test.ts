import { describe, expect, it } from 'vitest';
import type { DiscoverOptions } from './discovery.ts';
import type { Cockpit } from './http.ts';
import { startCockpitHint } from './hint.ts';

/**
 * The headless-run cockpit hint (hearsay-tools/cezarion#1039). The packaged e2e proves the wire
 * end to end; these pin the timing contract it cannot: the hint never gates the run, a slow
 * discovery still prints while the run is going, and nothing prints once the run has ended.
 */
const cockpit: Cockpit = { origin: 'http://127.0.0.1:4350', projectId: 'p', api: 'http://127.0.0.1:4350/api/v1/p/p' };
const line = 'a cockpit is running at http://127.0.0.1:4350; use "cez task start" to run this task there instead';

function deferredDiscovery() {
  let settle!: { resolve: (c: Cockpit) => void; reject: (e: unknown) => void };
  const seen: DiscoverOptions[] = [];
  const discover = (options: DiscoverOptions) => {
    seen.push(options);
    return new Promise<Cockpit>((resolve, reject) => { settle = { resolve, reject }; });
  };
  return { discover, seen, settle: () => settle };
}
const flush = () => new Promise((done) => setTimeout(done, 0));

describe('startCockpitHint', () => {
  it('returns at once and prints whenever a slow discovery answers', async () => {
    const lines: string[] = [];
    const d = deferredDiscovery();
    const stop = startCockpitHint('/repo', { discover: d.discover, write: (l) => lines.push(l) });
    await flush();
    expect(lines).toEqual([]);
    expect(d.seen[0]?.repoDir).toBe('/repo');
    expect(d.seen[0]?.timeoutMs, 'the ordinary probe timeout, not a tight cap').toBeUndefined();
    d.settle().resolve(cockpit);
    await flush();
    expect(lines).toEqual([line]);
    stop();
  });

  it('is silent, and aborts discovery, once the run has ended', async () => {
    const lines: string[] = [];
    const d = deferredDiscovery();
    const stop = startCockpitHint('/repo', { discover: d.discover, write: (l) => lines.push(l) });
    await flush();
    stop();
    expect(d.seen[0]?.signal?.aborted).toBe(true);
    d.settle().resolve(cockpit);
    await flush();
    expect(lines).toEqual([]);
  });

  it('is silent when no cockpit serves the repo', async () => {
    const lines: string[] = [];
    const d = deferredDiscovery();
    const stop = startCockpitHint('/repo', { discover: d.discover, write: (l) => lines.push(l) });
    await flush();
    d.settle().reject(new Error('no-cockpit'));
    await flush();
    expect(lines).toEqual([]);
    stop();
  });

  it('is silent when discovery throws synchronously', async () => {
    const lines: string[] = [];
    const stop = startCockpitHint('/repo', { discover: () => { throw new Error('boom'); }, write: (l) => lines.push(l) });
    await flush();
    expect(lines).toEqual([]);
    stop();
  });
});
