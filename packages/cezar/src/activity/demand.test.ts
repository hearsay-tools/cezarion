import { describe, expect, it } from 'vitest';
import { ActivityDemand, HTTP_DEMAND_MS } from './demand.ts';

describe('activity demand', () => {
  it('marks a project for 15 s after each HTTP read', () => {
    let now = 1_000;
    const demand = new ActivityDemand(() => now);
    expect(demand.has('shop')).toBe(false);
    demand.markRead('shop');
    now += HTTP_DEMAND_MS - 1;
    expect(demand.has('shop')).toBe(true);
    expect(demand.has('docs')).toBe(false);
    // A view that re-reads every 5 s keeps it.
    demand.markRead('shop');
    now += HTTP_DEMAND_MS - 1;
    expect(demand.has('shop')).toBe(true);
    now += 1;
    expect(demand.has('shop')).toBe(false);
  });
});
