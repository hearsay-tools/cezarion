import { describeWaitParity } from './waits-parity-entries-cells.testkit.ts';
import { OmpRunner } from '../core/omp-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('omp', () => new OmpRunner()));

// The wait list's RUNNER_IDS turn-end entry cells on the omp wire (hearsay-tools/cezarion#1525).
describeWaitParity({ runner: 'omp', part: 'entries' });
