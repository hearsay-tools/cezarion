/** Getter/alias/helper compile proof; runtime reflection is checked by session-encapsulation.test.ts. */
import type { ActiveRun } from '../../../packages/cezar/src/workflows/active-run.ts';
import type { SessionGroup } from '../../../packages/cezar/src/workflows/run/live-session-state.ts';
declare const state: ActiveRun;
declare const other: ActiveRun;
// @ts-expect-error The migrated slot cannot be replaced.
state.liveSession = other.liveSession;
// @ts-expect-error Computed access cannot replace the slot.
state['liveSession'] = other.liveSession;
// @ts-expect-error Required read-only slots cannot be deleted.
delete state.liveSession;
const alias = state.liveSession;
// @ts-expect-error The group exposes getters, not writable handles.
alias.session = undefined;
// @ts-expect-error Increment requires a setter.
alias.ciGeneration++;
const { pendingPermissions: grants, delegationSettings: settings } = alias;
// @ts-expect-error The live view has no mutation capability.
grants.add('forged');
// @ts-expect-error Bracket access grants no mutation capability.
grants['clear']();
// @ts-expect-error Nested settings arrays are read-only.
settings!.allowedTools!.push('forged');
// @ts-expect-error Nested account data is read-only.
settings!.accountBinding!.claudeLayout!.kind = 'relocated';
declare const helper: Parameters<(group: SessionGroup) => void>[0];
// @ts-expect-error A typed helper cannot write through a getter.
helper.cwd = '/forged';
