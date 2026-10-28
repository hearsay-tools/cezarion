/**
 * Every run state, every exit out of it and every wait kind, as data (hearsay-tools/cezarion#1804).
 * This file is the Transitions out table of AGENTS.md § Case tables: a change that adds or changes
 * a run state declares its exits here first.
 *
 * Two levels. An exit (`RUN_EXITS`) is one kind of status write, with the statuses it may leave
 * from. A trigger row (`RUN_TRIGGERS`) is one event out of one state: who or what fires it, what
 * happens at shipped defaults, the exit it writes and the `run.ts` functions on its path. Many rows
 * end in one exit (`settleSuccess` serves `cezar_done`, Finish and an idle-closed worker).
 *
 * `run.ts` takes every run status it writes from `transition` or `transitionVia`. Outside strict
 * mode both return the declared status and do nothing else: no read, no log, no throw, so a
 * production write is the write it was. `vitest.setup.ts` turns strict mode on, so a test fails on
 * a write whose stored status the exit does not leave from.
 */
import type { RunRecord, RunStatus, Wait, WaitPhase } from '@open-mercato/cezar-contract';
import { computeWaitingOn } from '@open-mercato/cezar-contract/waits';

/** Who or what fires a trigger. `peer` is another root task of the project (hearsay-tools/cezarion#1995). */
export type FiredBy = 'human' | 'parent' | 'agent' | 'runner' | 'timer' | 'scheduler' | 'watcher'
  | 'worker' | 'peer' | 'recovery' | 'engine';
/** The actors that fire with no person and no restart behind them. */
export const AUTOMATIC: ReadonlySet<FiredBy> = new Set(['runner', 'timer', 'scheduler', 'watcher', 'worker', 'peer', 'engine']);

/** What a `waiting` run waits on: `computeWaitingOn`'s kinds (its `peers` is `peer` here), plus
 *  three cases it leaves out. */
export type Park = 'permission' | 'human' | 'usage-limit' | 'workers' | 'peer' | 'pr' | 'process' | 'timer'
  | 'capacity' | 'plain';
export type RunState = Exclude<RunStatus, 'waiting'> | `waiting:${Park}`;

export type RunStateSpec = {
  final: boolean;
  /** Why the state's only unconditional default exits are a person's. */
  humanOnly?: string;
  note?: string;
};

export const RUN_STATES: { readonly [S in RunState]: RunStateSpec } = {
  queued: { final: false, note: 'In the line, with no session: an unstarted run, a continuation or a workflow remainder. store:createRun writes the entry.' },
  running: {
    final: false,
    note: 'A turn is in progress and a live session holds a slot. Its automatic exits are the runner ending the turn, failing or exiting; a provider that hangs and stays alive stays running until a person stops it, because no turn timeout ships.',
  },
  'waiting:permission': { final: false, humanOnly: 'Authorization is the user\'s, also for an owned worker. No permission timeout ships.' },
  'waiting:human': {
    final: false,
    humanOnly: 'A question is the user\'s own gate (unified-waits phase 2a): only a person answers it, or the parent for a worker\'s routed question. Cezar\'s no-wait, budget and completion waits wait for the user the same way.',
    note: 'One sub-case has no automatic exit even conditionally: a root on Cezar\'s completion human wait with every worker settled and only uncollected results left (phase 3b).',
  },
  'waiting:usage-limit': { final: false, note: 'A usage-limit hold: no session and no slot until the resume time.' },
  'waiting:workers': { final: false, note: 'No slot; the idle timer is armed.' },
  'waiting:peer': { final: false, note: 'Named peer root tasks (hearsay-tools/cezarion#1995). No slot; the idle timer is armed. The deadline (1 to 1,800 s) is its automatic exit.' },
  'waiting:pr': { final: false, note: 'Keeps a slot in the monitoring pool.' },
  'waiting:process': { final: false, note: 'Keeps a slot in the monitoring pool.' },
  'waiting:timer': { final: false, note: 'Keeps a slot in the monitoring pool.' },
  'waiting:capacity': { final: false, note: 'A resolved wait or a message is owed, and no slot is free yet.' },
  'waiting:plain': {
    final: false,
    humanOnly: 'No wait is open and nothing is owed: an earlier workflow step closed without done, an autonomous nudge idle-closed, or the wake budget is spent. Only a Continue or a message resumes a root.',
    note: 'Unlike unified-waits phase 3b, an owned worker parked here settles done after 15 minutes idle (parkForUser arms the idle timer, settleIdleClosedWorker settles it).',
  },
  review: {
    final: false,
    humanOnly: 'The review gate: Cezar never merges or finishes a reviewed task by itself. The gate is off by default (hearsay-tools/cezarion#489), so no run reaches review at shipped defaults.',
  },
  done: { final: true },
  failed: { final: true },
  cancelled: { final: true },
};

/** The status of a state. */
export function statusOf(state: RunState): RunStatus {
  return state.startsWith('waiting:') ? 'waiting' : state as RunStatus;
}

/** One kind of status write: the statuses it may leave from and the one it writes. */
export const RUN_EXITS = {
  start: { from: ['queued', 'running', 'waiting'], to: 'running' },
  'start-held': { from: ['queued'], to: 'queued' },
  requeue: { from: ['queued', 'running', 'failed'], to: 'queued' },
  'continue-line': { from: ['waiting', 'review', 'done', 'failed', 'cancelled'], to: 'queued' },
  'continue-now': { from: ['waiting', 'review', 'done', 'failed', 'cancelled'], to: 'running' },
  park: { from: ['running', 'queued', 'waiting'], to: 'waiting' },
  'park-for-wake': { from: ['queued', 'waiting'], to: 'waiting' },
  hold: { from: ['failed', 'waiting'], to: 'waiting' },
  resume: { from: ['waiting'], to: 'running' },
  succeed: { from: ['running', 'waiting'], to: 'done' },
  'succeed-review': { from: ['running', 'waiting'], to: 'review' },
  'accept-review': { from: ['review'], to: 'done' },
  'fail-start': { from: ['queued', 'running'], to: 'failed' },
  fail: { from: ['running', 'waiting'], to: 'failed' },
  // settleFailedContinuation alone: a worker Stop can record cancelled before it settles.
  'fail-continue': { from: ['running', 'waiting', 'cancelled'], to: 'failed' },
  'fail-interrupted': { from: ['queued', 'running', 'waiting'], to: 'failed' },
  'fail-crash': { from: ['queued', 'running', 'waiting'], to: 'failed' },
  'withdraw-hold': { from: ['waiting'], to: 'failed' },
  cancel: { from: ['queued', 'running', 'waiting'], to: 'cancelled' },
  'stop-worker': { from: ['queued', 'running', 'waiting', 'review', 'done', 'failed'], to: 'cancelled' },
  'cancel-late': { from: ['queued', 'running', 'waiting', 'done', 'review', 'failed'], to: 'cancelled' },
} as const satisfies Record<string, { from: readonly RunStatus[]; to: RunStatus }>;
export type RunExitId = keyof typeof RUN_EXITS;

