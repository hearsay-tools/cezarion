import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// The wait list's RUNNER_IDS worker cells on the cursor wire (hearsay-tools/cezarion#1288).
describeWaitParity({ runner: 'cursor', part: 'workers' });
