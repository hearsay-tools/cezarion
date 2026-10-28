import { workerOutcomeSchema } from './delegation.ts';
import type { HumanAskClosedEvent, HumanInputDeliveredEvent, RunEvent } from './events.ts';
import { runStatusSchema, stepStateSchema, stepStatusSchema } from './runs.ts';
import type { RunRecord, StepState } from './runs.ts';
import {
  humanWaitEntrySchema,
  peerWaitEntrySchema,
  prWaitEntrySchema,
  processWaitEntrySchema,
  timerWaitEntrySchema,
  waitPhaseSchema,
  waitViaSchema,
  workerWaitEntrySchema,
} from './waits.ts';
import type { HumanWaitEntry, PeerWaitEntry, PrWaitEntry, ProcessWaitEntry, TimerWaitEntry, WorkerWaitEntry } from './waits.ts';

/**
 * Typed test data for run records, waits and events (hearsay-tools/cezarion#1812). A test builds its
 * data here and names an enum value through a constant, so a renamed `RunRecord` field or a renamed
 * wait kind stops compiling in every test that uses it, instead of staying a literal that still
 * compiles and asserts the old value (hearsay-tools/cezarion#1300, hearsay-tools/cezarion#1504).
 *
 * Tests only: nothing in a build reaches this file, and it imports no Node module, so the cockpit's
 * tests can use it too, through `@open-mercato/cezar-api-client/contract/test-factories.testkit`.
 * The `test-enum-literal` ast-grep rule (`.ai/ast-grep/rules`) fails a new enum literal in a test.
 *
 * Each factory returns a value the contract's own schema accepts, which `test-factories.test.ts`
 * proves with `parse`. The overrides are `Partial` of the contract type, so a fresh object literal
 * naming a field the type lacks is a compile error. Events are the exception: the contract keeps
 * them open (an append-only on-disk vocabulary), so only the keys it names are checked.
 */

// ---- enum constants -----------------------------------------------------------------------

// Each constant is the schema's own value list, never a copy: a value the contract renames is a
// compile error at its uses, and one it adds is here already. Keys equal values, so `via`'s
// hyphenated values read `WAIT_VIA['monitoring-line']`.
export const RUN_STATUS = runStatusSchema.enum;
export const STEP_STATUS = stepStatusSchema.enum;
export const STEP_KIND = stepStateSchema.shape.kind.enum;
export const WAIT_PHASE = waitPhaseSchema.enum;
export const WAIT_VIA = waitViaSchema.enum;
export const WAIT_SOURCE = timerWaitEntrySchema.shape.source.enum;
// A worker's outcome inside a delegation or a worker wait: its own enum, a subset of the run statuses.
export const WORKER_OUTCOME_STATUS = workerOutcomeSchema.shape.status.enum;
export const WAIT_KIND = {
  pr: prWaitEntrySchema.shape.kind.value,
  timer: timerWaitEntrySchema.shape.kind.value,
  human: humanWaitEntrySchema.shape.kind.value,
  worker: workerWaitEntrySchema.shape.kind.value,
  process: processWaitEntrySchema.shape.kind.value,
  peer: peerWaitEntrySchema.shape.kind.value,
} as const;

// ---- shared defaults ----------------------------------------------------------------------

const NOW = '2026-10-26T00:00:00.000Z';
const LATER = '2026-10-26T00:05:00.000Z';

let sequence = 0;
const next = (): number => (sequence += 1);

/** A distinct id that passes `z.uuid()`; the counter restarts with each test file's module graph. */
const uuid = (): string => `f0000000-0000-4000-8000-${next().toString(16).padStart(12, '0')}`;

// ---- run records --------------------------------------------------------------------------

/** One step of a run's chain: a finished agent step unless the test says otherwise. */
export function makeStepState(over: Partial<StepState> = {}): StepState {
  return {
    id: 'task',
    name: 'Do the task',
    kind: STEP_KIND.agent,
    status: STEP_STATUS.done,
    iterations: 1,
    tokensUsed: 0,
    ...over,
  };
}

