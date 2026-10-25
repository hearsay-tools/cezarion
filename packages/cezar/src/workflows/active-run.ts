import type { AgentSession, InputDelivery } from '../core/agent-runner.ts';
import type { Skill } from '../skills.ts';
import type { DelegationExecutionSettings } from './run.ts';

/**
 * The in-memory state of a run this manager is executing, and the one place it is built
 * (hearsay-tools/cezarion#1806). `RunManager` registers every instance through `activate`.
 */
export interface ActiveRun {
  /** Last cumulative Claude report per provider session during this process. */
  reportedClaudeCost?: Map<string, number>;
  delegationSettings?: DelegationExecutionSettings | undefined;
  revokeDelegation?: (() => void) | undefined;
  revokeCiTools?: (() => void) | undefined;
  /** hearsay-tools/cezarion#1234: the last session started without cezar tools, so its prompt
   *  taught the lifecycle markers; kept after the session's tools are revoked. */
  toolless?: boolean;
  ciGeneration?: string;
  ciTurnId?: string;
  waitWakeTurn?: AgentSession | undefined;
  cancelled: boolean;
  /** Explicit human Finish survives disposal; shutdown-only result callbacks do not settle. */
  finishRequested?: boolean;
  interrupt: () => void;
  /** Where this run's steps execute: the task worktree, or the repo root. */
  cwd: string;
  /** Live claude session of the currently running agent step, if any. */
  session?: AgentSession | undefined;
  pendingHumanAsk: boolean;
  /** Native grants belong only to this live session generation. */
  pendingPermissions?: Set<string>;
  agentInputError?: string;
  agentInputFlight?: { session: AgentSession; inputIds: readonly string[]; settled?: Promise<void>;
    /** This batch carries timer results: it holds one unit of the automatic-wake budget, which
     *  every budget check counts, and charges it to the record on its acknowledgement. */
    wakeReserved?: boolean;
    /** This batch is an admitted wake (hearsay-tools/cezarion#1235): its acknowledgement spends
     *  the admission, a wake of messages alone included. */
    admittedWake?: boolean } | undefined;
  /** The current session's declared input delivery (#505). */
  inputDelivery?: InputDelivery;
  /** Accepted by this session's harness, not yet reported read (observable backends only).
   * The harness still owes a turn for them, so they count as pending work (#505). */
  unreadInputIds?: Set<string>;
  /** Read before the acceptance checkpoint landed; applied when it does. */
  consumedBeforeAck?: Set<string>;
  /** Conversation input carried by a human answer's own write; read at that turn's end. */
  bundledInputIds?: string[] | undefined;
  /** Reported unread while their own submission was still unacknowledged. */
  retiredInFlight?: Set<string>;
  /** Liveness bound for unread input (#505): timer, and IDs already resubmitted once. */
  unreadInputTimer?: NodeJS.Timeout | undefined;
  /** Liveness bound for a no-wait nudge that was acknowledged without a turn (#544,
   *  hearsay-tools/cezarion#1234). */
  noWaitNudgeReplyTimer?: NodeJS.Timeout | undefined;
  /** Parent-level text/item/tool arrived for this nudge, possibly before the timer armed. */
  noWaitNudgeSawContent?: boolean | undefined;
  /** The reply bound expired on this session: a late reply from it resumes the run. */
  noWaitNudgeParked?: AgentSession | undefined;
  unreadRetried?: Set<string>;
  /** #486: re-settle a boundary that deferred only because holdsHumanInput() was true. */
  heldHumanInputTimer?: NodeJS.Timeout | undefined;
  heldHumanInputSince?: number | undefined;
  heldHumanInputExpired?: boolean | undefined;
  /** Only this older ask is being answered by the current continuation's opening turn. */
  openingAnswerAskSeq?: number | undefined;
  openingAgentInputId?: string | undefined;
  agentSessionError?: string | undefined;
  doneAtBoundary?: AgentSession | undefined;
  /** `cezar_done` accepted in this session since its last turn end (hearsay-tools/cezarion#1234). */
  doneRequested?: { session: AgentSession; summary?: string } | undefined;
  /** The session's done completes a workflow step that is not the last, and this step runs next
   *  (hearsay-tools/cezarion#1620). Undefined: the done finishes the task. */
  nextStep?: { session: AgentSession; label: string } | undefined;
  /** The step an accepted done closed. A workflow step that is not the last advances only on it. */
  completedStepId?: string | undefined;
  /** What declared the done `doneAtBoundary` closes on: the closing event names it. */
  doneClose?: { via: 'cezar_done' | 'done-line'; summary?: string } | undefined;
  parkAfterAck?: { session: AgentSession; monitoring: boolean; humanGate?: boolean; nudgedLastTurn?: boolean; scheduleWakeup?: number | null | undefined } | undefined;
  /** Last completed boundary belongs to exactly this still-open session. */
  atTurnBoundary?: AgentSession | undefined;
  currentStepId?: string | undefined;
  idleTimer?: NodeJS.Timeout | undefined;
  /** The inactivity timer closed the wire; resource teardown must not imply task success. */
  idleClosed?: boolean;
  /** The monitoring-timer cap note was written for this session. */
  monitoringCapNoted?: boolean | undefined;
  autosaveTimer?: NodeJS.Timeout | undefined;
  /* The screenshot counter lives on `RunManager.queuedImageSeq` (#472), keyed by
   * run id — a queued run persists attachments with no `ActiveRun` at all. */
  /** Has a session EVER opened on this run (#472)? `session` alone cannot answer
   *  it — teardown sets it back to `undefined`, so a closed session and one that
   *  never opened look identical. This distinguishes "still starting up, buffer
   *  the message" from "genuinely closed, 409". */
  sessionEverOpened?: boolean;
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
  completionNudged?: AgentSession | undefined;
  /** Session whose turn that just ended answered a refusal nudge (hearsay-tools/cezarion#1301): a
   *  blocked done at this turn end takes the second step. Every turn end sets or clears it. */
  completionNudgeAnswered?: AgentSession | undefined;
  /** Registry snapshot used to expand `/skill` follow-ups before a backend can
   *  mistake them for its own slash commands (#676). Only `RunManager.loadRunSkills` writes it,
   *  and only `RunManager.enabledSkills` reads it. */
  skills?: Skill[];
  /** The install a live `/name` started after its message went out (#1408); tests await it. */
  liveSkillProvisioning?: Promise<void>;
  /** Release for exclusive execution in the user's repository working tree.
   *  Worktree-backed runs never need it; root runs ordinarily do unless the
   *  explicit unsafe bypass is active. */
  releaseRepoRoot?: (() => void) | undefined;
  /** Durable directional-usage accounting state for the current runner
   * invocation. Provider-local turn ids are unique only within this epoch. */
  usageInvocation?: {
    stepId: string;
    epoch: number;
    observed: boolean;
    startedTurns: Set<string>;
    recordedTurns: Set<string>;
  };
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
 * `RunManager.loadRunSkills` loads it, from the same two callers.
 */
export function createActiveRun(init: ActiveRunInit): ActiveRun {
  return {
    delegationSettings: undefined, revokeDelegation: undefined,
    cancelled: false, interrupt: () => undefined, cwd: init.cwd,
    pendingHumanAsk: init.pendingHumanAsk,
    pendingPermissions: new Set(),
    autonomous: init.autonomous,
  };
}
