import { describeHarnessParity } from './harness-parity-owned-workflows.cells.testkit.ts';
import { CursorRunner } from './cursor-runner.ts';
import { OmpRunner } from './omp-runner.ts';
import { onlyRunners, useRunners } from './runners-under-test.testkit.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in RUNNER_IDS.
useRunners(onlyRunners({ cursor: options => new CursorRunner(options), omp: () => new OmpRunner() }));

describeHarnessParity({ runner: 'cursor', part: 'owned-workflows' });
