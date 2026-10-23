import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// The wait list's RUNNER_IDS turn-end entry cells on the pi wire (hearsay-tools/cezarion#1525).
describeWaitParity({ runner: 'pi', part: 'entries' });
