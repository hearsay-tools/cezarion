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
