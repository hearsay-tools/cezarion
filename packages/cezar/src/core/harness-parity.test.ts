import { describeHarnessParity } from './harness-parity-cells.testkit.ts';

// The harness parity matrix guard and its single-runner cells; each runner's RUNNER_IDS cells run
// from `harness-<runner>-parity.test.ts` (hearsay-tools/cezarion#1288).
describeHarnessParity('once');
