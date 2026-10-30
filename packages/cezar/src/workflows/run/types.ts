import type { TrackedWork } from './tracked-work.ts';
import type { HumanWaitEntry } from '@open-mercato/cezar-contract/waits';
import type { AskRequest } from '../../core/ask.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import type { ScheduleTaskAnswer, ScheduleTaskRequest, ScheduledTasksAnswer, ScheduledTasksRequest } from '@open-mercato/cezar-contract/scheduled-tasks';
import type { ContentBlock, RunnerId, ToolGrant } from '../../core/agent-runner.ts';
import type { CiToolSession } from '../../ci-wait/controller.ts';
import type { loadConfig } from '../../config.ts';
import type { WorkerAccountBinding } from '../../delegation/execution-identity.ts';
import type { DelegationSession } from '../../delegation/provision.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import type { PastedContent, PersistedAttachment } from '../pasted-content.ts';
import type { WorkflowDef, WorkflowStepDef } from '../types.ts';

export type { FileBlock, PastedContent, PersistedAttachment } from '../pasted-content.ts';

export type TurnTail = 'none' | 'visible' | 'silent';

export type DelegationExecutionSettings = { cwd: string; runner: RunnerId; model?: string | undefined; modelIdentity?: string | undefined; effort?: string | undefined; agentProfile: string; accountBinding?: WorkerAccountBinding | undefined; systemPrompt?: string | undefined; allowedTools?: string[] | undefined; bashAllowlist?: string[] | undefined };

export interface StartRunInput {
  task: string;
  model?: string | undefined;
  /** Reasoning-effort pin (#45). Canonical `low`/`medium`/`high`/`xhigh`/`max`.
   *  Unset = harness default. Same class of override as `model`. */
  effort?: string | undefined;
  /** Agent backend chosen for this task (GUI). Unset = the config default. */
  runner?: RunnerId | undefined;
  /** Agent account for this task (spec 2026-07-29-agent-profiles), applying to steps that run
   *  on `runner`. Unset = the project's own selection. Persisted on the record so the choice
   *  survives into resume and Continue, and so the thread can say which account did the work. */
  agentProfile?: string | undefined;
  /** Attachments pasted into the new-task form — persisted when the run is created and
   *  delivered once, with the first agent step's opening message. Images ride along as blocks the
   *  model can view; a file (#950) only ever reaches the agent as the path it was written to. */
  images?: PastedContent[] | undefined;
  /** Per-run system-prompt override (`POST /api/runs`, programmatic callers).
   *  Replaces the `config.json` default for this run — see
   *  `resolveExtraSystemPrompt` for the precedence contract. */
  systemPrompt?: string | undefined;
  /** Composer opt-out (#worktree-toggle): `false` runs the task in the repo
   *  working tree instead of an isolated worktree. Undefined/`true` keeps the
   *  default per-task worktree. */
  worktree?: boolean | undefined;
  /** Autonomous mode (#autonomous): eligible turn ends auto-continue until done
   *  or the safety cap. Native asks, input delivery and lifecycle waits still apply. */
  autonomous?: boolean | undefined;
  archiveWhenDone?: boolean | undefined;
  autoMergePr?: boolean | undefined;
  /** Task webhook opt-in (#589). Persisted on the record at creation; read from there after. */
  notify?: boolean | undefined;
  /** Attachments from the queued prompt stack (#472), re-encoded from disk by
   *  `hydrateQueuedInput` at dequeue. Kept separate from `images` because those
   *  are persisted into `taskImages` by `startRun()` — folding
   *  the stack's (already-persisted) files in there would write duplicate files
   *  and make the task bubble render the stack's images as its own. In-memory
   *  only: rebuilt from the record on every hydration, never persisted. */
  stackedImages?: ContentBlock[] | undefined;
  /** Automation provenance (hearsay-tools/cezarion#1465). Written by `createRun` in the row that
   *  creates the run, so a receipt never points at nothing after a crash. */
  automation?: RunRecord['automation'];
  automationTrigger?: RunRecord['automationTrigger'];
}

