import { describeWaitParity } from './waits-parity-entries-nudges-fold.testkit.ts';
import { PiRunner } from '../core/pi-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('pi', () => new PiRunner()));

// pi is outside the shared runner set: it runs only the wait rows that run on every runner. This file
// runs one group of their parts (WAIT_FOLDS in waits-parity-catalog.testkit.ts, hearsay-tools/cezarion#2991).
describeWaitParity({ runner: 'pi', part: 'every-runner', fold: 'entries-nudges' });
