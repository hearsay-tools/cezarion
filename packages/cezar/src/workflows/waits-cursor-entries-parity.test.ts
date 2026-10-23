import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// The wait list's RUNNER_IDS turn-end entry cells on the cursor wire (hearsay-tools/cezarion#1525).
describeWaitParity({ runner: 'cursor', part: 'entries' });
