import { it } from 'vitest';
import { GROUPS } from './worker-reboot-parity.testkit.ts';
import { expectWaitRowCoverage } from './wait-row-coverage.testkit.ts';

it('registers every worker-reboot runner/family row exactly once', () => {
  expectWaitRowCoverage(GROUPS, ["collect", "destroy", "reuse"], 'worker-reboot-', 'worker-reboot-parity.testkit.ts');
});
