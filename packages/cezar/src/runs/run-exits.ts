/**
 * The run exit table (ADR 0056, .ai/specs/2026-11-03-run-store-owns-exits.md). An exit
 * (`RUN_EXITS`) is one kind of status write, with the statuses it may leave from. The trigger
 * rows in `workflows/run-states.ts` name the exit they take; this module imports nothing from
 * `workflows/`.
 *
 * The store writes every run status by applying an exit: `RunStore.move`, `applyExit` on a record
 * it reconciles at load or stages for archive, or the `exit` of `commitOutcome` and
 * `commitWorkerContinuation`. Each checks the status of the record its write
 * changes against the exit's `from` (`exitStatus`). An exit with `fields` settles them on every
 * write that applies it, under the caller's extras (slice S5). An exit with a `settle` is a guarded exit
 * (Decision 5): `RunStore.move` commits it at once, with the record `settle` returns, only when
 * its `guard` passes. An undeclared transition is written as before and reported as a violation;
 * nothing throws in the write path. Strict mode (`vitest.setup.ts`) records each violation, and
 * the test setup fails the test after it ran. Outside strict mode each violation is one
 * `console.warn` and nothing is recorded.
 */
import type { RunRecord, RunStatus } from '@open-mercato/cezar-contract';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';

/** The fields a write that applies a run exit patches beside it: never the status, which the exit
 *  writes (`RunStore.move`). */
export type RunPatch = Partial<Omit<RunRecord, 'id' | 'steps' | 'status'>> & { status?: never };

/** What a guarded exit's `settle` reads beside the record: one time for every field it stamps, and
 *  the step the caller names. */
export type ExitSettlement = { now: string; stepId?: string | undefined };

/** How a write that applies an exit persists: `committed` at once, or `debounced` to the next save,
 *  which is best-effort, so a locked database cannot stop cleanup (Decision 4). */
export type ExitDurability = 'debounced' | 'committed';

/** What an exit's `fields` read off the record a write applies it to. */
export type ExitRead = Pick<RunRecord, 'status' | 'delegation'>;

/**
 * One kind of status write: the statuses it may leave from and the one it writes. `fields` are
 * the fields every site of the exit writes alike; a caller's extras override them. A guarded exit
 * declares `settle` instead, the record it commits at once (the store writes `to` over its status).
 * Its `guard` decides whether the run may take it: a failed guard writes nothing, and the store
 * returns undefined, or throws `refused` when the exit names one. `durability` is how a write that
 * applies the exit persists, unless a rule raises it (`exitDurability`); a guarded exit commits.
 */
export type RunExitSpec = {
  from: readonly RunStatus[];
  to: RunStatus;
  durability: ExitDurability;
  fields?: (run: ExitRead, at: ExitSettlement) => RunPatch;
  guard?: (run: RunRecord) => boolean;
  refused?: string;
  settle?: (run: RunRecord, at: ExitSettlement) => RunRecord;
};

/** A record that may still carry `activity`, a legacy key the load-time upgrade reads
 *  (`LEGACY_WAIT_KEYS`, store.ts); a root Finish and a released park clear it. */
type WithLegacyActivity = RunRecord & { activity?: undefined };

/** A root that holds a pending Finish intent. */
const rootFinishPending = (run: RunRecord) => run.delegation?.role === 'root' && !!run.delegation.finishRequestedAt;

/** The root's pending Finish intent, retired as a patch (SRF): nothing when the run holds none. */
export function retiredFinishPatch(run: Pick<RunRecord, 'delegation'>): Pick<RunPatch, 'delegation'> {
  if (run.delegation?.role !== 'root' || !run.delegation.finishRequestedAt) return {};
  const { finishRequestedAt: _intent, ...delegation } = run.delegation;
  return { delegation };
}

/** A run settled now, its Finish intent retired. */
const settledNow = (run: ExitRead, { now }: ExitSettlement): RunPatch => ({ ...retiredFinishPatch(run), finishedAt: now });

/** A run settled now that also leaves its step. */
const settledOffStep = (run: ExitRead, at: ExitSettlement): RunPatch => ({ ...settledNow(run, at), currentStepId: undefined });

/** A run that succeeded: settled now, off its step, its resume counter and Finish intent retired.
 *  A run that got all the way to a settled turn is not in a usage-limit loop, so its resume
 *  counter starts over instead of creeping toward the cap. */
const succeededNow = (run: ExitRead, at: ExitSettlement): RunPatch => ({ ...settledOffStep(run, at), autoResumeAttempts: undefined });

/** The root's Finish intent, retired. */
const retiredFinish = (run: RunRecord): RunRecord => ({ ...run, ...retiredFinishPatch(run) });

/** A root Finish that succeeds: the intent retired, the run and its running or waiting steps
 *  settled at one time. */
