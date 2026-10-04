import { describe, expect, it } from 'vitest';
import { delegationStateSchema } from '@open-mercato/cezar-contract';
import { generateRunFixture } from '../../scripts/benchmark-run-store-fixture.ts';
import { parseRunRecords } from './store.ts';

/** Smoke test for the #779 benchmark fixture: it must be reproducible and must be what the real
 *  store would load, or the benchmark measures a file cezar never writes. */
describe('run-store benchmark fixture', () => {
  it('is deterministic for a size, profile and seed', () => {
    const first = generateRunFixture({ runs: 60, profile: 'legacy' });
    expect(JSON.stringify(generateRunFixture({ runs: 60, profile: 'legacy' }))).toBe(JSON.stringify(first));
    expect(JSON.stringify(generateRunFixture({ runs: 60, profile: 'legacy', seed: 2 }))).not.toBe(JSON.stringify(first));
  });

  it.each(['legacy', 'post-778'] as const)('%s records parse with the RunRecord schema unchanged', (profile) => {
    const records = generateRunFixture({ runs: 120, profile });
    expect(records).toHaveLength(120);
    const wire = JSON.parse(JSON.stringify(records));
    const parsed = parseRunRecords(JSON.parse(JSON.stringify(records)));
    expect(parsed.success).toBe(true);
    // Nothing stripped, defaulted or caught: every field the generator writes survives the parse.
    expect(parsed.data).toEqual(wire);
    // `storedDelegationStateSchema` quarantines bad authority instead of failing; check it strictly.
    for (const record of wire) {
      if (record.delegation) expect(delegationStateSchema.safeParse(record.delegation).success).toBe(true);
    }
  });

  it('post-778 differs from legacy only in worker system prompts', () => {
    const legacy = generateRunFixture({ runs: 200, profile: 'legacy' });
    const post = generateRunFixture({ runs: 200, profile: 'post-778' });
    const withoutPrompt = (records: typeof legacy) => records.map(({ systemPrompt: _, ...rest }) => rest);
    expect(withoutPrompt(post)).toEqual(withoutPrompt(legacy));
    expect(legacy.some((run) => run.delegation?.role !== 'worker' && run.systemPrompt !== undefined)).toBe(false);
    expect(JSON.stringify(post).length).toBeLessThan(JSON.stringify(legacy).length * 0.75);
  });

  it('models the 712-run sample from #779', () => {
    const records = generateRunFixture({ runs: 712, profile: 'legacy' });
    const bytes = (value: unknown) => JSON.stringify(value, null, 2).length;
    const sizes = records.map(bytes).sort((a, b) => a - b);
    const total = bytes(records);
    expect(total).toBeGreaterThan(15e6);
    expect(total).toBeLessThan(21e6);
    expect(sizes[sizes.length >> 1]).toBeGreaterThan(4_000);
    expect(sizes[sizes.length >> 1]).toBeLessThan(11_000);
    expect(sizes.at(-1)).toBeGreaterThan(150_000);
    expect(records.filter((run) => run.archived).length).toBeGreaterThan(680);
    expect(records.filter((run) => run.delegation).length).toBeGreaterThan(680);
  });
});
