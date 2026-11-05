/** Getter/alias/helper compile proof; runtime reflection is checked by the encapsulation tests. */
import type { ActiveRun } from '../../../packages/cezar/src/workflows/active-run.ts';
import type { WaitGroup } from '../../../packages/cezar/src/workflows/run/wait-registry.ts';
declare const state: ActiveRun;
declare const other: ActiveRun;
// @ts-expect-error The migrated slot cannot be replaced.
state.waitIdentity = other.waitIdentity;
// @ts-expect-error Computed access cannot replace the slot.
state['waitIdentity'] = other.waitIdentity;
// @ts-expect-error Required read-only slots cannot be deleted.
delete state.waitIdentity;
const alias = state.waitIdentity;
// @ts-expect-error The group exposes getters, not writable storage.
alias.ciTurnId = undefined;
// @ts-expect-error Increment requires a setter.
alias.ciTurnId++;
const { waitIdentity: view } = state;
// @ts-expect-error Destructuring grants no mutation capability.
view['ciTurnId'] = undefined;
declare const helper: Parameters<(group: WaitGroup) => void>[0];
// @ts-expect-error A typed helper cannot write through a getter.
helper.ciTurnId = undefined;
