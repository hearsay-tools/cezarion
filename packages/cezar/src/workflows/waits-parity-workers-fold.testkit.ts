import { waitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { conversationsCells } from './waits-parity-conversations-cells.testkit.ts';
import { mixedCells } from './waits-parity-mixed-cells.testkit.ts';
import { recoveryCells } from './waits-parity-recovery-cells.testkit.ts';

// The every-runner rows of the parts in the workers fold (`WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`): a runner
// other than the scenario runner runs them from one file (hearsay-tools/cezarion#2991, hearsay-tools/cezarion#3242).
export const describeWaitParity = waitFoldDescriber('workers', { mixed: mixedCells, recovery: recoveryCells, conversations: conversationsCells });
