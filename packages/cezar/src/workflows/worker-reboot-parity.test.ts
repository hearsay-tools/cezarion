import { it } from 'vitest';
import { parityRunners } from '../core/parity-classes.testkit.ts';
import { GROUPS } from './worker-reboot-parity.testkit.ts';
import { expectWaitRowCoverage } from './wait-row-coverage.testkit.ts';

it('registers every worker-reboot runner/family row exactly once', () => {
  expectWaitRowCoverage(GROUPS, Object.fromEntries(['collect', 'destroy', 'reuse'].map(group => [group, parityRunners('worker-reboot', 'R43')])), 'worker-reboot-', 'worker-reboot-parity.testkit.ts');
});
