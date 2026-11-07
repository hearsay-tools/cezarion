import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { PiRunner } from '../core/pi-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('pi', () => new PiRunner()));

// The wait list's process-wait cells on the pi wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'pi', part: 'process' });
