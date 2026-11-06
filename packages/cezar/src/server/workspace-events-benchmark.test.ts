import { describe, expect, it } from 'vitest';
import { runWorkspaceEventsBenchmark } from '../../scripts/benchmark-workspace-events.ts';

interface Phase {
  name: string;
  frameKinds: string[];
  eventBytes: { n: number; p95: number | null };
  detailFetches: { count: number };
  totalBytes: number;
}

/**
 * `bench:workspace-events` (hearsay-tools/cezarion#2730) at a tiny size: the committed workload still
 * runs, and its phases measure what docs/performance/workspace-summary-events.md reports.
 */
describe('bench:workspace-events', () => {
  it('measures full and summary streams with the detail closed and open', async () => {
    const result = await runWorkspaceEventsBenchmark([
      '--events', '16', '--rate', '400', '--children', '2', '--parent-kb', '8', '--child-kb', '1', '--warmup', '2',
    ]) as { summaryModeSupported: boolean; phases: Phase[] };
    const phase = (name: string) => result.phases.find((entry) => entry.name === name)!;

    expect(result.summaryModeSupported).toBe(true);
    expect(result.phases.map((entry) => entry.name)).toEqual([
      'none', 'full/detail-closed', 'full/detail-open', 'summary/detail-closed', 'summary/detail-open',
    ]);
    expect(phase('none').eventBytes.n).toBe(0);
    expect(phase('full/detail-closed').frameKinds).toEqual(['run']);
    expect(phase('summary/detail-closed').frameKinds).toEqual(['run-summary']);
    expect(phase('summary/detail-closed').eventBytes.n).toBe(16);
    // The parent's 8 KiB task rides every full frame of the parent and no summary.
    expect(phase('summary/detail-closed').eventBytes.p95!).toBeLessThan(phase('full/detail-closed').eventBytes.p95! / 4);
    expect(phase('full/detail-closed').detailFetches.count).toBe(0);
    expect(phase('summary/detail-closed').detailFetches.count).toBe(0);
    expect(phase('summary/detail-open').detailFetches.count).toBeGreaterThan(0);
    expect(phase('summary/detail-open').totalBytes).toBeGreaterThan(phase('summary/detail-closed').totalBytes);
  }, 60_000); // bound: one in-process app paces 100 updates at 400/s and waits 600 ms per phase
});
