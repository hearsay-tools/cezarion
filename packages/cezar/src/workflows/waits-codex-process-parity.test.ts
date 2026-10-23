import { describeWaitParity } from './waits-parity-cells.testkit.ts';

// The wait list's process-wait cells on the codex wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'codex', part: 'process' });
