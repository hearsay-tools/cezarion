import { describeHarnessParity } from './harness-parity-owned-workflows.cells.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { CursorRunner } from './cursor-runner.ts';
import { onlyRunners, useRunners } from './runners-under-test.testkit.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in RUNNER_IDS.
useRunners(onlyRunners({ pi: () => new PiRunner(), cursor: options => new CursorRunner(options) }));

describeHarnessParity({ runner: 'pi', part: 'owned-workflows' });
