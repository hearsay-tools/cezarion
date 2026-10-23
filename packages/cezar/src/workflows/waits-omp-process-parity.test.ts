import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// The wait list's process-wait cells on the omp wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'omp', part: 'process' });
