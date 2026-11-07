import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { OpencodeServerRunner } from '../core/opencode-server-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('opencode', () => new OpencodeServerRunner()));

describeWaitParity({ runner: 'opencode', part: 'refusal' });
