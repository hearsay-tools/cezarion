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
import type { RunRecord, RunStatus, StepState } from '@open-mercato/cezar-contract';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/usage-limit-hold';

/** The fields a write that applies a run exit patches beside it: never the status, which the exit
 *  writes (`RunStore.move`). */
export type RunPatch = Partial<Omit<RunRecord, 'id' | 'steps' | 'status' | 'waits' | 'lastWaits'>> & { status?: never; waits?: never; lastWaits?: never };

/** What a caller names beside an exit's extras: the step the exit settles apart from the others,
 *  and the text of the lifecycle event the exit writes, when the caller's says more. */
export type ExitCall = { stepId?: string | undefined; event?: string | undefined };

/** What an exit reads beside the record: one time for every field it stamps, and the step the
 *  caller names. */
export type ExitSettlement = ExitCall & { now: string };

/** What an exit's `steps` read beside the step: the time the run settles at, and the error it
 *  keeps. */
export type StepSettlement = ExitSettlement & { finishedAt: string; error?: string | undefined };

/** How a write that applies an exit persists: `committed` at once, or `debounced` to the next save,
 *  which is best-effort, so a locked database cannot stop cleanup (Decision 4). */
export type ExitDurability = 'debounced' | 'committed';

/** What an exit's `fields` and `steps` read off the record a write applies it to. */
export type ExitRead = Pick<RunRecord, 'status' | 'delegation'> & Partial<Pick<RunRecord, 'finishedAt' | 'currentStepId' | 'error'>> & { steps?: readonly StepState[] };

/**
 * One kind of status write: the statuses it may leave from and the one it writes. `fields` are
 * the fields every site of the exit writes alike; a caller's extras override them. `steps` settles
 * each step of the run in the same write (Table B targets B5, B8, B10, B11). `event` is the
 * lifecycle event the store writes once, when the exit moves a run into its status (B12). A guarded exit
 * declares a `guard`, a `settle`, or both: the store commits it at once, with the record `settle`
 * returns (the store writes the exit's fields and `to` over it). Its `guard` decides whether the run may take it: a failed guard writes nothing, and the store
 * returns undefined, or throws `refused` when the exit names one. `durability` is how a write that
 * applies the exit persists, unless a rule raises it (`exitDurability`); a guarded exit commits.
 */
export type RunExitSpec = {
  from: readonly RunStatus[];
  to: RunStatus;
  durability: ExitDurability;
  fields?: (run: ExitRead, at: ExitSettlement) => RunPatch;
  steps?: (step: StepState, run: ExitRead, at: StepSettlement) => StepState;
  event?: string;
  guard?: (run: RunRecord) => boolean;
  refused?: string;
  settle?: (run: RunRecord, at: ExitSettlement) => RunRecord;
};

/** A record that may still carry `activity`, a legacy key the load-time upgrade reads
 *  (`LEGACY_WAIT_KEYS`, legacy-waits.ts); a root Finish and a released park clear it. */
type WithLegacyActivity = RunRecord & { activity?: undefined };

/** A root that holds a pending Finish intent. */
const rootFinishPending = (run: RunRecord) => run.delegation?.role === 'root' && !!run.delegation.finishRequestedAt;

/** The root's pending Finish intent, retired as a patch (SRF): nothing when the run holds none. */
export function retiredFinishPatch(run: Pick<RunRecord, 'delegation'>): Pick<RunPatch, 'delegation'> {
  if (run.delegation?.role !== 'root' || !run.delegation.finishRequestedAt) return {};
  const { finishRequestedAt: _intent, ...delegation } = run.delegation;
  return { delegation };
}

/** The statuses a run settles at. `review` is one, though not final: a settled turn rests there. */
const SETTLED_STATUSES: readonly RunStatus[] = ['done', 'review', 'failed', 'cancelled'];

/** Whether `exit` settles a run: it writes done, review, failed or cancelled. */
export function settlesRun(exit: RunExitId): boolean {
  return SETTLED_STATUSES.includes(RUN_EXITS[exit].to);
}

/**
 * What every settling exit writes over its caller's extras (Table B targets): a settled run points
 * at no step, and a root's Finish intent means nothing once the run settled (B1-B3). Its first
 * settlement time is the fact, so a later write on a settled run keeps it (B4); else it settles at
 * the time `write` names (a site whose steps settled at that time passes it), else now.
 */
const settledRun = (run: ExitRead, write: RunPatch, { now }: ExitSettlement): RunPatch =>
  ({ ...retiredFinishPatch(run), currentStepId: undefined, finishedAt: run.finishedAt ?? write.finishedAt ?? now });

/** The legacy `activity` cleared: a key no patch type takes (`WithLegacyActivity`). */
const CLEARED_ACTIVITY = { activity: undefined } as RunPatch;

/** A run that succeeded: its resume counter and the legacy `activity` retired. A run that got all
 *  the way to a settled turn is not in a usage-limit loop, so its resume counter starts over
 *  instead of creeping toward the cap. */
const succeeded = (): RunPatch => ({ autoResumeAttempts: undefined, ...CLEARED_ACTIVITY });

