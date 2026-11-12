import { waitFoldDescriber } from './waits-parity-fixture.testkit.ts';
import { answersCells } from './waits-parity-answers-cells.testkit.ts';
import { asksCells } from './waits-parity-asks-cells.testkit.ts';
import { doneCells } from './waits-parity-done-cells.testkit.ts';
import { inputCells } from './waits-parity-input-cells.testkit.ts';

// The every-runner rows of the parts in the base fold (`WAIT_FOLDS` in `waits-parity-catalog.testkit.ts`): a runner
// outside the shared set runs them from one file (hearsay-tools/cezarion#2991, hearsay-tools/cezarion#3242).
export const describeWaitParity = waitFoldDescriber('base', { input: inputCells, asks: asksCells, done: doneCells, answers: answersCells });
