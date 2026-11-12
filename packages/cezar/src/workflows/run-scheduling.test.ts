import { describe, expect, it } from 'vitest';
import { RUN_STATUS, makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { accountHeldFor, deriveAccountHolds, resumeInFlight } from './run-scheduling.ts';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const later = new Date(NOW + 60_000).toISOString();
const same = <T>(run: T) => run;

// hearsay-tools/squawk#3337: a usage limit holds its account; a provider-error hold does not.
describe('account holds', () => {
  it('a usage-limit hold blocks its account until its resume time', () => {
    const holds = deriveAccountHolds([makeRunRecord({ status: RUN_STATUS.waiting, runner: 'claude', autoResumeAt: later })], same, NOW);
    expect(accountHeldFor(makeRunRecord({ status: RUN_STATUS.queued, runner: 'claude' }), holds, 'claude')).toBe(true);
  });

  it('a provider-error hold blocks no account', () => {
    const holds = deriveAccountHolds([makeRunRecord({ status: RUN_STATUS.waiting, runner: 'claude', autoResumeAt: later, autoResumeReason: 'provider-error' })], same, NOW);
    expect(holds.deadline.size).toBe(0);
    expect(accountHeldFor(makeRunRecord({ status: RUN_STATUS.queued, runner: 'claude' }), holds, 'claude')).toBe(false);
  });

  it('a provider-error retry in flight holds no fresh work', () => {
    expect(resumeInFlight(makeRunRecord({ status: RUN_STATUS.running, autoResumeAttempts: 1 }))).toBe(true);
    expect(resumeInFlight(makeRunRecord({ status: RUN_STATUS.running, autoResumeAttempts: 1, autoResumeReason: 'provider-error' }))).toBe(false);
  });
});
