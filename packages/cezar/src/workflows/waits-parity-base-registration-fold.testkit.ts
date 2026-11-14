import { waitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { deadlineCells } from './waits-parity-deadlines-cells.testkit.ts';
import { processCells } from './waits-parity-process-cells.testkit.ts';
import { registrationCells } from './waits-parity-registration-cells.testkit.ts';

// The every-runner rows of the parts in the base-registration fold (`WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`): a runner
// other than the scenario runner runs them from one file (hearsay-tools/cezarion#2991, hearsay-tools/cezarion#3242).
export const describeWaitParity = waitFoldDescriber('base-registration', { registration: registrationCells, process: processCells, deadlines: deadlineCells });
