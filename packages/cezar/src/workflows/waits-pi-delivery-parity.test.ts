import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { PiRunner } from '../core/pi-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('pi', () => new PiRunner()));

describeWaitParity({ runner: 'pi', part: 'delivery' });