function settleRootFinish(run: RunRecord, { now }: ExitSettlement): RunRecord {
  const settled: WithLegacyActivity = { ...retiredFinish(run), finishedAt: now, currentStepId: undefined, autoResumeAttempts: undefined, activity: undefined,
    steps: run.steps.map(step => step.status === 'waiting' || step.status === 'running'
      ? { ...step, status: 'done' as const, finishedAt: step.finishedAt ?? now } : step) };
  return settled;
}

/** A released park: the legacy `activity` cleared and the named step waiting. */
function settleParkRelease(run: RunRecord, { stepId }: ExitSettlement): RunRecord {
  const settled: WithLegacyActivity = { ...run, activity: undefined,
    ...(stepId ? { steps: run.steps.map(step => step.id === stepId ? { ...step, status: 'waiting' as const } : step) } : {}) };
  return settled;
}

const rootFinishWaiting = (run: RunRecord) => run.status === 'waiting' && rootFinishPending(run);

export const RUN_EXITS = {
  start: { durability: 'debounced', from: ['queued', 'running', 'waiting'], to: 'running' },
  'start-held': { durability: 'debounced', from: ['queued'], to: 'queued' },
  requeue: { durability: 'debounced', from: ['queued', 'running', 'failed'], to: 'queued', fields: () => ({ currentStepId: undefined }) },
  'continue-line': { durability: 'debounced', from: ['waiting', 'review', 'done', 'failed', 'cancelled'], to: 'queued',
    fields: () => ({ error: undefined, finishedAt: undefined, currentStepId: undefined }) },
  // The step it runs is the caller's: `currentStepId` is an extra.
  'continue-now': { durability: 'debounced', from: ['waiting', 'review', 'done', 'failed', 'cancelled'], to: 'running',
    fields: () => ({ error: undefined, finishedAt: undefined }) },
  park: { durability: 'debounced', from: ['running', 'queued', 'waiting'], to: 'waiting' },
  // A park that gives up its slot (hearsay-tools/cezarion#1235): committed at once, so a refused
  // write throws with nothing changed and the caller keeps the slot.
  'park-release': { durability: 'committed', from: ['running', 'queued', 'waiting'], to: 'waiting', settle: settleParkRelease },
  'park-for-wake': { durability: 'debounced', from: ['queued', 'waiting'], to: 'waiting' },
  hold: { durability: 'debounced', from: ['failed', 'waiting'], to: 'waiting', fields: () => ({ finishedAt: undefined }) },
  resume: { durability: 'debounced', from: ['waiting'], to: 'running' },
  succeed: { durability: 'debounced', from: ['running', 'waiting'], to: 'done', fields: succeededNow },
  'succeed-review': { durability: 'debounced', from: ['running', 'waiting'], to: 'review', fields: succeededNow },
  // A root's durable Finish: a concurrent explicit cancellation is never overwritten.
  'succeed-root': { durability: 'committed', from: ['waiting'], to: 'done', guard: rootFinishWaiting, settle: settleRootFinish },
  'succeed-root-review': { durability: 'committed', from: ['waiting'], to: 'review', guard: rootFinishWaiting, settle: settleRootFinish },
  // Sets no `finishedAt` (Table B6).
  'accept-review': { durability: 'debounced', from: ['review'], to: 'done', fields: retiredFinishPatch },
  // Draft PR (`POST /runs/:id/pr`): the cockpit offers it on review and on settled runs, so a
  // settled run that is published reads done too. A usage-limit hold is not declared (spec B13).
  'draft-pr': { durability: 'debounced', from: ['review', 'done', 'failed', 'cancelled'], to: 'done' },
  // Three sites keep `currentStepId` (Table B1); the others clear it in their extras.
  'fail-start': { durability: 'debounced', from: ['queued', 'running'], to: 'failed', fields: settledNow },
  fail: { durability: 'debounced', from: ['running', 'waiting'], to: 'failed', fields: settledOffStep },
  // settleFailedContinuation alone: a worker Stop can record cancelled before it settles.
  'fail-continue': { durability: 'debounced', from: ['running', 'waiting', 'cancelled'], to: 'failed', fields: settledOffStep },
  // Restart recovery sets `finishedAt` now and retires the Finish intent; the store's load-time
  // writer keeps an existing `finishedAt` and the intent (Table B4). Each passes its own.
  'fail-interrupted': { durability: 'debounced', from: ['queued', 'running', 'waiting'], to: 'failed',
    fields: () => ({ error: 'interrupted — cezar process exited during the run' }) },
  // Neither site clears `currentStepId` (Table B2).
  'fail-crash': { durability: 'debounced', from: ['queued', 'running', 'waiting'], to: 'failed', fields: settledNow },
  // A crash right after the withdrawal must not find it on disk (hearsay-tools/cezarion#1236).
  'withdraw-hold': { durability: 'committed', from: ['waiting'], to: 'failed', guard: isUsageLimitHold,
    settle: (run, { now }) => ({ ...run, autoResumeAt: undefined, autoResumeAttempts: undefined, finishedAt: now }) },
  // `finishedAt` and `currentStepId` stay with each site (Table B3, B4).
  cancel: { durability: 'debounced', from: ['queued', 'running', 'waiting'], to: 'cancelled' },
  // Cancellation supersedes a root's pending Finish; from cancelled it repairs a snapshot an older
  // controller left with the intent.
  'cancel-root': { durability: 'committed', from: ['waiting', 'cancelled'], to: 'cancelled',
    guard: run => (run.status === 'waiting' || run.status === 'cancelled') && rootFinishPending(run),
    settle: (run, { now }) => ({ ...retiredFinish(run), finishedAt: run.finishedAt ?? now }) },
  // Must hit disk before queued no-start evidence authorizes cleanup.
  'stop-worker': { durability: 'committed', from: ['queued', 'running', 'waiting', 'review', 'done', 'failed'], to: 'cancelled',
    guard: run => run.delegation?.role === 'worker', refused: 'Worker not found', settle: (run, { now }) => ({ ...run, finishedAt: now }) },
  // A Stop that lands after the run settled. A Stop accepted before an exit (`stopping` on load)
  // can meet any status, as the engine's late Stop can.
  'cancel-late': { durability: 'debounced', from: ['queued', 'running', 'waiting', 'done', 'review', 'failed'], to: 'cancelled' },
} as const satisfies Record<string, RunExitSpec>;
export type RunExitId = keyof typeof RUN_EXITS;

