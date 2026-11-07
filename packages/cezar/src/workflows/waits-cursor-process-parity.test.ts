import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { CursorRunner } from '../core/cursor-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('cursor', options => new CursorRunner(options)));

// The wait list's process-wait cells on the cursor wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'cursor', part: 'process' });
