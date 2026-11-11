import { describeHarnessParity } from './harness-parity-owned-workflows.cells.testkit.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { onlyRunners, useRunners } from './runners-under-test.testkit.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in RUNNER_IDS.
useRunners(onlyRunners({ codex: () => new CodexAppServerRunner(), opencode: () => new OpencodeServerRunner() }));

describeHarnessParity({ runner: 'codex', part: 'owned-workflows' });
