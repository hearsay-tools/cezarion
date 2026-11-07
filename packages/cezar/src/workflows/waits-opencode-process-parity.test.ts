import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { OpencodeServerRunner } from '../core/opencode-server-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('opencode', () => new OpencodeServerRunner()));

// The wait list's process-wait cells on the opencode wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'opencode', part: 'process' });
