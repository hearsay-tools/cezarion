import { it } from 'vitest';
import { parityRunners } from '../core/parity-classes.testkit.ts';
import { GROUPS } from './ci-wait-rerun-parity.testkit.ts';
import { expectWaitRowCoverage } from './wait-row-coverage.testkit.ts';

it('registers every ci-wait-rerun runner/family row exactly once', () => {
  expectWaitRowCoverage(GROUPS, { fresh: parityRunners('ci-wait-rerun', 'R85'), recovered: parityRunners('ci-wait-rerun', 'R85') }, 'ci-wait-rerun-', 'ci-wait-rerun-parity.testkit.ts');
});