export interface PendingContinuation {
  stepId: string;
  sessionId: string | undefined;
  backend: RunnerId;
  prompt: string;
  /** Attachments the user pasted into the follow-up composer — images to view, files (#950) to
   *  be given the path of. Persisted when the continuation actually opens, not here. */
  images: PastedContent[];
  /** When this continuation joined the line (epoch ms). A queued continuation is a wake of a run
   *  already in progress, so it goes ahead of unstarted runs, oldest first (`nextLineEntry`). */
  lineJoinedAt: number;
}

/** What `execute` writes to its run's event stream. */
export type ExecutionEmit = (event: { type: string; stepId?: string; [k: string]: unknown }) => void;

/** One `execute` call: what its phases share. */
export type Execution = { runId: string; workflow: WorkflowDef; input: StartRunInput; startAt: number; state: ActiveRun; emit: ExecutionEmit };

/** What `startExecution` resolved before the first step. */
export type ExecutionLaunch = {
  config: Awaited<ReturnType<typeof loadConfig>>;
  taskBackend: RunnerId;
  extraSystemPrompt: string | undefined;
  /** The run record as it was before `startExecution` recorded the start. */
  ownedRun: RunRecord | undefined;
  /** An owned worker's workspace. */
  owned: Extract<NonNullable<RunRecord['delegation']>, { role: 'worker' }>['workspace'] | undefined;
};

/** The state of `execute`'s step loop, which `settleExecution` reads once the loop ended. */
export type StepLoop = {
  /** A failed check's output, handed to the agent step its retry loops back to. */
  checkFailure: string | null;
  runError: string | null;
  deliveryCapped: boolean;
  /** An earlier step whose session closed without a done (hearsay-tools/cezarion#1620). */
  incompleteStepId?: string;
};

/** What a launched session's callbacks share (hearsay-tools/cezarion#1632): the turn in progress
 *  and the session's first fault. */
export type SessionTurn = {
  text: string;
  completedText: string;
  tail: TurnTail;
  /** The delay a Claude ScheduleWakeup call asked for in this turn. */
  scheduleWakeup: number | null | undefined;
  /** The fault that ended the session; an agent input error recorded before it wins. */
  sessionError: string | undefined;
};

/** The delegation capability and the CI tools one launch provisioned. */
export type LaunchDelegation = DelegationSession | undefined;

export type LaunchCiTools = CiToolSession | undefined;

/** A launch's opening message, and whether its session-start context carries the handoff. */
export type LaunchOpening = { userPrompt: string; handoffInjected: boolean };

/** The account a step's session runs under: its profile, environment and account binding. */
export type StepProfile = { env: Record<string, string>; profileId: string; accountBinding?: WorkerAccountBinding | undefined };

/** The model and effort a fresh step's session runs with. */
export type StepModel = { backendModel: string | undefined; effectiveEffort: string | undefined };

/** What `runAgentStep` resolved before it starts the step's session. */
export type StepSessionLaunch = {
  step: WorkflowStepDef;
  sessionId: string;
  images: ContentBlock[] | undefined;
  opening: LaunchOpening;
  skillPrompt: string | undefined;
  extraSystemPrompt: string | undefined;
  toolGrant: ToolGrant;
  profile: StepProfile;
  model: StepModel;
  delegation: LaunchDelegation;
  webhooksPart: string | undefined;
  ciTools: LaunchCiTools;
};

/** An owned worker's delegation record. */
export type WorkerDelegationRecord = Extract<NonNullable<RunRecord['delegation']>, { role: 'worker' }>;

/** A Continue's opening message and what it carries: the checkpoint it replays, whether it is a
 *  parent's answer to a routed question (#505), and the images and attachments it hands over. */
export type ContinuationOpening = {
  prompt: string;
  checkpoint: RunRecord['continuationMessage'];
  parentAnswer: boolean;
  openingImages: ContentBlock[];
  attachments: PersistedAttachment[];
};

/** The human ask a Continue's opening message answers, and the human waits that answer settles
 *  when the opening turn ends. The turn end clears `askSeq`. */
