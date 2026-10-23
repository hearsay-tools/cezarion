import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// The wait list's process-wait cells on the pi wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'pi', part: 'process' });
