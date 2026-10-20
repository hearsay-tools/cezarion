import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// The wait list's criteria guard and single-runner cells; each runner's RUNNER_IDS cells run from
// `waits-<runner>-parity.test.ts` (hearsay-tools/cezarion#1301).
describeWaitParity('once');
