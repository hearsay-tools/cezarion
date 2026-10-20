import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// Shard 3 of 3 of the wait list's RUNNER_IDS cells (hearsay-tools/cezarion#1301).
describeWaitParity(2, 3);
