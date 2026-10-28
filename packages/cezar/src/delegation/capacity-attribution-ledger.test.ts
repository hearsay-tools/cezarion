import { expect, it } from 'vitest';
import { attributionSnapshot, categories, recordCharge, refuseReservation, reportAttribution, resetAttribution } from '../../test/e2e/capacity-attribution-ledger.ts';

it('accounts for debits, refusals and later zero charges without changing the first exhaustion', () => {
  resetAttribution();
  recordCharge('procRead', 3, 7);
  recordCharge('filter', 8, -1);
  const first = attributionSnapshot().firstExhaustion;
  recordCharge('unclassified', 0, -1);
  const report = attributionSnapshot();
  expect(report.counts.procRead).toEqual({ attemptedUnits: 3, successfulChargeUnits: 3, refusedChargeUnits: 0 });
  expect(report.counts.filter).toEqual({ attemptedUnits: 8, successfulChargeUnits: 0, refusedChargeUnits: 8 });
  expect(report.firstExhaustion).toEqual(first);
  expect(first).toMatchObject({ category: 'filter', amount: 8, remaining: -1 });
});

it('resets all categories and signals saturation without reporting identities', () => {
  resetAttribution();
  for (const category of categories) recordCharge(category, 1, 1);
  recordCharge('filter', 2_147_483_647, 1);
  const report = attributionSnapshot();
  expect(report.saturated).toBe(true);
  expect(report.counts.filter.attemptedUnits).toBe(2_147_483_647);
  expect(JSON.stringify(report)).not.toContain('/private/path');
  resetAttribution();
  expect(attributionSnapshot().counts.filter.attemptedUnits).toBe(0);
  expect(attributionSnapshot().saturated).toBe(false);
});

it('refuses unsupported reservations explicitly', () => {
  expect(refuseReservation).toThrow('does not support reservations');
});

it('does not replace the destroy failure when reporting fails', () => {
  const original = new Error('destroy failed');
  expect(() => {
    try { throw original; } finally { reportAttribution(() => { throw new Error('report failed'); }); }
  }).toThrow(original);
  const settled = () => {
    try { return 'incomplete'; } finally { reportAttribution(() => { throw new Error('report failed'); }); }
  };
  expect(settled()).toBe('incomplete');
});

it('keeps subtraction and refusal semantics while recording one evaluation', () => {
  class Budget {
    constructor(public remaining: number) {}
    spend(amount = 1) {
      this.remaining -= amount;
      recordCharge('filter', amount, this.remaining);
      if (this.remaining < 0) throw new Error('exhausted');
    }
  }
  resetAttribution();
  const budget = new Budget(5);
  let evaluated = 0;
  const next = () => { evaluated++; return 3; };
  budget.spend(next());
  expect(() => budget.spend(next())).toThrow('exhausted');
  expect(evaluated).toBe(2);
  expect(budget.remaining).toBe(-1);
  const row = attributionSnapshot().counts.filter;
  expect(row.attemptedUnits).toBe(row.successfulChargeUnits + row.refusedChargeUnits);
  expect(row).toEqual({ attemptedUnits: 6, successfulChargeUnits: 3, refusedChargeUnits: 3 });
  const useOptional = (candidate: Budget | undefined) => candidate?.spend(next());
  useOptional(undefined);
  expect(evaluated).toBe(2);
});

it('partitions every literal site including zero refusals and resets the partition', () => {
  resetAttribution();
  const sites = ['linePrecharge', 'variantExpansion', 'finalMembership', 'caughtProbe'] as const;
  for (const site of sites) {
    recordCharge('literalMapped', 2, 1, site);
    recordCharge('literalMapped', 3, -1, site);
    recordCharge('literalMapped', 0, -1, site);
  }
  const report = attributionSnapshot();
  expect(report.invalid).toBe(false);
  for (const site of sites) expect(report.literalMappedSites[site]).toEqual({ attemptedUnits: 5, successfulChargeUnits: 2, refusedChargeUnits: 3, attemptedCalls: 3 });
  expect(report.counts.literalMapped).toEqual({ attemptedUnits: 20, successfulChargeUnits: 8, refusedChargeUnits: 12 });
  expect(report.firstExhaustion).toMatchObject({ category: 'literalMapped', amount: 3, remaining: -1 });
  resetAttribution();
  expect(attributionSnapshot().literalMappedSites.linePrecharge.attemptedCalls).toBe(0);
});

it('marks missing, unknown and wrong-category sites invalid without throwing', () => {
  for (const run of [
    () => recordCharge('literalMapped', 1, 1),
    () => recordCharge('literalMapped', 1, 1, 'bad' as never),
    () => recordCharge('filter', 1, 1, 'linePrecharge'),
  ]) {
    resetAttribution();
    expect(run).not.toThrow();
    expect(attributionSnapshot().invalid).toBe(true);
  }
});

it('reports site saturation separately', () => {
  resetAttribution();
  recordCharge('literalMapped', 2_147_483_647, 1, 'linePrecharge');
  recordCharge('literalMapped', 1, 1, 'linePrecharge');
  expect(attributionSnapshot().sitesSaturated).toBe(true);
});

it('marks a partial recorder failure invalid and preserves the original refusal', () => {
  resetAttribution();
  const clone = globalThis.structuredClone;
  try {
    globalThis.structuredClone = (() => { throw new Error('recorder failure'); }) as typeof structuredClone;
    expect(() => {
      recordCharge('literalMapped', 1, -1, 'linePrecharge');
      throw new Error('original refusal');
    }).toThrow('original refusal');
  } finally { globalThis.structuredClone = clone; }
  expect(attributionSnapshot().invalid).toBe(true);
});