export type OpeningAnswer = { askSeq: number | undefined; waits: string[]; parentAnswer: boolean };

/** What a Continue resolved before its pre-spawn checks: the step that owns its session, the
 *  workflow step it extends, and its tool grant, model, effort and account. */
export type ContinuationSettings = {
  owningStep: RunRecord['steps'][number] | undefined;
  toolsStep: WorkflowStepDef | undefined;
  toolGrant: ToolGrant;
  backendModel: string | undefined;
  effort: string | undefined;
  profile: StepProfile;
  /** The run's extra system prompt, which workers inherit. */
  extraSystemPrompt: string | undefined;
};

/** The continued step's skill playbook, for the system prompt or for the fallback system prompt of
 *  an in-thread resume, and the skill files the opening message names. */
export type ContinuationSkills = { skillPrompt: string | undefined; fallbackSkillPrompt: string | undefined; files: Map<string, string> };

/** What `runContinuation` resolved before it starts the Continue's session. */
export type ContinuationSessionLaunch = {
  stepId: string;
  sessionId: string | undefined;
  prompt: string;
  setupNote: string | undefined;
  opening: ContinuationOpening;
  skills: ContinuationSkills;
  skipSkillOnResume: boolean;
  settings: ContinuationSettings;
  delegation: LaunchDelegation;
  webhooksPart: string | undefined;
  ciTools: LaunchCiTools;
};

/** The workflow remainder a successful Continue queues once its session is released. */
export type ContinuationClose = { resumeWorkflow?: { workflow: WorkflowDef; input: StartRunInput; startAt: number } | undefined };

/** #469: why destroy could not prove a crashed generation's termination. */
export type WorkerTerminationBlocker = { kind: 'unreadable' } | { kind: 'controller'; pid: number } | { kind: 'processes'; pids: number[] };

/** hearsay-tools/cezarion#1465: what `startServer` hands a manager for the schedule tools. */
export type AutomationToolService = {
  scheduleTask(request: ScheduleTaskRequest): Promise<ScheduleTaskAnswer>;
  scheduledTasks(request: ScheduledTasksRequest): Promise<ScheduledTasksAnswer>;
};

/** Shared dependencies for state-owning run modules. */
export interface RunModuleContext {
  readonly work: TrackedWork;
  store: import('../../runs/store.ts').RunStore;
  repoRoot: string;
  dataDir: string;
  semaphore: import('../../workspace/semaphore.ts').WorkspaceSemaphore;
  disposed(): boolean;
  /** Sweeps the project's merged branches after a retention pass (hearsay-tools/cezarion#2268).
   *  `serve` supplies it; `cez run` and tests leave it out. */
  sweepBranches?: ((keep: number) => void) | undefined;
}

/** What a turn end said, as the entry that settles it reads it (hearsay-tools/cezarion#1525). The
 *  turn end reads it from the turn; a later entry from what `parkAfterAck` kept (`boundaryTurn`). */
export type SettledTurn = {
  stepId: string | undefined;
  monitoring: boolean;
  humanGate: boolean;
  /** This turn's ask, which the turn end surfaces as a card; a later entry has none. */
  ask: AskRequest | null;
  /** The ask line's autonomous nudge went instead of the question. */
  askNudged: boolean;
  humanWait?: HumanWaitEntry | undefined;
  sink?: UiEventSink;
  done: boolean;
  doneRequest?: ActiveRun['doneRequested'];
  /** The turn answered the no-wait nudge. The completion cause's flag is `completionNudgeAnswered`. */
  nudgedLastTurn: boolean;
  scheduleWakeup?: number | null | undefined;
};

/** What re-reading a message's persisted attachments yields: viewable blocks for the images, and
 *  a path for every attachment including the files that have no block. */
export interface PersistedAttachments {
  blocks: ContentBlock[];
  attachments: PersistedAttachment[];
}

/** Only the synchronous delivery of a human answer uses the budget its reset replaced. */
export type HumanAnswerBudget = { spent: number };
