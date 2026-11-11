import { describeHarnessParity } from './harness-parity-owned-workflows.cells.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { PiRunner } from './pi-runner.ts';
import { onlyRunners, useRunners } from './runners-under-test.testkit.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in RUNNER_IDS.
useRunners(onlyRunners({ opencode: () => new OpencodeServerRunner(), pi: () => new PiRunner() }));

describeHarnessParity({ runner: 'opencode', part: 'owned-workflows' });
