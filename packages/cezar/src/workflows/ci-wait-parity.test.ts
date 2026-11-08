import { it } from 'vitest';
import { parityRunners } from '../core/parity-classes.testkit.ts';
import { GROUPS } from './ci-wait-registration-parity.testkit.ts';
import { expectWaitRowCoverage } from './wait-row-coverage.testkit.ts';

it('registers every ci-wait runner/family row exactly once', () => {
  expectWaitRowCoverage(GROUPS, Object.fromEntries(['fresh', 'continued', 'recovered'].map(mode => [mode, parityRunners('ci-wait-registration', mode)])), 'ci-wait-', 'ci-wait-registration-parity.testkit.ts');
});
