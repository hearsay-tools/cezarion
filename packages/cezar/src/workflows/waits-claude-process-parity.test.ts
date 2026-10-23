import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// The wait list's process-wait cells on the claude wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'claude', part: 'process' });
