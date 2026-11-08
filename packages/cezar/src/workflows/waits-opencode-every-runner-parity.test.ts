import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { OpencodeServerRunner } from '../core/opencode-server-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('opencode', () => new OpencodeServerRunner()));

// opencode is outside the shared runner set: it runs only the wait rows that run on every runner, and all
// their parts from this one file (hearsay-tools/cezarion#2991).
describeWaitParity({ runner: 'opencode', part: 'every-runner' });
