import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// Shard 1 of 3 of the wait list's RUNNER_IDS cells (hearsay-tools/cezarion#1301).
describeWaitParity(0, 3);
