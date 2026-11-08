import { it } from 'vitest';
import { GROUPS } from './ci-wait-conflict-parity.testkit.ts';
import { expectWaitRowCoverage } from './wait-row-coverage.testkit.ts';

it('registers every ci-wait-conflict runner/family row exactly once', () => {
  expectWaitRowCoverage(GROUPS, ["fresh", "continued", "recovered"], 'ci-wait-conflict-', 'ci-wait-conflict-parity.testkit.ts');
});