/** A step that is running or waiting. */
const openStep = (step: StepState) => step.status === 'running' || step.status === 'waiting';

/** A run that succeeded settles its running and waiting steps done at its time (B5). A worker's
 *  incomplete earlier step, the one the caller names, stays waiting: a parent resume re-enters it
 *  (hearsay-tools/cezarion#1620). */
const succeededStep = (step: StepState, _run: ExitRead, { finishedAt, stepId }: StepSettlement): StepState =>
  openStep(step) && step.id !== stepId ? { ...step, status: 'done', finishedAt: step.finishedAt ?? finishedAt } : step;

/** A cancelled run has no live step (B10): its running and waiting steps settle cancelled at the
 *  run's time. */
const cancelledStep = (step: StepState, _run: ExitRead, { finishedAt }: StepSettlement): StepState =>
  openStep(step) ? { ...step, status: 'cancelled', finishedAt: step.finishedAt ?? finishedAt } : step;

/** A failed run has no live step (B11): its running steps fail at the run's time, each keeping an
 *  error of its own, else taking the run's. A waiting step stays waiting: it is the cursor a
 *  Continue resumes, a root's (`settleIncompleteStep`) and an owned worker's alike
 *  (hearsay-tools/cezarion#1620). */
const failedStep = (step: StepState, _run: ExitRead, { finishedAt, error }: StepSettlement): StepState =>
  step.status === 'running' ? { ...step, status: 'failed', finishedAt: step.finishedAt ?? finishedAt, error: step.error ?? error } : step;

/** A park settles its step waiting in the same write (B8): the step the caller names, else the
 *  run's current step. A step that already ended (a failed attempt a park keeps for its wakes)
 *  stays as it is. */
const parkedStep = (step: StepState, run: ExitRead, { stepId }: StepSettlement): StepState =>
  step.id === (stepId ?? run.currentStepId) && (step.status === 'running' || step.status === 'pending') ? { ...step, status: 'waiting' } : step;

/** A released park: the legacy `activity` cleared. */
function settleParkRelease(run: RunRecord): RunRecord {
  const settled: WithLegacyActivity = { ...run, activity: undefined };
  return settled;
}

/** The lifecycle event of a cancellation: one for each run a cancel exit moves into cancelled (B12). */
export const RUN_CANCELLED = 'run cancelled';

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
  park: { durability: 'debounced', from: ['running', 'queued', 'waiting'], to: 'waiting', steps: parkedStep },
  // A park that gives up its slot (hearsay-tools/cezarion#1235): committed at once, so a refused
  // write throws with nothing changed and the caller keeps the slot.
  'park-release': { durability: 'committed', from: ['running', 'queued', 'waiting'], to: 'waiting', settle: settleParkRelease, steps: parkedStep },
  'park-for-wake': { durability: 'debounced', from: ['queued', 'waiting'], to: 'waiting' },
  hold: { durability: 'debounced', from: ['failed', 'waiting'], to: 'waiting', fields: () => ({ finishedAt: undefined }) },
  // A provider error or usage limit holds the failing run in its failure's own write
  // (hearsay-tools/squawk#3337): never a transient `failed` a worker cascade or a parent's wait reads.
  'hold-failure': { durability: 'debounced', from: ['running', 'waiting'], to: 'waiting', fields: () => ({ finishedAt: undefined }), steps: failedStep },
  resume: { durability: 'debounced', from: ['waiting'], to: 'running' },
  succeed: { durability: 'debounced', from: ['running', 'waiting'], to: 'done', fields: succeeded, steps: succeededStep },
  'succeed-review': { durability: 'debounced', from: ['running', 'waiting'], to: 'review', fields: succeeded, steps: succeededStep },
  // A root's durable Finish: a concurrent explicit cancellation is never overwritten.
  'succeed-root': { durability: 'committed', from: ['waiting'], to: 'done', guard: rootFinishWaiting, fields: succeeded, steps: succeededStep },
  'succeed-root-review': { durability: 'committed', from: ['waiting'], to: 'review', guard: rootFinishWaiting, fields: succeeded, steps: succeededStep },
  'accept-review': { durability: 'debounced', from: ['review'], to: 'done' },
  // Draft PR (`POST /runs/:id/pr`): the cockpit offers it on review and on settled runs, so a
  // settled run that is published reads done too. The route refuses a usage-limit hold (spec B13).
  'draft-pr': { durability: 'debounced', from: ['review', 'done', 'failed', 'cancelled'], to: 'done' },
  'fail-start': { durability: 'debounced', from: ['queued', 'running'], to: 'failed', steps: failedStep },
  fail: { durability: 'debounced', from: ['running', 'waiting'], to: 'failed', steps: failedStep },
  // settleFailedContinuation alone: a worker Stop can record cancelled before it settles.
  'fail-continue': { durability: 'debounced', from: ['running', 'waiting', 'cancelled'], to: 'failed', steps: failedStep },
  'fail-interrupted': { durability: 'debounced', from: ['queued', 'running', 'waiting'], to: 'failed',
    fields: () => ({ error: 'interrupted — cezar process exited during the run' }), steps: failedStep },
  'fail-crash': { durability: 'debounced', from: ['queued', 'running', 'waiting'], to: 'failed', steps: failedStep },
  // A crash right after the withdrawal must not find it on disk (hearsay-tools/cezarion#1236).
  'withdraw-hold': { durability: 'committed', from: ['waiting'], to: 'failed', guard: isUsageLimitHold,
    settle: run => ({ ...run, autoResumeAt: undefined, autoResumeAttempts: undefined, autoResumeReason: undefined }), steps: failedStep },
  cancel: { durability: 'debounced', from: ['queued', 'running', 'waiting'], to: 'cancelled', steps: cancelledStep, event: RUN_CANCELLED },
  // Cancellation supersedes a root's pending Finish; from cancelled it repairs a snapshot an older
  // controller left with the intent.
  'cancel-root': { durability: 'committed', from: ['waiting', 'cancelled'], to: 'cancelled',
    guard: run => (run.status === 'waiting' || run.status === 'cancelled') && rootFinishPending(run), steps: cancelledStep, event: RUN_CANCELLED },
  // Must hit disk before queued no-start evidence authorizes cleanup.
  // A settled worker keeps its status (hearsay-tools/squawk#1907); a settled status here is a run still in
  // the line, or a Continue that failed after the Stop, whose execution then ends.
  'stop-worker': { durability: 'committed', from: ['queued', 'running', 'waiting', 'review', 'done', 'failed'], to: 'cancelled',
    guard: run => run.delegation?.role === 'worker', refused: 'Worker not found', steps: cancelledStep, event: RUN_CANCELLED },
  // A Stop that lands after the run settled. A Stop accepted before an exit (`stopping` on load)
  // can meet any status, as the engine's late Stop can.
  'cancel-late': { durability: 'debounced', from: ['queued', 'running', 'waiting', 'done', 'review', 'failed'], to: 'cancelled', steps: cancelledStep, event: RUN_CANCELLED },
} as const satisfies Record<string, RunExitSpec>;
export type RunExitId = keyof typeof RUN_EXITS;

