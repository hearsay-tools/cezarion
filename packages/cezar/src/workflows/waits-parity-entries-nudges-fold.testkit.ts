import { waitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { entriesCells } from './waits-parity-entries-cells.testkit.ts';

// The every-runner rows of the parts in the entries-nudges fold (`WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`): a runner
// outside the shared set runs them from one file (hearsay-tools/cezarion#2991, hearsay-tools/cezarion#3242).
export const describeWaitParity = waitFoldDescriber('entries-nudges', { entries: entriesCells });
