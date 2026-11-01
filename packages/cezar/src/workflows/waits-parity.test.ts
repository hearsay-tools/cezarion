import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { subagentGuard } from './waits-subagents-parity-cells.testkit.ts';

// The wait list's criteria guard and single-runner cells; each runner's RUNNER_IDS cells run from
// `waits-<runner>-parity.test.ts` (hearsay-tools/cezarion#1301).
describeWaitParity('once');
// The native subagent cells run from `waits-<runner>-subagents-parity.test.ts` (hearsay-tools/cezarion#2431).
subagentGuard(runner => `waits-${runner}-subagents-parity.test.ts`);
