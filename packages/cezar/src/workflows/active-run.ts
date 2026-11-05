import { createWaitGroup, type WaitGroup } from './run/wait-registry.ts';
import { createAutosaveGroup, type AutosaveGroup } from './run/worktree-autosave.ts';
import { createInputGroup, type InputGroup } from './run/input-delivery.ts';
import { createSessionGroup, type SessionGroup } from './run/live-session-state.ts';
import { createChildrenGroup, type ChildrenGroup } from './run/subagent-waits.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { createSkillsGroup, type SkillsGroup } from './run/run-skills.ts';
import { createUsageGroup, type UsageGroup } from './run/usage-accounting.ts';

/**
 * The in-memory state of a run this manager is executing, and the one place it is built
 * (hearsay-tools/cezarion#1806). `RunManager` registers every instance through `activate`.
 */
export interface ActiveRun {
  readonly waitIdentity: WaitGroup;
  readonly autosave: AutosaveGroup;
  readonly inputState: InputGroup;
  readonly usage: UsageGroup;
  readonly liveSession: SessionGroup;
  ciTurnId?: string;
  waitWakeTurn?: AgentSession | undefined;
  pendingHumanAsk: boolean;
  /** Liveness bound for a no-wait nudge that was acknowledged without a turn (#544,
   *  hearsay-tools/cezarion#1234). */
  noWaitNudgeReplyTimer?: NodeJS.Timeout | undefined;
  /** Parent-level text/item/tool arrived for this nudge, possibly before the timer armed. */
  noWaitNudgeSawContent?: boolean | undefined;
  /** The reply bound expired on this session: a late reply from it resumes the run. */
  noWaitNudgeParked?: AgentSession | undefined;
  doneAtBoundary?: AgentSession | undefined;
  /** `cezar_done` accepted in this session since its last turn end (hearsay-tools/cezarion#1234). */
  doneRequested?: { session: AgentSession; summary?: string } | undefined;
  /** The session's done completes a workflow step that is not the last, and this step runs next
   *  (hearsay-tools/cezarion#1620). Undefined: the done finishes the task. */
  nextStep?: { session: AgentSession; label: string } | undefined;
  /** The step an accepted done closed. A workflow step that is not the last advances only on it. */
  completedStepId?: string | undefined;
  /** What declared the done `doneAtBoundary` closes on: the closing event names it. */
  doneClose?: { via: 'cezar_done'; summary?: string } | undefined;
  parkAfterAck?: { session: AgentSession; monitoring: boolean; humanGate?: boolean; nudgedLastTurn?: boolean; scheduleWakeup?: number | null | undefined } | undefined;
  /** Last completed boundary belongs to exactly this still-open session. */
  atTurnBoundary?: AgentSession | undefined;
  idleTimer?: NodeJS.Timeout | undefined;
  /** The inactivity timer closed the wire; resource teardown must not imply task success. */
  idleClosed?: boolean;
  /** The monitoring-timer cap note was written for this session. */
  monitoringCapNoted?: boolean | undefined;
  autosaveTimer?: NodeJS.Timeout | undefined;
  /* The screenshot counter lives on `RunManager.queuedImageSeq` (#472), keyed by
   * run id — a queued run persists attachments with no `ActiveRun` at all. */
  /** Autonomous mode (#autonomous): nudge eligible turn ends until done or the cap.
   *  Pending input, native asks and lifecycle waits retain priority. */
  autonomous?: boolean;
  /** An eligible boundary nudge refused until the current transport becomes ready.
   * Retains its slot, bounded by the existing idle timer; never represents a sent input. */
  autonomousNudgePending?: AgentSession | undefined;
  /** Session that received the no-wait nudge (hearsay-tools/cezarion#1234): its next no-wait
   *  turn end opens a human wait instead of nudging again. */
  noWaitNudged?: AgentSession | undefined;
  /** Session that received a refusal nudge for a blocked done (hearsay-tools/cezarion#1301); the
   *  next turn end on it reads and clears it. */
  /** Request refusals already shown in this completion cycle, including tool answers. */
  incomingRequestRefused?: boolean | undefined;
  sentRequestRefused?: boolean | undefined;
  completionNudged?: AgentSession | undefined;
  /** Session whose turn that just ended answered a refusal nudge (hearsay-tools/cezarion#1301): a
   *  blocked done at this turn end takes the second step. Every turn end sets or clears it. */
  completionNudgeAnswered?: AgentSession | undefined;
  readonly skills: SkillsGroup;
  readonly children: ChildrenGroup;
  /** A park for the user kept the session and its slot for running native subagents
   *  (hearsay-tools/cezarion#2431): their last end gives both back. */
  heldForSubagents?: boolean | undefined;
}

/** Run Cezar's own write into the session: a parent turn the runner starts during it is Cezar's
 *  (hearsay-tools/cezarion#2431). Claude emits `turn.started` inside the write itself. */
export function writeInput<T>(state: ActiveRun, write: () => T): T {
  return state.inputState.writeInput(write);
}

/** What differs between the ways a run starts executing. Every other `ActiveRun` field starts the
 *  same on all of them, so a field with no value here has one in `createActiveRun`. */
export interface ActiveRunInit {
  /** Where this run's steps execute: the task worktree, or the repo root. */
  cwd: string;
  pendingHumanAsk: boolean;
  /** The run's durable mode: `input.autonomous` for a fresh run, the record's for a Continue. */
  autonomous: boolean;
}

/**
 * The ONE place an `ActiveRun` is built (hearsay-tools/cezarion#1806). `execute` (a fresh run) and
 * `runContinuation` (Continue and restart recovery) both call it, then register the result through
 * `RunManager.activate`. A field added to `ActiveRun` as required fails to compile here until this
 * sets it, and one that differs by entry path becomes a required `ActiveRunInit` field, which
 * fails to compile at both callers. open-mercato/cezar#811 shipped a field set in one of two
 * literals; a second literal is refused by the `active-run-literal` ast-grep rule.
 *
 * The skill registry is not built here: it needs I/O after the run is registered, so
 * `RunSkills.loadRunSkills` loads it, from the same two callers.
 */
export function createActiveRun(init: ActiveRunInit): ActiveRun {
  const state = {
    waitIdentity: createWaitGroup(),
    autosave: createAutosaveGroup(),
    inputState: createInputGroup(),
    usage: createUsageGroup(),
    liveSession: createSessionGroup(init.cwd),
    pendingHumanAsk: init.pendingHumanAsk,
    children: createChildrenGroup(),
    skills: createSkillsGroup(),
    autonomous: init.autonomous,
  };
  Object.defineProperty(state, 'waitIdentity', { writable: false, configurable: false });
  Object.defineProperty(state, 'autosave', { writable: false, configurable: false });
  Object.defineProperty(state, 'inputState', { writable: false, configurable: false });
  Object.defineProperty(state, 'liveSession', { writable: false, configurable: false });
  Object.defineProperty(state, 'usage', { writable: false, configurable: false });
  Object.defineProperty(state, 'children', { writable: false, configurable: false });
  Object.defineProperty(state, 'skills', { writable: false, configurable: false });
  return state;
}
