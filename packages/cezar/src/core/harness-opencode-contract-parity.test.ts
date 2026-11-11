import { describeHarnessParity } from './harness-parity-contract.cells.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';

useRunners(onlyRunner('opencode', () => new OpencodeServerRunner()));

describeHarnessParity({ runner: 'opencode', part: 'contract' });
