import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { PiRunner } from '../core/pi-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('pi', () => new PiRunner()));

// pi is outside the shared runner set: it runs only the wait rows that run on every runner, and all
// their parts from this one file (hearsay-tools/cezarion#2991).
describeWaitParity({ runner: 'pi', part: 'every-runner' });
