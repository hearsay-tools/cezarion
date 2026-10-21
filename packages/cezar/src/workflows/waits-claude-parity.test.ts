import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// The wait list's RUNNER_IDS base cells on the claude wire (hearsay-tools/cezarion#1301, hearsay-tools/cezarion#1288).
describeWaitParity({ runner: 'claude', part: 'base' });