/** A finished run with no steps and its own id: the fields the contract requires, and nothing else. */
export function makeRunRecord(over: Partial<RunRecord> = {}): RunRecord {
  const n = next();
  return {
    id: `run-${n}`,
    title: `Task ${n}`,
    workflow: 'quick-task',
    task: `task ${n}`,
    status: RUN_STATUS.done,
    createdAt: NOW,
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  };
}

// ---- waits --------------------------------------------------------------------------------

const waitBase = () => ({
  id: uuid(),
  source: WAIT_SOURCE.agent,
  registeredAt: NOW,
  phase: WAIT_PHASE.open,
  turnId: 'turn-1',
});

/** The agent's open monitoring-line timer. */
export function makeTimerWait(over: Partial<TimerWaitEntry> = {}): TimerWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.timer,
    via: WAIT_VIA['monitoring-line'],
    deadline: LATER,
    seconds: 300,
    ...over,
  };
}

/** The agent's open wait on a pull request's checks. */
export function makePrWait(over: Partial<PrWaitEntry> = {}): PrWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.pr,
    via: WAIT_VIA.cezar_wait,
    deadline: LATER,
    prUrl: 'https://github.com/acme/repo/pull/12',
    repository: 'acme/repo',
    prNumber: 12,
    headSha: 'a'.repeat(40),
    generation: 'session',
    timeoutSeconds: 1800,
    until: 'checks',
    wakeOnConflict: true,
    ...over,
  };
}

/** The agent's open question to the user, with no card. */
export function makeHumanWait(over: Partial<HumanWaitEntry> = {}): HumanWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.human,
    via: WAIT_VIA.cezar_ask,
    ...over,
  };
}

/** The agent's open wait on one worker. */
export function makeWorkerWait(over: Partial<WorkerWaitEntry> = {}): WorkerWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.worker,
    via: WAIT_VIA['cez-worker-wait'],
    deadline: LATER,
    timeoutSeconds: 600,
    workerIds: [uuid()],
    revisions: [],
    outcomes: [],
    ...over,
  };
}

/** The agent's open wait on the replies to one request, which a worker wait names instead of workers. */
export function makeWorkerRequestWait(over: Partial<WorkerWaitEntry> = {}): WorkerWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.worker,
    via: WAIT_VIA['cez-worker-wait'],
    deadline: LATER,
    timeoutSeconds: 600,
    requestIds: [uuid()],
    requestOutcomes: [],
    ...over,
  };
}

/** The agent's open wait on a background process. */
export function makeProcessWait(over: Partial<ProcessWaitEntry> = {}): ProcessWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.process,
    via: WAIT_VIA.cezar_wait,
    deadline: LATER,
    timeoutSeconds: 1800,
    pid: 4242,
    ...over,
  };
}

/** The agent's open wait on one named peer task (hearsay-tools/cezarion#1995). */
export function makePeerWait(over: Partial<PeerWaitEntry> = {}): PeerWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.peer,
    via: WAIT_VIA.cezar_wait,
    deadline: LATER,
    timeoutSeconds: 600,
    peerIds: [uuid()],
    ...over,
  };
}

// ---- events -------------------------------------------------------------------------------

/** A transcript line. Any key beyond `seq`, `ts` and `type` rides along, as the open format allows. */
export function makeRunEvent(over: Pick<RunEvent, 'type'> & Partial<RunEvent>): RunEvent {
  return { seq: next(), ts: NOW, ...over };
}

/** A human answer delivered to the ask at `askSeq`. */
export function makeHumanInputDeliveredEvent(over: Pick<HumanInputDeliveredEvent, 'askSeq'> & Partial<HumanInputDeliveredEvent>): HumanInputDeliveredEvent {
  return { seq: next(), ts: NOW, type: 'human-input-delivered', ...over };
}

/** The ask at `askSeq`, retired unanswered. */
export function makeHumanAskClosedEvent(over: Pick<HumanAskClosedEvent, 'askSeq' | 'reason'> & Partial<HumanAskClosedEvent>): HumanAskClosedEvent {
  return { seq: next(), ts: NOW, type: 'human-ask-closed', ...over };
}
