import { it } from 'vitest';
import { GROUPS } from './ci-wait-rerun-parity.testkit.ts';
import { expectWaitRowCoverage } from './wait-row-coverage.testkit.ts';

it('registers every ci-wait-rerun runner/family row exactly once', () => {
  expectWaitRowCoverage(GROUPS, ["fresh", "recovered"], 'ci-wait-rerun-', 'ci-wait-rerun-parity.testkit.ts');
});
