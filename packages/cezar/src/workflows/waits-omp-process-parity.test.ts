import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { OmpRunner } from '../core/omp-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('omp', () => new OmpRunner()));

// The wait list's process-wait cells on the omp wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'omp', part: 'process' });
