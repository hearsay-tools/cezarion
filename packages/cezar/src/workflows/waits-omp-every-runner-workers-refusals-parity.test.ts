import { describeWaitParity } from './waits-parity-workers-refusals-fold.testkit.ts';
import { OmpRunner } from '../core/omp-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('omp', () => new OmpRunner()));

// omp is not the scenario runner: it runs only the wait rows that run on every runner. This file
// runs one group of their parts (WAIT_FOLDS in waits-parity-catalog.testkit.ts, hearsay-tools/cezarion#2991).
describeWaitParity({ runner: 'omp', part: 'every-runner', fold: 'workers-refusals' });
