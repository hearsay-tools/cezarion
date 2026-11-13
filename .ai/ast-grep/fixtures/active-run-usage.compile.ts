/** Compiler half of the usage encapsulation gate (hearsay-tools/cezarion#2520).
 * Run with the pinned tsc: --noEmit --strict --skipLibCheck --target ES2024
 * --module NodeNext --allowImportingTsExtensions <this file>.
 * Object.assign/reflection remain legal TypeScript; the runtime proof covers them.
 */
import type { ActiveRun } from '../../../packages/cezar/src/workflows/active-run.ts';
import type { UsageGroup } from '../../../packages/cezar/src/workflows/run/usage-accounting.ts';

declare const state: ActiveRun;
declare const other: ActiveRun;
// @ts-expect-error A migrated group slot is read-only.
state.usage = other.usage;
// @ts-expect-error Bracket access cannot replace a migrated group slot.
state['usage'] = other.usage;
// @ts-expect-error A required read-only slot cannot be deleted.
delete state.usage;
const alias = state.usage;
// @ts-expect-error The group exposes no invocation setter.
alias.usageInvocation = undefined;
const invocation = alias.usageInvocation!;
// @ts-expect-error A nested getter cannot be assigned.
invocation.observed = true;
// @ts-expect-error Increment also requires a setter.
invocation.epoch++;
const { startedTurns: turns, recordedTurns } = invocation;
// @ts-expect-error Destructuring does not grant Set.add.
turns.add('forged');
// @ts-expect-error A read-only set has no clear operation.
recordedTurns.clear();
// @ts-expect-error Computed access does not grant Set.delete.
turns['delete']('forged');
const costs = alias.cumulativeSessionCost!;
// @ts-expect-error A live map view has no set operation.
costs.set('forged', 99);
// @ts-expect-error Map bracket access is read-only too.
costs['clear']();
declare const view: Parameters<(view: UsageGroup) => void>[0];
// @ts-expect-error Typed helper parameters have the same getter-only boundary.
view.usageInvocation!.observed = true;
// @ts-expect-error A helper cannot acquire a writable map.
view.cumulativeSessionCost!.set('forged', 99);
