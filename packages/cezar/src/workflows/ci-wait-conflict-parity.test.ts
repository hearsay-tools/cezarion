import { it } from 'vitest';
import { parityRunners } from '../core/parity-classes.testkit.ts';
import { CONFLICT_ROWS, GROUPS } from './ci-wait-conflict-parity.testkit.ts';
import { expectWaitRowCoverage } from './wait-row-coverage.testkit.ts';

it('registers every ci-wait-conflict runner/family row exactly once', () => {
  expectWaitRowCoverage(GROUPS, Object.fromEntries(Object.entries(CONFLICT_ROWS).map(([mode, row]) => [mode, parityRunners('ci-wait-conflict', row)])), 'ci-wait-conflict-', 'ci-wait-conflict-parity.testkit.ts');
});