/** The lifecycle event a write that applies `exit` to a run at `from` writes: the exit's `event`,
 *  or the caller's text for it, when the exit moves the run into its status. A repeated write on a
 *  run already there writes none, so one cancellation reads as one event (B12). */
export function exitEvent(exit: RunExitId, from: RunStatus, call: ExitCall = {}): string | undefined {
  const spec: RunExitSpec = RUN_EXITS[exit];
  return spec.event && from !== spec.to ? call.event ?? spec.event : undefined;
}

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

/** Report run-exit and wait-phase violations without interrupting the write.
 * Strict mode records them for the test setup; production warns once per violation. */
export function reportStoreViolation(message: string): void {
  if (strict) violations.push(message);
  else console.warn(message);
}

function checkFrom(exit: RunExitId, from: RunStatus | undefined): void {
  const spec = RUN_EXITS[exit];
  if (from === undefined || from === spec.to || (spec.from as readonly RunStatus[]).includes(from)) return;
  reportStoreViolation(`undeclared run transition: exit ${exit} from ${from} (declare it in runs/run-exits.ts)`);
}

/** The fields a write that applies `exit` writes: `extras`, the steps it settles and the exit's
 *  status. */
export type ExitWrite<E extends RunExitId> = Omit<RunPatch, 'status'> & { steps?: StepState[]; status: (typeof RUN_EXITS)[E]['to'] };

/**
 * Apply `exit` to `run`, a record in hand: check its status against the exit's `from` and return
 * the fields to write: the exit's `fields`, then `extras` over them, then what a settling exit
 * writes on every run (`settledRun`), then the steps its `steps` changed, then the exit's status. It
 * neither runs a guard nor a guarded `settle`: a caller of a guarded exit checks its guard itself.
 * `RunStore.move` writes through it, and the store's load-time and archive writers assign its
 * result onto the record they change.
 */
export function applyExit<E extends RunExitId>(run: ExitRead, exit: E, extras: RunPatch = {}, call: ExitCall = {}): ExitWrite<E> {
  const spec: RunExitSpec = RUN_EXITS[exit];
  const at: ExitSettlement = { ...call, now: new Date().toISOString() };
  const patch = { ...spec.fields?.(run, at), ...extras };
  const write = { ...patch, ...(settlesRun(exit) ? settledRun(run, patch, at) : {}) };
  const settlement: StepSettlement = { ...at, finishedAt: write.finishedAt ?? at.now, error: write.error ?? run.error };
  const steps = spec.steps && run.steps ? settleSteps(run.steps, step => spec.steps!(step, run, settlement)) : undefined;
  return { ...write, ...(steps ? { steps } : {}), status: exitStatus(exit, run.status) };
}

/** `steps` with each settled by `settle`, or undefined when none changed. */
function settleSteps(steps: readonly StepState[], settle: (step: StepState) => StepState): StepState[] | undefined {
  const settled = steps.map(settle);
  return settled.some((step, index) => step !== steps[index]) ? settled : undefined;
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