export type TriggerRow = {
  /** `<state group>.<event>`, unique. */
  id: string;
  states: readonly RunState[];
  trigger: string;
  firedBy: FiredBy;
  /** A condition on the run. A row with one never counts as the state's automatic exit. */
  when?: string;
  /** Behavior at shipped defaults. */
  behavior: string;
  /** Null: no status write (a nudge is sent, the session closes). */
  exit: RunExitId | null;
  /** The states it reaches, or `same`: it does not leave the state. */
  to: readonly RunState[] | 'same';
  /** The `run.ts` functions on its path; `store:` and `server:` name a writer outside `run.ts`. */
  via: readonly string[];
  /** The existing test that drives the row. */
  pinnedBy?: { file: string; test: string };
};

const PARKS = ['waiting:permission', 'waiting:human', 'waiting:usage-limit', 'waiting:workers', 'waiting:peer', 'waiting:pr',
  'waiting:process', 'waiting:timer', 'waiting:capacity', 'waiting:plain'] as const satisfies readonly RunState[];
const parksBut = (...left: RunState[]): RunState[] => PARKS.filter((park) => !left.includes(park));
const MONITORING = ['waiting:pr', 'waiting:process', 'waiting:timer'] as const satisfies readonly RunState[];
const ENGINE_OWNED = ['queued', 'running', ...parksBut('waiting:usage-limit')] as const satisfies readonly RunState[];
const CONTINUABLE = [...parksBut('waiting:usage-limit'), 'review', 'done', 'failed', 'cancelled'] as const satisfies readonly RunState[];

