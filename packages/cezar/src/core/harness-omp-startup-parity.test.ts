import { describeHarnessParity } from './harness-parity-startup.cells.testkit.ts';
import { OmpRunner } from './omp-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';

useRunners(onlyRunner('omp', () => new OmpRunner()));

describeHarnessParity({ runner: 'omp', part: 'startup' });
