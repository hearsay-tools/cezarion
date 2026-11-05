/** Getter/alias/helper compile proof; runtime reflection is checked by the encapsulation tests. */
import type { ActiveRun } from '../../../packages/cezar/src/workflows/active-run.ts';
import type { AutosaveGroup } from '../../../packages/cezar/src/workflows/run/worktree-autosave.ts';
declare const state: ActiveRun;
declare const other: ActiveRun;
// @ts-expect-error The migrated slot cannot be replaced.
state.autosave = other.autosave;
// @ts-expect-error Computed access cannot replace the slot.
state['autosave'] = other.autosave;
// @ts-expect-error Required read-only slots cannot be deleted.
delete state.autosave;
const alias = state.autosave;
// @ts-expect-error The group exposes getters, not writable storage.
alias.autosaveTimer = undefined;
// @ts-expect-error Increment requires a setter.
alias.autosaveTimer++;
const { autosave: view } = state;
// @ts-expect-error Destructuring grants no mutation capability.
view['autosaveTimer'] = undefined;
declare const helper: Parameters<(group: AutosaveGroup) => void>[0];
// @ts-expect-error A typed helper cannot write through a getter.
helper.autosaveTimer = undefined;
