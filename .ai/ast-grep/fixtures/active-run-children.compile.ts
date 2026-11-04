/** Compile with the same pinned tsc flags as active-run-usage.compile.ts. */
import type { ActiveRun } from '../../../packages/cezar/src/workflows/active-run.ts';
import type { ChildrenGroup } from '../../../packages/cezar/src/workflows/run/subagent-waits.ts';
declare const state: ActiveRun;
declare const other: ActiveRun;
// @ts-expect-error A migrated slot cannot be replaced through bracket access.
state['children'] = other.children;
const { backgroundChildren: children } = state.children;
// @ts-expect-error A read facade has no Map.set.
children.set('forged', { session: undefined, status: 'running' });
// @ts-expect-error Map values are read-only too.
children.get('child')!.status = 'failed';
// @ts-expect-error A nested session reference cannot be replaced.
children.get('child')!.session = undefined;
function helper(view: ChildrenGroup): void {
  // @ts-expect-error Passing a view to a helper does not grant mutation.
  view.backgroundChildren.clear();
}
void helper;