/** The record rule: a Done commits at once on a run with a completion option, because its
 *  completion action and archive must be durable (hearsay-tools/cezarion#2324). */
export function doneCommits(run: Pick<RunRecord, 'archiveWhenDone' | 'autoMergePr'>): boolean {
  return Boolean(run.archiveWhenDone || run.autoMergePr);
}

/**
 * How `RunStore.move` persists `exit` on `run`, the record before the write (Decision 4). First
 * match wins: the record rule (an exit to `done` on a run with a completion option commits), then
 * the exit's own `durability`. A rule only raises a debounced exit to committed. An exit applied
 * inside another commit (`resume` in `commitOutcome`, `continue-*` in `commitWorkerContinuation`)
 * commits with that commit, before either rule; the caller's extras never decide.
 */
export function exitDurability(exit: RunExitId, run: Pick<RunRecord, 'archiveWhenDone' | 'autoMergePr'>): ExitDurability {
  const spec: RunExitSpec = RUN_EXITS[exit];
  return spec.to === 'done' && doneCommits(run) ? 'committed' : spec.durability;
}

let strict = false;
/** Strict mode only: outside it nothing is recorded, so production keeps no growing list. */
const violations: string[] = [];

/** Tests only: `vitest.setup.ts` calls it, so a violation is recorded for `throwRunExitViolations`
 *  instead of logged. Returns the previous mode, so a test that changes it can put it back. */
export function strictRunExits(on = true): boolean {
  const previous = strict;
  strict = on;
  return previous;
}

/** The violations recorded since the last call. */
export function takeRunExitViolations(): string[] {
  return violations.splice(0);
}

/** Throws the violations recorded since the last call: the test setup runs it after each test. */
export function throwRunExitViolations(): void {
  const taken = takeRunExitViolations();
  if (taken.length) throw new Error(taken.join('\n'));
}

function violate(message: string): void {
  if (strict) violations.push(message);
  else console.warn(message);
}

function checkFrom(exit: RunExitId, from: RunStatus | undefined): void {
  const spec = RUN_EXITS[exit];
  if (from === undefined || from === spec.to || (spec.from as readonly RunStatus[]).includes(from)) return;
  violate(`undeclared run transition: exit ${exit} from ${from} (declare it in runs/run-exits.ts)`);
}

/** The fields a write that applies `exit` writes: `extras` and the exit's status. */
export type ExitWrite<E extends RunExitId> = Omit<RunPatch, 'status'> & { status: (typeof RUN_EXITS)[E]['to'] };

/**
 * Apply `exit` to `run`, a record in hand: check its status against the exit's `from` and return
 * the fields to write: the exit's `fields`, then `extras` over them, then the exit's status. It
 * neither runs a guard nor a guarded `settle`: a caller of a guarded exit checks its guard itself.
 * `RunStore.move` writes through it, and the store's load-time and archive writers assign its
 * result onto the record they change.
 */
export function applyExit<E extends RunExitId>(run: ExitRead, exit: E, extras: RunPatch = {}): ExitWrite<E> {
  const spec: RunExitSpec = RUN_EXITS[exit];
  return { ...spec.fields?.(run, { now: new Date().toISOString() }), ...extras, status: exitStatus(exit, run.status) };
}

/**
 * The status `exit` writes onto a run whose status is `from`. The store calls it inside the write
 * that applies the exit, with the record that write changes. It reports an exit that does not
 * leave from `from`, then returns the status all the same.
 */
export function exitStatus<E extends RunExitId>(exit: E, from: RunStatus): (typeof RUN_EXITS)[E]['to'] {
  checkFrom(exit, from);
  return RUN_EXITS[exit].to;
}