export const RUN_TRIGGERS: readonly TriggerRow[] = [
  // queued
  { id: 'queued.start', states: ['queued'], trigger: 'A regular slot frees, the account has no usage-limit hold and no parent finish is pending', firedBy: 'scheduler', behavior: 'running', exit: 'start', to: ['running'], via: ['pump', 'startExecution', 'runWorkflowSteps', 'startContinuationStep'] },
  { id: 'queued.start-held', states: ['queued'], trigger: 'A resumed workflow is dequeued before its next step', firedBy: 'scheduler', when: 'a workflow remainder', behavior: 'Stays queued until the step loop enters the step', exit: 'start-held', to: 'same', via: ['startExecution'], pinnedBy: { file: 'workflows/run.test.ts', test: 'preserves startedAt when a resumed workflow remainder is held and requeued' } },
  { id: 'queued.fail-start', states: ['queued'], trigger: 'Admission or launch fails before a session: the execution checkpoint, a lost workflow, the worktree, the Cursor session identity, the owned workspace, the model or the temp directory', firedBy: 'engine', when: 'the launch fails', behavior: 'failed with the error', exit: 'fail-start', to: ['failed'], via: ['pump', 'reviveQueuedRun', 'createExecutionWorktree', 'ownedContinuationWorkspace', 'failContinuationBeforeSpawn'] },
  { id: 'queued.crash', states: ['queued'], trigger: 'The engine throws while it starts the run', firedBy: 'engine', when: 'the engine throws', behavior: 'failed (engine crashed, continue crashed)', exit: 'fail-crash', to: ['failed'], via: ['pump', 'admitContinuation', 'failCrashedContinuation'] },
  { id: 'queued.wake', states: ['queued'], trigger: 'A wake is owed and no session exists', firedBy: 'watcher', when: 'a wait resolves or a message arrives', behavior: 'waiting, then the scheduler continuation queues it again', exit: 'park-for-wake', to: ['waiting:capacity'], via: ['queueWaitWake'] },
  { id: 'queued.stop', states: ['queued'], trigger: 'Stop, delete, or the root\'s terminal path for an owned worker', firedBy: 'human', behavior: 'cancelled', exit: 'cancel', to: ['cancelled'], via: ['cancel', 'startExecution', 'settleStoppedContinuation', 'acquireContinuationRepoRoot', 'settleContinuationPrelaunchCancel', 'persistWorkerCompletion'] },
  { id: 'queued.orphaned', states: ['queued'], trigger: 'A store settles an untouched queued run whose process is gone', firedBy: 'recovery', behavior: 'cancelled', exit: 'cancel', to: ['cancelled'], via: ['store:settleOrphanedRun'] },
  { id: 'queued.restart', states: ['queued'], trigger: 'Restart', firedBy: 'recovery', behavior: 'Queued again as it was; a workflow that cannot be read fails (queued.fail-start)', exit: null, to: 'same', via: ['recoverLiveRun', 'reviveQueuedRun'] },
  // running
  { id: 'running.park-monitoring', states: ['running'], trigger: 'The turn ends with an open pr, process or timer wait', firedBy: 'runner', behavior: 'waiting; keeps a slot in the monitoring pool', exit: 'park', to: MONITORING, via: ['carryOutPark', 'parkOnWaits'] },
  { id: 'running.park-workers', states: ['running'], trigger: 'The turn ends with an open worker wait', firedBy: 'runner', behavior: 'waiting; the slot is freed and the idle timer armed', exit: 'park', to: ['waiting:workers'], via: ['carryOutPark', 'parkOnWaits'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U3w a worker message during a worker wait wakes the parent and the worker wait stays open' } },
  { id: 'running.park-peer', states: ['running'], trigger: 'The turn ends with an open peer wait as the top wait', firedBy: 'runner', behavior: 'waiting; the slot is freed and the idle timer armed', exit: 'park', to: ['waiting:peer'], via: ['carryOutPark', 'parkOnWaits'], pinnedBy: { file: 'workflows/peer-waits.test.ts', test: 'running → waiting:peer: the turn end parks on the peer wait with no slot' } },
  { id: 'running.ask', states: ['running'], trigger: 'The turn ends on a shown question or one of Cezar\'s human waits', firedBy: 'runner', behavior: 'waiting, Needs you; the idle timer armed', exit: 'park', to: ['waiting:human'], via: ['parkOnWaits', 'parkForUser'] },
  { id: 'running.no-wait-nudge', states: ['running'], trigger: 'The turn ends with no wait and no done, the first time', firedBy: 'runner', behavior: 'A nudge is sent; stays running; the reply bound is armed', exit: null, to: 'same', via: ['carryOutNoWaitNudge'] },
  { id: 'running.no-wait-human', states: ['running'], trigger: 'The nudge\'s reply turn ends with no wait again', firedBy: 'runner', behavior: 'Cezar\'s no-wait human wait: waiting, Needs you (a worker asks its parent)', exit: 'park', to: ['waiting:human'], via: ['carryOutHumanWait', 'openTurnEndHumanWait', 'parkForUser'] },
  { id: 'running.nudge-reply-bound', states: ['running'], trigger: 'No reply to the nudge within 5 minutes', firedBy: 'timer', behavior: 'Cezar\'s no-wait human wait, as running.no-wait-human', exit: 'park', to: ['waiting:human'], via: ['armNoWaitNudgeReplyTimer', 'openTurnEndHumanWait'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U22s a refusal reopened into a session that acknowledges it and never answers' } },
  { id: 'running.completion-nudge', states: ['running'], trigger: 'The turn ends on a done that workers block, the first time in the cycle', firedBy: 'runner', behavior: 'A refusal nudge; stays running', exit: null, to: 'same', via: ['carryOutCompletionNudge'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U20a a done blocked in the turn that answers a worker message acknowledged after that turn ended still gets the refusal nudge' } },
  { id: 'running.completion-wait', states: ['running'], trigger: 'The refusal turn ends on a blocked done again, with workers live', firedBy: 'runner', behavior: 'Cezar\'s completion worker wait: waiting', exit: 'park', to: ['waiting:workers'], via: ['carryOutCompletionWait', 'parkOnWaits'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U21 an ignored refusal with live workers parks on a Cezar worker wait that settlement wakes' } },
  { id: 'running.completion-refusal', states: ['running'], trigger: 'A blocked done with the session gone, or a done blocked only by a pending question', firedBy: 'engine', behavior: 'waiting: the refusal is queued for a reopened session, or the run parks for the user', exit: 'park', to: ['waiting:capacity', 'waiting:human'], via: ['queueCompletionRefusal', 'completionGate'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U22 a done blocked after the session closed reopens it and delivers the refusal' } },
  { id: 'running.budget', states: ['running'], trigger: 'The wake budget (40) is spent at a no-wait or refusal turn end', firedBy: 'runner', behavior: 'Cezar\'s budget human wait: waiting', exit: 'park', to: ['waiting:human'], via: ['carryOutHumanWait'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U15 an autonomous run is nudged with the autonomous wording until the budget, then opens a budget human wait' } },
  { id: 'running.native-ask', states: ['running'], trigger: 'A native ask arrives during the turn', firedBy: 'runner', behavior: 'waiting, Needs you; the slot is released', exit: 'park', to: ['waiting:human'], via: ['handleRunnerUiEvent'] },
  { id: 'running.permission', states: ['running'], trigger: 'A permission prompt arrives', firedBy: 'runner', behavior: 'waiting with hasPendingPermission; the slot is released', exit: 'park', to: ['waiting:permission'], via: ['handleRunnerUiEvent'], pinnedBy: { file: 'workflows/permissions.test.ts', test: 'parks concurrent requests until their exact IDs resolve and blocks all ordinary input' } },
  { id: 'running.done', states: ['running'], trigger: 'cezar_done or the done line is accepted in the last step', firedBy: 'runner', behavior: 'The session closes; done', exit: 'succeed', to: ['done'], via: ['carryOutDone', 'settleExecution', 'settleSuccess', 'commitOrdinarySuccess'] },
  { id: 'running.done-review', states: ['running'], trigger: 'cezar_done or the done line is accepted in the last step', firedBy: 'runner', when: 'the review gate is on (CEZ_REVIEW_GATE) and the task has a diff', behavior: 'review', exit: 'succeed-review', to: ['review'], via: ['commitOrdinarySuccess'], pinnedBy: { file: 'workflows/run.test.ts', test: 'gate on (env) + non-autonomous + changes → review' } },
  { id: 'running.done-step', states: ['running'], trigger: 'cezar_done in a step that is not the last', firedBy: 'runner', when: 'a workflow with steps left', behavior: 'The next step starts; stays running', exit: null, to: 'same', via: ['runWorkflowSteps'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U6s cezar_done in a workflow step that is not the last completes that step, and the next step runs' } },
  { id: 'running.check-retry', states: ['running'], trigger: 'A check step fails with retries left', firedBy: 'engine', when: 'a workflow check step', behavior: 'queued for the retry, then running in the same execution', exit: 'requeue', to: ['queued'], via: ['settleCheckStep'], pinnedBy: { file: 'workflows/run.test.ts', test: 'keeps a check retry budget bounded across a recovered workflow remainder' } },
  { id: 'running.workflow-rest', states: ['running'], trigger: 'A Continue finishes the workflow step it resumed, with steps left', firedBy: 'runner', when: 'a resumed workflow', behavior: 'queued for the rest of the workflow', exit: 'requeue', to: ['queued'], via: ['settleResumedWorkflowStep'], pinnedBy: { file: 'workflows/run.test.ts', test: 'resumes the remaining workflow after an inactive delegated root answers a non-final ask' } },
  { id: 'running.held', states: ['running'], trigger: 'Before the spawn, the account went into a usage-limit hold, or a parent finish is pending', firedBy: 'engine', when: 'a hold or a pending parent finish', behavior: 'queued, untouched', exit: 'requeue', to: ['queued'], via: ['requeueWhileHeld', 'holdContinuationForRootFinish'], pinnedBy: { file: 'workflows/auto-resume.test.ts', test: 'holds in-place runs too, which dequeue long before they spawn' } },
  { id: 'running.wakes-owed', states: ['running'], trigger: 'The provider fails or the session closes with waits open or results owed, under the delivery bound', firedBy: 'runner', behavior: 'waiting; the next wake reopens it; a failed delivery retries after 15 s, then 30 s', exit: 'park', to: [...MONITORING, 'waiting:workers', 'waiting:peer', 'waiting:capacity'], via: ['settleAgentStepWakes', 'settleClosingWakes', 'settleFailedContinuation'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U9w provider failure with a worker wait open leaves the run recoverable and the next resolution delivers' } },
  { id: 'running.delivery-cap', states: ['running'], trigger: 'The third failed delivery', firedBy: 'runner', behavior: 'failed; results kept; a cap note', exit: 'fail', to: ['failed'], via: ['settleClosingWakes', 'settleAgentStepWakes', 'settleFailedRun'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U14 a wait-wake continuation that fails persistently stops at the delivery bound' } },
  { id: 'running.fail', states: ['running'], trigger: 'The provider fails, or a check fails with no retry left, and nothing is owed', firedBy: 'runner', behavior: 'failed', exit: 'fail', to: ['failed'], via: ['settleExecution', 'settleFailedRun'], pinnedBy: { file: 'workflows/pi-teardown.test.ts', test: 'execute and Continue keep the provider error after teardown exit' } },
  // The failed Continue's own write, with its own exit: what running.fail, running.delivery-cap,
  // running.usage-limit and capacity.delivery-fails do on a Continue.
  { id: 'running.continue-fail', states: ['running', 'waiting:capacity'], trigger: 'A Continue\'s session fails, with nothing it can park on', firedBy: 'runner', behavior: 'failed; at the delivery bound, results kept and a cap note; a usage limit then holds (failed.hold)', exit: 'fail-continue', to: ['failed'], via: ['settleFailedContinuation'], pinnedBy: { file: 'workflows/pi-teardown.test.ts', test: 'execute and Continue keep the provider error after teardown exit' } },
  { id: 'running.usage-limit', states: ['running'], trigger: 'The provider reports a usage limit', firedBy: 'runner', behavior: 'failed, then at once the hold (failed.hold)', exit: 'fail', to: ['failed'], via: ['settleFailedRun'], pinnedBy: { file: 'workflows/auto-resume.test.ts', test: 'schedules the resume for the provider' } },
  { id: 'running.step-closed', states: ['running'], trigger: 'An earlier workflow step\'s session closes without done', firedBy: 'runner', when: 'a root', behavior: 'waiting (plain)', exit: 'park', to: ['waiting:plain'], via: ['settleIncompleteStep'] },
  { id: 'running.step-closed-worker', states: ['running'], trigger: 'An earlier workflow step\'s session closes without done', firedBy: 'runner', when: 'an owned worker', behavior: 'Settles done', exit: 'succeed', to: ['done'], via: ['settleIncompleteStep', 'settleIdleClosedWorker'] },
  { id: 'running.autonomous-idle', states: ['running'], trigger: 'A refused autonomous nudge, then 15 minutes idle', firedBy: 'timer', when: 'autonomy is on (off by default)', behavior: 'waiting (plain)', exit: 'park', to: ['waiting:plain'], via: ['armIdleTimer', 'settleIdleClosedRun'] },
  { id: 'running.step-timeout', states: ['running', 'waiting:human'], trigger: 'The step\'s authored timeoutMs passes', firedBy: 'runner', when: 'the step sets timeoutMs (no step sets one by default)', behavior: 'failed; human waits cancelled', exit: 'fail', to: ['failed'], via: ['runAgentStep', 'settleFailedRun'] },
  { id: 'running.stop', states: ['running'], trigger: 'Stop', firedBy: 'human', behavior: 'cancelled', exit: 'cancel', to: ['cancelled'], via: ['cancel', 'settleCancelledRun', 'settleCancelledContinuation', 'settleCancelledSuccess', 'releaseContinuationSession'] },
  { id: 'running.finish', states: ['running'], trigger: 'Finish', firedBy: 'human', behavior: 'The session closes; done', exit: 'succeed', to: ['done'], via: ['finish', 'settleSuccess'] },
  { id: 'running.crash', states: ['running'], trigger: 'The engine throws', firedBy: 'engine', when: 'the engine throws', behavior: 'failed (engine crashed)', exit: 'fail-crash', to: ['failed'], via: ['pump', 'admitContinuation', 'failCrashedContinuation'] },
  { id: 'running.interrupted', states: ['running'], trigger: 'The process exits during the turn, then restart', firedBy: 'recovery', behavior: 'failed (interrupted), then queued again or continued (failed.restart)', exit: 'fail-interrupted', to: ['failed'], via: ['recoverInterruptedRun'] },
  { id: 'running.legacy', states: ['running'], trigger: 'A row an older build stored as running with an open wait', firedBy: 'recovery', behavior: 'waiting', exit: 'park', to: ['waiting:plain'], via: ['store:upgradeLegacyWaits'] },
  // Every engine-owned state, at load
  { id: 'live.stopping', states: ENGINE_OWNED, trigger: 'A Stop was accepted before the process exited', firedBy: 'recovery', behavior: 'cancelled', exit: 'cancel', to: ['cancelled'], via: ['store:reconcileLoadedRun'] },
  { id: 'live.read-only', states: ENGINE_OWNED, trigger: 'A store opened without keepLive reads a run the engine owned', firedBy: 'recovery', behavior: 'failed (interrupted)', exit: 'fail-interrupted', to: ['failed'], via: ['store:reconcileLoadedRun'] },
  // Every park
  { id: 'waiting.message', states: PARKS, trigger: 'A human message, live session', firedBy: 'human', behavior: 'Delivered; running; waits stay open; the budget resets', exit: 'resume', to: ['running'], via: ['deliverMessage', 'resumeParkedRun'] },
  { id: 'waiting.worker-wake', states: parksBut('waiting:usage-limit'), trigger: 'A worker message, a routed reply or a parent\'s answer', firedBy: 'worker', when: 'the run has workers or a parent', behavior: 'Wakes the run: running (no session: through the line)', exit: 'resume', to: ['running'], via: ['queueWaitWake', 'deliverAdmittedWake', 'submitAgentInput'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U21m a worker message wakes a parent parked on the completion wait and the wait stays open' } },
  { id: 'waiting.runner-activity', states: parksBut('waiting:usage-limit'), trigger: 'Unsolicited runner activity (a Claude background task, a Pi async subagent)', firedBy: 'runner', when: 'the runner reports background work', behavior: 'running; waits stay open', exit: 'resume', to: ['running'], via: ['handleRunnerUiEvent', 'resumeParkedRun'] },
  { id: 'waiting.stop', states: parksBut('waiting:usage-limit'), trigger: 'Stop', firedBy: 'human', behavior: 'Waits cancelled; cancelled. A question stays pending', exit: 'cancel', to: ['cancelled'], via: ['cancel'] },
  { id: 'waiting.stop-root-finish', states: parksBut('waiting:usage-limit'), trigger: 'Stop during a root\'s pending Finish', firedBy: 'human', when: 'a root with Finish pending', behavior: 'cancelled', exit: 'cancel', to: ['cancelled'], via: ['cancel', 'reconcileWorkerFamily'], pinnedBy: { file: 'workflows/worker-wait-capacity.test.ts', test: 'cancellation retires pending Finish after' } },
  { id: 'waiting.finish', states: PARKS, trigger: 'Finish', firedBy: 'human', behavior: 'Waits cancelled, the question closed; done. A root\'s Finish is refused while workers are live or uncollected, or a question is open', exit: 'succeed', to: ['done'], via: ['finish', 'closeQuestionOnFinish', 'settleSuccess'] },
  { id: 'waiting.idle', states: ['waiting:human', 'waiting:workers', 'waiting:peer', 'waiting:plain'], trigger: '15 minutes idle in a park without a slot', firedBy: 'timer', behavior: 'The session closes; a root stays waiting; a wake reopens it. Cezar\'s own question does not stay (human.idle-cezar-question)', exit: null, to: 'same', via: ['armIdleTimer'] },
  { id: 'human.idle-cezar-question', states: ['waiting:human'], trigger: '15 minutes idle on Cezar\'s no-wait question', firedBy: 'timer', when: 'Cezar asked, not the agent', behavior: 'The session closes and Cezar\'s question ends with it (hearsay-tools/cezarion#1234): waiting on nothing until a person sends Continue', exit: null, to: ['waiting:plain'], via: ['armIdleTimer', 'withdrawCezarHumanWaits'] },
  { id: 'waiting.restart', states: parksBut('waiting:usage-limit', 'waiting:permission', 'waiting:human'), trigger: 'Restart', firedBy: 'recovery', behavior: 'Parked again with its waits re-armed; owed wakes go through the continuation', exit: 'park', to: 'same', via: ['parkRecoveredRun', 'parkOnOpenWaits'] },
  { id: 'waiting.wake-no-session', states: [...MONITORING, 'waiting:workers', 'waiting:peer'], trigger: 'A wait resolves with no session', firedBy: 'watcher', when: 'the session closed', behavior: 'The scheduler continuation: queued, then running', exit: 'continue-line', to: ['queued'], via: ['queueWaitWake', 'continueRun'] },
  // Continue, every state a person can continue
  { id: 'continue.now', states: CONTINUABLE, trigger: 'A human message or Continue, no session; Send back from review', firedBy: 'human', behavior: 'A continuation: running at once', exit: 'continue-now', to: ['running'], via: ['continueRun', 'admitContinuation'] },
  { id: 'continue.line', states: CONTINUABLE, trigger: 'A human message or Continue, no session, or a parent\'s message to a settled owned worker', firedBy: 'human', when: 'no slot is free, or the account is held', behavior: 'queued, as a wake in the line', exit: 'continue-line', to: ['queued'], via: ['continueRun', 'admitContinuation'] },
  // waiting:pr, waiting:process, waiting:timer
  { id: 'pr.resolves', states: ['waiting:pr'], trigger: 'Checks settle, the head changes, the PR merges, closes or conflicts, the deadline passes, or gh fails for good', firedBy: 'watcher', behavior: 'Resolves; the wake turn starts at once in the held slot: running', exit: 'resume', to: ['running'], via: ['resolveWait', 'queueWaitWake', 'deliverAdmittedWake', 'submitAgentInput'] },
  { id: 'process.resolves', states: ['waiting:process'], trigger: 'The exit file appears, the process is gone, the deadline passes, or the probe fails', firedBy: 'watcher', behavior: 'As pr.resolves', exit: 'resume', to: ['running'], via: ['resolveWait', 'queueWaitWake', 'submitAgentInput'] },
  { id: 'timer.fires', states: ['waiting:timer'], trigger: 'The deadline passes', firedBy: 'timer', behavior: 'As pr.resolves; spends 1 of the 40 wakes', exit: 'resume', to: ['running'], via: ['armWait', 'resolveWait', 'queueWaitWake', 'submitAgentInput'] },
  { id: 'monitoring.budget-spent', states: ['waiting:process', 'waiting:timer'], trigger: 'A timer or process wait resolves with the budget spent', firedBy: 'timer', when: 'the wake budget is spent', behavior: 'Cancelled with the cap note; Cezar\'s budget human wait', exit: null, to: ['waiting:human'], via: ['resolveWait', 'openHumanAlias'] },
  // waiting:workers
  { id: 'workers.settle', states: ['waiting:workers'], trigger: 'The awaited workers settle, or the named requests get replies', firedBy: 'worker', behavior: 'Resolves; the wake joins the line for a regular slot: running', exit: 'resume', to: ['running'], via: ['reconcileWorkerFamily', 'resolveWait', 'queueWaitWake'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U2w ci and worker open: the worker resolving wakes the agent with ci still open' } },
  { id: 'workers.deadline', states: ['waiting:workers'], trigger: 'An agent worker wait\'s deadline passes (Cezar\'s completion wait has none)', firedBy: 'timer', when: 'the agent set the wait', behavior: 'Resolves timeout; wakes as workers.settle', exit: 'resume', to: ['running'], via: ['armWait', 'resolveWait'] },
  // waiting:peer (hearsay-tools/cezarion#1995). A human message (waiting.message), a family message
  // (waiting.worker-wake), Stop (waiting.stop) and restart (waiting.restart) leave the wait open.
  { id: 'peer.message', states: ['waiting:peer'], trigger: 'A named peer sends a message of any kind', firedBy: 'peer', behavior: 'Resolves message; the wake joins the line for a regular slot: running', exit: 'resume', to: ['running'], via: ['deliverConversationInput', 'resolvePeerWaits', 'resolvePeerWait', 'resolveWait', 'queueWaitWake'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U19w a peer wait parks a root that reads waiting on 1 task' } },
  { id: 'peer.settled', states: ['waiting:peer'], trigger: 'A named peer reaches review, done, failed or cancelled, or is deleted', firedBy: 'watcher', behavior: 'Resolves settled; wakes as peer.message', exit: 'resume', to: ['running'], via: ['resolvePeerWaits', 'resolvePeerWait', 'resolveWait', 'queueWaitWake'], pinnedBy: { file: 'workflows/peer-waits.test.ts', test: 'resolves the wait as settled' } },
  { id: 'peer.deadline', states: ['waiting:peer'], trigger: 'The deadline passes', firedBy: 'timer', behavior: 'Resolves timeout; wakes as peer.message', exit: 'resume', to: ['running'], via: ['armWait', 'resolveWait', 'queueWaitWake'], pinnedBy: { file: 'workflows/peer-waits.test.ts', test: 'the deadline resolves the wait as timeout' } },
  { id: 'peer.beside', states: ['waiting:peer'], trigger: 'Another wait beside it resolves', firedBy: 'watcher', when: 'another wait is open beside it', behavior: 'Wakes with that result: running; the peer wait stays open and the turn end parks on it again', exit: 'resume', to: ['running'], via: ['resolveWait', 'queueWaitWake'], pinnedBy: { file: 'workflows/peer-waits.test.ts', test: 'another wait resolving beside it wakes the run and the peer wait stays open' } },
  { id: 'peer.budget', states: ['waiting:peer'], trigger: 'A resolution arrives with the wake budget spent', firedBy: 'peer', when: 'the wake budget is spent', behavior: 'Not admitted: the wait is cancelled with the cap note, and Cezar\'s budget human wait opens: Needs you', exit: null, to: ['waiting:human'], via: ['resolveWait', 'cancelAutomaticAtCap', 'reparkWithoutWaits'], pinnedBy: { file: 'workflows/peer-waits.test.ts', test: 'a resolution with the wake budget spent is not admitted' } },
  // waiting:usage-limit
  { id: 'hold.fires', states: ['waiting:usage-limit'], trigger: 'The resume time passes', firedBy: 'timer', behavior: 'The continuation joins the line: queued', exit: 'continue-line', to: ['queued'], via: ['fireAutoResume', 'continueRun', 'admitContinuation'], pinnedBy: { file: 'workflows/auto-resume.test.ts', test: 'schedules the next window when the resumed turn hits the limit again, and counts up' } },
  { id: 'hold.withdrawn', states: ['waiting:usage-limit'], trigger: 'Auto-resume is off, the window was missed by a day, the cap (12) is reached, or the run is unreadable or refused at fire time', firedBy: 'engine', when: 'the resume cannot run', behavior: 'failed with the kept error and a note', exit: 'withdraw-hold', to: ['failed'], via: ['reconcileAutoResumes', 'fireAutoResume', 'withdrawAutoResume'], pinnedBy: { file: 'workflows/auto-resume.test.ts', test: 'stops scheduling once the consecutive-resume cap is spent, and says why' } },
  { id: 'hold.cancel', states: ['waiting:usage-limit'], trigger: 'Per-task cancel (DELETE /runs/:id/auto-resume)', firedBy: 'human', behavior: 'failed', exit: 'withdraw-hold', to: ['failed'], via: ['cancelAutoResume', 'withdrawAutoResume'], pinnedBy: { file: 'workflows/auto-resume.test.ts', test: 'cancels one task without touching another that is waiting out the same window' } },
  { id: 'hold.stop', states: ['waiting:usage-limit'], trigger: 'Stop with open waits', firedBy: 'human', behavior: 'Waits discarded, the resume withdrawn: failed. With no open wait the Stop is refused and the hold stays', exit: 'withdraw-hold', to: ['failed'], via: ['cancel', 'cancelAutoResume'], pinnedBy: { file: 'workflows/waits-wake.test.ts', test: 'claude Stop on a usage-limited failed run holding a wait result discards it and cancels the automatic resume' } },
  { id: 'hold.archive', states: ['waiting:usage-limit'], trigger: 'Archive', firedBy: 'human', behavior: 'failed', exit: 'withdraw-hold', to: ['failed'], via: ['store:clearPendingAutoResume'], pinnedBy: { file: 'workflows/auto-resume.test.ts', test: 'never resumes a task the user resigned from' } },
  { id: 'hold.continue', states: ['waiting:usage-limit'], trigger: 'A human message or Continue', firedBy: 'human', behavior: 'queued, as a wake in the line', exit: 'continue-line', to: ['queued'], via: ['admitContinuation'], pinnedBy: { file: 'workflows/auto-resume.test.ts', test: 'treats a human message during the hold as the user' } },
  { id: 'hold.wait-resolves', states: ['waiting:usage-limit'], trigger: 'One of its waits resolves', firedBy: 'watcher', behavior: 'Stays resolved and owed; the resume delivers it', exit: null, to: 'same', via: ['queueWaitWake'], pinnedBy: { file: 'workflows/auto-resume.test.ts', test: 'keeps a wait that resolves during the hold for the resume to deliver' } },
  { id: 'hold.restart', states: ['waiting:usage-limit'], trigger: 'Restart', firedBy: 'recovery', behavior: 'Re-armed: stays waiting', exit: 'hold', to: 'same', via: ['reconcileAutoResumes', 'armAutoResume'], pinnedBy: { file: 'workflows/auto-resume.test.ts', test: 're-arms a waiting usage-limit run across a restart without reopening it' } },
  // waiting:capacity
  { id: 'capacity.slot', states: ['waiting:capacity'], trigger: 'A slot frees', firedBy: 'scheduler', behavior: 'The wake turn: running (no session: the continuation)', exit: 'resume', to: ['running'], via: ['pump', 'deliverAdmittedWake', 'retryWaitAdmission', 'spendWakeAdmission'] },
  { id: 'capacity.delivery-fails', states: ['waiting:capacity'], trigger: 'The delivery fails', firedBy: 'runner', when: 'the provider refuses the input', behavior: 'Backoff, stays waiting; the third failure: failed, results kept', exit: 'fail', to: ['failed'], via: ['settleClosingWakes'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U13 a persistently rejected wait result beside a pending portable question stops after the delivery bound' } },
  { id: 'capacity.inbox', states: ['waiting:capacity'], trigger: 'An inbox read takes the messages', firedBy: 'agent', behavior: 'Nothing is owed; back to its park', exit: null, to: parksBut('waiting:capacity', 'waiting:usage-limit', 'waiting:permission'), via: ['retireEmptyWake'] },
  // waiting:human
  { id: 'human.answer', states: ['waiting:human'], trigger: 'The user answers', firedBy: 'human', behavior: 'The wait settles delivered once the answer is saved; running', exit: 'resume', to: ['running'], via: ['deliverMessage', 'resumeParkedRun'] },
  { id: 'human.parent-answer', states: ['waiting:human'], trigger: 'The parent replies to a routed worker question', firedBy: 'parent', when: 'an owned worker', behavior: 'Answered; the worker resumes', exit: 'resume', to: ['running'], via: ['routeWorkerQuestion'], pinnedBy: { file: 'workflows/worker-waits.test.ts', test: 'the parent\'s answer to a worker question leaves the worker\'s earlier wait open' } },
  { id: 'human.beside', states: ['waiting:human'], trigger: 'Another wait beside it resolves', firedBy: 'watcher', when: 'another wait is open beside the question', behavior: 'Delivered beside the card: running; it parks again, Needs you', exit: 'resume', to: ['running'], via: ['queueWaitWake'] },
  { id: 'human.workers', states: ['waiting:human'], trigger: 'A worker messages, settles or asks', firedBy: 'worker', when: 'Cezar\'s completion wait, with workers live', behavior: 'Wakes the run: running', exit: 'resume', to: ['running'], via: ['queueWaitWake'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U19 a worker message beside a pending portable question is delivered and the question stays answerable' } },
  { id: 'human.worker-fallback', states: ['waiting:human'], trigger: 'A worker\'s fallback question: its session idle-closes (15 min) or a restart finds no process', firedBy: 'timer', when: 'an owned worker on its fallback question', behavior: 'The question is superseded; the worker settles done', exit: 'succeed', to: ['done'], via: ['settleIdleClosedWorker', 'recoverClosedWaitingRun'] },
  { id: 'human.restart', states: ['waiting:human'], trigger: 'Restart', firedBy: 'recovery', behavior: 'An unshown wait is shown, a transcript ask is adopted, a stale one is settled; stays waiting', exit: 'park', to: 'same', via: ['parkRecoveredRun', 'adoptTranscriptAsk', 'settleAnsweredLegacyAsk'] },
  // waiting:permission
  { id: 'permission.resolve', states: ['waiting:permission'], trigger: 'The user resolves the prompt', firedBy: 'human', behavior: 'running', exit: 'resume', to: ['running'], via: ['handleRunnerUiEvent', 'resumeParkedRun'], pinnedBy: { file: 'workflows/permissions.test.ts', test: 'parks concurrent requests until their exact IDs resolve and blocks all ordinary input' } },
  { id: 'permission.restart', states: ['waiting:permission'], trigger: 'Restart', firedBy: 'recovery', behavior: 'The old prompt cannot be answered: running, then interrupted recovery (failed, then continued)', exit: 'resume', to: ['running'], via: ['recoverUnreadInputs', 'recoverInterruptedRun'], pinnedBy: { file: 'core/codex-permission-recovery.test.ts', test: 'P1 recovers an owned permission wait without reporting unfinished work as done' } },
  // waiting:plain
  { id: 'plain.worker-idle', states: ['waiting:plain'], trigger: 'An owned worker idles 15 minutes', firedBy: 'timer', when: 'an owned worker', behavior: 'Settles done; its parent can collect it', exit: 'succeed', to: ['done'], via: ['armIdleTimer', 'settleIdleClosedWorker'], pinnedBy: { file: 'workflows/run-states-worker.test.ts', test: 'a budget-spent worker plain park settles done after the idle timer' } },
  { id: 'plain.worker-restart', states: ['waiting:plain'], trigger: 'Restart', firedBy: 'recovery', when: 'an owned worker', behavior: 'Settles done, or resumes its CI recovery', exit: 'succeed', to: ['done'], via: ['recoverClosedWaitingRun'] },
  { id: 'plain.invalid-ask', states: ['waiting:plain'], trigger: 'Restart finds an ask it cannot show', firedBy: 'recovery', when: 'an owned worker', behavior: 'failed (invalid ask)', exit: 'fail', to: ['failed'], via: ['failRecoveredInvalidAsk'] },
  { id: 'plain.legacy', states: ['waiting:plain'], trigger: 'A row an older build stored as waiting, its input interrupted', firedBy: 'recovery', behavior: 'running, then interrupted recovery', exit: 'resume', to: ['running'], via: ['store:upgradeLegacyWaits'] },
  // hearsay-tools/cezarion#1620: a done waits behind an input the inbox claimed, parked plain.
  { id: 'plain.inbox-ack-step', states: ['waiting:plain'], trigger: 'The inbox ack settles the done a claimed input held, in a step that is not the last', firedBy: 'agent', when: 'a workflow with steps left', behavior: 'The next step starts: running', exit: 'start', to: ['running'], via: ['acknowledgeInbox', 'runWorkflowSteps'], pinnedBy: { file: 'workflows/worker-inbox-liveness.test.ts', test: 'keeps the agent→check recipient live until inbox' } },
  // review
  { id: 'review.draft-pr', states: ['review'], trigger: 'Draft PR', firedBy: 'human', behavior: 'done', exit: 'accept-review', to: ['done'], via: ['server:createDraftPr'] },
  { id: 'review.finish', states: ['review'], trigger: 'Finish', firedBy: 'human', behavior: 'done', exit: 'accept-review', to: ['done'], via: ['finish'] },
  // A Stop accepted during the final autosave, after success was recorded. No spec table lists it.
  // queued: the Continue's done step queued the workflow remainder before the autosave yielded.
  { id: 'settled.late-stop', states: ['queued', 'running', 'review', 'done'], trigger: 'A Stop accepted during a Continue\'s final autosave', firedBy: 'human', behavior: 'cancelled; a queued workflow remainder does not start', exit: 'cancel-late', to: ['cancelled'], via: ['releaseContinuationSession'], pinnedBy: { file: 'workflows/run.test.ts', test: 'does not launch a prepared workflow remainder when cancellation wins during continuation teardown' } },
  // unified-waits lists no Stop on a settled run. cancel() records an owned worker cancelled at any
  // status, and POST /runs/:id/cancel calls it on a settled worker too.
  { id: 'worker.stop-settled', states: ['review', 'done', 'failed'], trigger: 'Stop on an owned worker that already settled', firedBy: 'human', when: 'an owned worker', behavior: 'cancelled: the settled status is replaced, and cancel() returns false', exit: 'stop-worker', to: ['cancelled'], via: ['cancel', 'persistWorkerCompletion', 'store:commitWorkerCancellation'], pinnedBy: { file: 'workflows/run-states-worker.test.ts', test: 'Stop on a worker that settled done records it cancelled' } },
  // A Stop on an owned worker commits cancelled at once, while its failed Continue still waits for
  // the process to exit. The failure then writes failed, and the Stop's cancel-late writes cancelled.
  { id: 'worker.stop-failed-continue', states: ['cancelled'], trigger: 'A failed Continue settles after Stop recorded the owned worker cancelled', firedBy: 'runner', when: 'an owned worker', behavior: 'failed until the session is released, then cancelled again (failed.late-stop)', exit: 'fail-continue', to: ['failed'], via: ['settleFailedContinuation'], pinnedBy: { file: 'workflows/worker-destroy.test.ts', test: 'post-spawn human flush failure retains resources until the session process closes' } },
  // failed
  { id: 'failed.hold', states: ['failed'], trigger: 'A usage-limit error, with auto-resume on and a session', firedBy: 'engine', when: 'the failure was a usage limit', behavior: 'waiting on the hold', exit: 'hold', to: ['waiting:usage-limit'], via: ['scheduleAutoResumeIfLimited', 'armAutoResume'], pinnedBy: { file: 'workflows/auto-resume.test.ts', test: 'schedules the resume for the provider' } },
  // A Stop accepted while a failed Continue saves its worktree, as settled.late-stop does after success.
  { id: 'failed.late-stop', states: ['failed'], trigger: 'A Stop accepted during a failed Continue\'s final autosave', firedBy: 'human', behavior: 'cancelled', exit: 'cancel-late', to: ['cancelled'], via: ['releaseContinuationSession'], pinnedBy: { file: 'workflows/run.test.ts', test: 'records a Stop accepted while a failed Continue saves its worktree as cancelled' } },
  { id: 'failed.stop-results', states: ['failed'], trigger: 'Stop while it holds results', firedBy: 'human', behavior: 'Results discarded; stays failed', exit: null, to: 'same', via: ['cancel'], pinnedBy: { file: 'workflows/waits-parity-cells.testkit.ts', test: 'U14 Stop on a failed run holding wait results at the delivery bound discards every wait' } },
  { id: 'failed.restart', states: ['failed'], trigger: 'Restart after an interrupted run', firedBy: 'recovery', behavior: 'queued again, or continued (continue.now)', exit: 'requeue', to: ['queued'], via: ['requeueInterruptedRun', 'recoverInterruptedRun'] },
  { id: 'failed.legacy-hold', states: ['failed'], trigger: 'A row a schema-7 cezar stored: failed with autoResumeAt', firedBy: 'recovery', behavior: 'waiting on the hold', exit: 'hold', to: ['waiting:usage-limit'], via: ['store:reconcileLoadedRun'] },
];

/** Each wait kind: its deadline, whether it keeps a slot while it is the top wait, who resolves it. */
export type WaitKindSpec = {
  deadline: 'required' | 'agent-only' | 'none';
  keepsSlot: boolean;
  resolves: readonly { trigger: string; firedBy: FiredBy }[];
  cancels: readonly string[];
  humanOnly?: string;
};

const ENDS_WAITS = ['cezar_cancel_wait', 'a done is accepted', 'Stop', 'Finish', 'delete'] as const;

export const WAIT_KINDS: { readonly [K in Wait['kind']]: WaitKindSpec } = {
  pr: { deadline: 'required', keepsSlot: true, cancels: ENDS_WAITS, resolves: [
    { trigger: 'checks settle or the head changes; a merge wait: merged, closed or a conflict', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 7,200 s, default 1,800) or a fatal gh error', firedBy: 'watcher' },
  ] },
  timer: { deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the wake budget is spent at its deadline'], resolves: [
    { trigger: 'the deadline (60 to 7,200 s)', firedBy: 'timer' },
  ] },
  process: { deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the process is not signalled'], resolves: [
    { trigger: 'the exit file, the process gone, the deadline (up to 7,200 s) or a probe error, polled every 5 s', firedBy: 'watcher' },
  ] },
  peer: { deadline: 'required', keepsSlot: false, cancels: [...ENDS_WAITS, 'the wake budget is spent at its resolution'], resolves: [
    { trigger: 'a message of any kind from a named peer', firedBy: 'peer' },
    { trigger: 'a named peer settles or is deleted', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 1,800 s, default 600)', firedBy: 'timer' },
  ] },
  worker: { deadline: 'agent-only', keepsSlot: false, cancels: [...ENDS_WAITS, 'the parent settles'], resolves: [
    { trigger: 'the workers report outcomes or the requests get replies, as its mode says', firedBy: 'worker' },
    { trigger: 'the deadline of an agent wait; Cezar\'s completion wait has none', firedBy: 'timer' },
  ] },
  human: { deadline: 'none', keepsSlot: false, humanOnly: 'The question is the user\'s gate.',
    cancels: ['the agent\'s own wait replaces Cezar\'s', 'a done in the same turn', 'Stop', 'Finish', 'an authored step timeoutMs'],
    resolves: [{ trigger: 'an answer; the parent\'s for a routed worker question', firedBy: 'human' }] },
};

/** The phases a wait entry moves through. Their writes go through RunStore.commitOutcome (hearsay-tools/cezarion#1805). */
export const WAIT_PHASES: { readonly [P in WaitPhase]: readonly { to: WaitPhase; firedBy: readonly FiredBy[] }[] } = {
  open: [
    { to: 'resolved', firedBy: ['watcher', 'timer', 'worker', 'peer', 'human', 'parent'] },
    { to: 'cancelled', firedBy: ['agent', 'human', 'engine'] },
  ],
  resolved: [
    { to: 'delivered', firedBy: ['runner'] },
    { to: 'cancelled', firedBy: ['human', 'engine'] },
  ],
  delivered: [],
  cancelled: [],
};

export type StateInput = Partial<Pick<RunRecord, 'status' | 'waits' | 'autoResumeAt' | 'hasPendingPermission' | 'agentInputs' | 'delegation'>>
  & Pick<RunRecord, 'status'>;

/** The state of a stored record. Pure. */
export function stateOf(run: StateInput): RunState {
  if (run.status !== 'waiting') return run.status;
  if (run.hasPendingPermission) return 'waiting:permission';
  const top = computeWaitingOn(run);
  if (top) return top.kind === 'peers' ? 'waiting:peer' : `waiting:${top.kind}`;
  if (run.waits?.some((wait) => wait.phase === 'resolved') || run.agentInputs?.some((input) => !input.deliveredAt)) return 'waiting:capacity';
  return 'waiting:plain';
}

let strict = false;
const violations: string[] = [];

/** Tests only: `vitest.setup.ts` calls it, so a violation throws and is recorded. Returns the
 *  previous mode, so a test that changes it can put it back. */
export function strictRunExits(on = true): boolean {
  const previous = strict;
  strict = on;
  return previous;
}

/** The violations recorded since the last call, so a test fails even when `run.ts` swallowed the throw. */
export function takeRunExitViolations(): string[] {
  return violations.splice(0);
}

/** Throws the violations recorded since the last call: the test setup runs it after each test. */
export function throwRunExitViolations(): void {
  const taken = takeRunExitViolations();
  if (taken.length) throw new Error(taken.join('\n'));
}

function violate(message: string): never {
  violations.push(message);
  throw new Error(message);
}

function checkFrom(exit: RunExitId, from: RunStatus | undefined): void {
  const spec = RUN_EXITS[exit];
  if (from === undefined || from === spec.to || (spec.from as readonly RunStatus[]).includes(from)) return;
  violate(`undeclared run transition: exit ${exit} from ${from} (declare it in workflows/run-states.ts)`);
}

/**
 * THE entry point for a run status write in `run.ts`: the status `exit` writes. In strict mode it
 * reads the stored record and refuses an exit that does not leave from its status. A run the store
 * does not hold passes, because the write then writes nothing.
 */
export function transition<E extends RunExitId>(exit: E, read: () => Pick<StateInput, 'status'> | undefined): (typeof RUN_EXITS)[E]['to'] {
  if (strict) checkFrom(exit, read()?.status);
  return RUN_EXITS[exit].to;
}

/**
 * For a store commit that writes a status it holds itself. In strict mode it reads the stored
 * status before and after the commit. When the status changed, the old one must be in the exit's
 * `from` and the new one must be the exit's `to`, so the commit and its exit cannot drift apart. A
 * commit that wrote no status (it refused, or only cleared fields) passes. Both checks run after
 * the commit, so strict mode never keeps a commit from running.
 */
export function transitionVia<T>(exit: RunExitId, read: () => Pick<StateInput, 'status'> | undefined, commit: () => T): T {
  if (!strict) return commit();
  const before = read()?.status;
  const result = commit();
  const after = read()?.status;
  if (before === after) return result;
  checkFrom(exit, before);
  if (after !== RUN_EXITS[exit].to) violate(`store commit drifted from its exit: exit ${exit} wrote ${after ?? 'nothing'}, not ${RUN_EXITS[exit].to}`);
  return result;
}
