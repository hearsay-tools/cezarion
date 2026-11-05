/** Compile proof for private input storage and live read-only nested values. */
import type { ActiveRun } from '../../../packages/cezar/src/workflows/active-run.ts';
import type { InputGroup, InputFlight } from '../../../packages/cezar/src/workflows/run/input-delivery.ts';
declare const state: ActiveRun;
declare const other: ActiveRun;
// @ts-expect-error A migrated group slot cannot be replaced.
state.inputState = other.inputState;
// @ts-expect-error Bracket access grants no write capability.
state['inputState'] = other.inputState;
// @ts-expect-error Required readonly slots cannot be deleted.
delete state.inputState;
const alias = state.inputState;
// @ts-expect-error Getter-only scalar.
alias.writingInput = true;
const { unreadInputIds: ids, agentInputFlight: flight, bundledInputIds: bundled } = alias;
// @ts-expect-error The live set has no mutation methods.
ids!.add('forged');
// @ts-expect-error Bracket access cannot mutate the live view.
ids!['clear']();
// @ts-expect-error Flight IDs are immutable.
flight!.inputIds.push('forged');
// @ts-expect-error Reservation writes belong to the owner module.
flight!.wakeReserved = true;
// @ts-expect-error Promise attachment belongs to the owner module.
flight!.settled = Promise.resolve();
// @ts-expect-error Bundled IDs are immutable.
bundled!.push('forged');
declare const helper: InputGroup;
// @ts-expect-error Typed helper cannot write a getter.
helper.openingAnswerAskSeq++;
declare const flightHelper: InputFlight;
// @ts-expect-error A typed flight helper cannot replace its session.
flightHelper.session = undefined;
