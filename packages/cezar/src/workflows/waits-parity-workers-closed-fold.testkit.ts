import { waitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { closedCells } from './waits-parity-closed-cells.testkit.ts';

// The every-runner rows of the parts in the workers-closed fold (`WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`): a runner
// outside the shared set runs them from one file (hearsay-tools/cezarion#2991, hearsay-tools/cezarion#3242).
export const describeWaitParity = waitFoldDescriber('workers-closed', { closed: closedCells });
