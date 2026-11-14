import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { subagentGuard } from './waits-subagents-parity-cells.testkit.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

// The single-runner cells drive the Claude wire.
useRunners(onlyRunner('claude', () => new ClaudeCliRunner()));

// The wait list's criteria guard and single-runner cells; each runner's RUNNER_IDS cells run from
// the semantic part files in `WAIT_PARITY_FILES` and the fold files in `WAIT_FOLDS` (hearsay-tools/cezarion#1301).
describeWaitParity('once');
// The native subagent cells run from `waits-<runner>-subagents-parity.test.ts` (hearsay-tools/cezarion#2431).
subagentGuard(runner => `waits-${runner}-subagents-parity.test.ts`);
