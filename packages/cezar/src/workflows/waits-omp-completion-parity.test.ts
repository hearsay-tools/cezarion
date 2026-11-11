import { describeWaitParity } from './waits-parity-completion-cells.testkit.ts';
import { OmpRunner } from '../core/omp-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('omp', () => new OmpRunner()));

describeWaitParity({ runner: 'omp', part: 'completion' });
