import { describeHarnessParity } from './harness-parity-owned-workflows.cells.testkit.ts';
import { OmpRunner } from './omp-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunners, useRunners } from './runners-under-test.testkit.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in RUNNER_IDS.
useRunners(onlyRunners({ omp: () => new OmpRunner(), claude: () => new ClaudeCliRunner() }));

describeHarnessParity({ runner: 'omp', part: 'owned-workflows' });
