import { it } from 'vitest';
import { GROUPS } from './ci-wait-registration-parity.testkit.ts';
import { expectWaitRowCoverage } from './wait-row-coverage.testkit.ts';

it('registers every ci-wait runner/family row exactly once', () => {
  expectWaitRowCoverage(GROUPS, ["fresh", "continued", "recovered"], 'ci-wait-', 'ci-wait-registration-parity.testkit.ts');
});
