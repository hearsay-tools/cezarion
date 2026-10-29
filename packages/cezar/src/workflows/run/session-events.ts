import { randomUUID } from 'node:crypto';
import { askPayloadOf, askRequestOf } from '@open-mercato/cezar-contract/pending-ask';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import { AgentTempDirError } from '../../runs/agent-tmpdir.ts';
import { AgentAccountUnavailableError } from '../../workspace/agent-profiles.ts';
import { artifactInstructions } from '../../artifacts/lifecycle.ts';
import { handoffInstructions } from '../../handoff.ts';
import type { SessionContext } from '../../session-context.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import type { RunExitId } from '../run-states.ts';
import { openWaitsFooter } from '../waits.ts';
import { composeSystemPrompt, withResumeContext } from './prompts.ts';
import { isDisposedDelegatedRun } from './run-guards.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import { clearIdleTimer, clearHeldHumanInputTimer, clearUnreadInputTimer } from './input-timers.ts';
import { isRunnerActivity } from './turn-markers.ts';
import { recordUsageUiEvent } from './usage-accounting.ts';
import type { LaunchOpening, StepProfile } from './types.ts';
import type { RunLine } from './run-line.ts';
import type { HumanWaits } from './human-waits.ts';
import * as inputReceipts from './input-receipts.ts';

import type { AgentEvent, RunnerId } from '../../core/agent-runner.ts';
import { UiEventSink } from '../../runs/ui-event-sink.ts';
import type { ActiveRun } from '../active-run.ts';
import type { ExecutionEmit, LaunchCiTools, LaunchDelegation, RunModuleContext, SessionTurn } from './types.ts';
import { claudeScheduleWakeupDelay } from './turn-markers.ts';
import { recordReportedCost } from './usage-accounting.ts';

export interface SessionEventHost {
  disposedSessionEvent(runId: string, state: ActiveRun, event: AgentEvent): boolean;
  handleReceiptEvent(runId: string, state: ActiveRun, turn: SessionTurn, event: AgentEvent, stepId: string, emit: ExecutionEmit): boolean;
  recordSessionFault(state: ActiveRun, turn: SessionTurn, message: string): void;
  markTurnBoundary(runId: string, state: ActiveRun, event: Extract<AgentEvent, { type: 'turn-end' }>): void;
  trackTurnEnd(runId: string, text: string): void;
  endTurn(runId: string, state: ActiveRun, sink: UiEventSink, turn: { stepId: string; text: string; completedText: string; scheduleWakeup: number | null | undefined }): void;
}

export function createSessionEventHandler(context: RunModuleContext, host: SessionEventHost, options: {
  runId: string; state: ActiveRun; turn: SessionTurn; stepId: string; backend: RunnerId; sink: UiEventSink;
  tokenBase: number; emit: ExecutionEmit; acknowledge(): boolean;
}): (event: AgentEvent) => void {
  const { runId, state, turn, stepId, backend, sink, tokenBase, emit, acknowledge } = options;
  return (event) => {
    if (host.disposedSessionEvent(runId, state, event)) return;
    if (host.handleReceiptEvent(runId, state, turn, event, stepId, emit)) return;
    emit({ ...event, stepId });
    if (event.type === 'cost') recordReportedCost(context.store, runId, stepId, state, backend, event.usd);
    if (event.type === 'error') { host.recordSessionFault(state, turn, event.message); return; }
    if (turn.sessionError || state.agentInputError) return;
    if (event.type === 'session') {
      // Codex/OpenCode mint their own session id: persist it so resume works.
      context.store.updateStep(runId, stepId, { sessionId: event.sessionId, backend,
        ...(event.sessionTransport ? { sessionTransport: event.sessionTransport } : {}) });
    }
    if (event.type === 'token-usage') context.store.updateStep(runId, stepId, { tokensUsed: tokenBase + event.tokensUsed });
    const wakeDelay = claudeScheduleWakeupDelay(event, backend);
    if (wakeDelay !== undefined) turn.scheduleWakeup = wakeDelay;
    if (event.type === 'turn-end') {
      host.markTurnBoundary(runId, state, event);
      if (!acknowledge()) return;
      // v2 `turn.completed` already flushed the delta coalescers; the v1 turn boundary
      // flushes again (idempotent), so no buffered delta can outlive its turn.
      sink.flushAll();
      host.trackTurnEnd(runId, turn.text);
      const text = turn.text;
      const completedText = turn.completedText;
      turn.text = '';
      turn.completedText = '';
      turn.tail = 'none';
      const turnWakeDelay = turn.scheduleWakeup;
      turn.scheduleWakeup = undefined;
      host.endTurn(runId, state, sink, { stepId, text, completedText, scheduleWakeup: turnWakeDelay });
    }
  };
}

export interface LaunchPreambleHost {
  provisionSession(runId: string, state: ActiveRun): LaunchDelegation;
  agentWebhooksPart(): Promise<string | undefined>;
  provisionCiSession(runId: string, state: ActiveRun): Promise<LaunchCiTools>;
  launchStale(runId: string, state: ActiveRun, delegation: LaunchDelegation, ciTools: LaunchCiTools): boolean;
}

export async function launchPreamble(host: LaunchPreambleHost, runId: string, state: ActiveRun) {
  const delegation = host.provisionSession(runId, state);
  // Read before the cancellation checks below, which also cover this await (hearsay-tools/cezarion#1576).
  const webhooksPart = await host.agentWebhooksPart();
  const ciTools = await host.provisionCiSession(runId, state);
  const stale = host.launchStale(runId, state, delegation, ciTools);
  return { delegation, webhooksPart, ciTools, stale };
}


export interface SessionHelperHost {
  active: ReadonlyMap<string, ActiveRun>;
  line: RunLine;
  humanWaits: HumanWaits;
  inputReceiptHost: inputReceipts.InputReceiptsHost;
  move(runId: string, exit: RunExitId, patch?: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
  workerExecutionStopped(runId: string): boolean;
  executionBlockedByRootFinish(run: RunRecord): boolean;
  agentEnvForStep(runId: string, backend: RunnerId, options: { recordedProfileId?: string | undefined; stepId?: string | undefined }): Promise<StepProfile>;
  sessionContextFor(runId: string, state: ActiveRun, stepId: string, openingPrompt: string): SessionContext;
  automationsPart(): string | undefined;
  flushAgentInputs(runId: string): boolean;
  resumeParkedRun(runId: string, state: ActiveRun): void;
  noteNoWaitNudgeContent(runId: string, state: ActiveRun, event: { type: string; item?: { parentItemId?: string } }): void;
  parkedOnWorkers(runId: string): boolean;
  releaseSlot(): void;
  routeWorkerQuestion(runId: string): void;
}

/** Shutdown left this delegated run to restart recovery: its session's events are dropped, and an
 *  error still interrupts the session. */
export function disposedSessionEvent(context: RunModuleContext, host: SessionHelperHost, runId: string, state: ActiveRun, event: AgentEvent): boolean {
  if (!isDisposedDelegatedRun(context.store, context.disposed, runId)) return false;
  if (event.type === 'error') state.session?.interrupt();
  return true;
}

/** A session's fault: the first one stands, an agent input error recorded before it wins, and the
 *  session is interrupted. */
export function recordSessionFault(context: RunModuleContext, host: SessionHelperHost, state: ActiveRun, turn: SessionTurn, message: string): void {
  // Preserve the initiating fault: interrupt may fail an in-flight HTTP request.
  turn.sessionError ??= state.agentInputError ?? message;
  state.agentSessionError = turn.sessionError;
  state.session?.interrupt();
}

/** The session reached a turn end: retire the inputs it left unread, read the bundled inputs, and
 *  open the turn boundary with a fresh CI turn id. */
export function markTurnBoundary(context: RunModuleContext, host: SessionHelperHost, runId: string, state: ActiveRun, event: Extract<AgentEvent, { type: 'turn-end' }>): void {
  inputReceipts.retireUnreadInputs(context, host.inputReceiptHost, runId, state, event.unconsumedInputIds ?? [], false);
  inputReceipts.readBundledInputs(context, host.inputReceiptHost, runId, state);
  state.waitWakeTurn = undefined;
  state.atTurnBoundary = state.session;
  state.ciTurnId = randomUUID();
}

/**
 * The account a step's session spawns under, resolved together with the temp-directory preflight
 * (#785): the step fails with a named, actionable error instead of spawning a backend whose shell
 * would return empty output. An account that would open another folder than its own fails the
 * same way (#1283). Returns the profile, or that error's message.
 */
export async function stepProfileFor(context: RunModuleContext, host: SessionHelperHost,
  runId: string,
  stepBackend: RunnerId,
  options: { recordedProfileId?: string | undefined; stepId?: string | undefined },
): Promise<StepProfile | string> {
  try {
    return await host.agentEnvForStep(runId, stepBackend, options);
  } catch (err) {
    if (err instanceof AgentTempDirError || err instanceof AgentAccountUnavailableError) return err.message;
    throw err;
  }
}

/**
 * Pre-launch revalidation (hearsay-tools/cezarion#1632). Stop, a stopped execution, a replaced
 * active run or a root Finish can arrive while provisioning awaits. Then this launch's CI tools
 * and delegation are revoked, and the run state forgets each one only while it is still this
 * launch's. The caller settles the run.
 */
export function launchStale(context: RunModuleContext, host: SessionHelperHost, runId: string, state: ActiveRun, delegation: LaunchDelegation, ciTools: LaunchCiTools): boolean {
  const launchRun = context.store.getRun(runId);
  if (!(state.cancelled || host.workerExecutionStopped(runId) || host.active.get(runId) !== state ||
    (launchRun && host.executionBlockedByRootFinish(launchRun)))) return false;
  ciTools?.revoke();
  if (state.revokeCiTools === ciTools?.revoke) state.revokeCiTools = undefined;
  delegation?.revoke();
  if (state.revokeDelegation === delegation?.revoke) state.revokeDelegation = undefined;
  return true;
}

/** A launch's opening message (hearsay-tools/cezarion#1632): the body, the open-waits footer, the
 *  resume context of a Continue's checkpoint, then the session-start context in front. */
export function launchOpening(context: RunModuleContext, host: SessionHelperHost,
  runId: string,
  state: ActiveRun,
  stepId: string,
  launch: { body: string; ciTools: LaunchCiTools; checkpoint?: RunRecord['continuationMessage'] },
): LaunchOpening {
  // Opening prompts bypass live delivery; do not infer tools before provisioning finishes.
  const footer = openWaitsFooter(context.store.getRun(runId)?.waits ?? [], { tools: !!launch.ciTools });
  const prompt = withResumeContext(footer ? `${launch.body}\n\n${footer}` : launch.body, launch.checkpoint);
  const sessionContext = host.sessionContextFor(runId, state, stepId, prompt);
  return { userPrompt: sessionContext.prefix + prompt, handoffInjected: sessionContext.handoffInjected };
}

/**
 * The system prompt after the skill playbook (hearsay-tools/cezarion#1632): the run's extra
 * prompt, the delegation instructions, the automations and project webhooks parts, the artifact
 * contract, then the handoff contract.
 */
export function launchSystemTail(context: RunModuleContext, host: SessionHelperHost, launch: {
  extraSystemPrompt: string | undefined;
  delegation: LaunchDelegation;
  webhooksPart: string | undefined;
  env: StepProfile['env'];
  ciTools: LaunchCiTools;
  handoffInjected: boolean;
}): string {
  return composeSystemPrompt(
    launch.extraSystemPrompt,
    launch.delegation?.instructions,
    host.automationsPart(),
    launch.webhooksPart,
    artifactInstructions(launch.env.CEZ_ARTIFACTS_DIR),
    handoffInstructions({ tools: !!launch.ciTools, handoffInjected: launch.handoffInjected }),
  );
}

/** Some adapters return assistant text only in their final result. Preserve that
 * evidence for collection without duplicating an already persisted transcript. */
export function persistWorkerAssistantResult(context: RunModuleContext, host: SessionHelperHost, runId: string, stepId: string, text: string): void {
  if (context.store.getRun(runId)?.delegation?.role !== 'worker' || !text.trim()) return;
  const present = context.store.readEvents(runId).some(event => {
    if (event.stepId !== stepId) return false;
    const item = event.item as { kind?: string; role?: string; text?: string; parentItemId?: string } | undefined;
    return (event.type === 'text' && typeof event.text === 'string' && !!event.text.trim()) ||
      (event.type === 'item.completed' && item?.kind === 'message' && item.role === 'assistant' && !item.parentItemId && !!item.text?.trim());
  });
  if (!present) context.store.appendEvent(runId, { type: 'text', text, stepId });
}

/**
 * Protocol-v2 sink for one agent session (R2 step 2.1): the runner's
 * `onUiEvent` stream flows through here. Persisted snapshots ride the same
 * NDJSON file as v1 (the store stamps `seq`/`ts`, `appendEvent` fans them
 * out live too); coalesced `item.delta` flushes go out live-only via
 * `emitEphemeral` — raw deltas never hit disk (spec §performance
 * guardrails). One sink per session: cumulative usage dedup and the
 * item-shape cache are session-scoped, like the mapper state feeding them.
 */
export function makeUiSink(context: RunModuleContext, host: SessionHelperHost, runId: string, stepId: string): UiEventSink {
  return new UiEventSink({
    persist: (event) => context.store.appendEvent(runId, { ...event, stepId }),
    emitLive: (event) => context.store.emitEphemeral(runId, { ...event, stepId }),
  });
}

/** Native backend asks arrive before turn-end. Persist and park immediately
 * so the cockpit shows attention and the run releases its workspace slot. */
export function handleRunnerUiEvent(context: RunModuleContext, host: SessionHelperHost, runId: string, state: ActiveRun, sink: UiEventSink, event: UiEvent): void {
  if (isDisposedDelegatedRun(context.store, context.disposed, runId)) return;
  recordUsageUiEvent(context.store, runId, state, event);
  sink.handle(event);
  if (state.cancelled) return;
  host.noteNoWaitNudgeContent(runId, state, event);
  if (isRunnerActivity(event)) {
    if (state.autonomousNudgePending) { state.autonomousNudgePending = undefined; clearIdleTimer(state); }
    clearHeldHumanInputTimer(state);
    state.atTurnBoundary = undefined; state.doneAtBoundary = undefined; state.parkAfterAck = undefined;
  }
  if (event.type === 'permission.requested') {
    handlePermissionRequested(context, host, runId, state, event.requestId);
    return;
  }
  if (event.type === 'permission.resolved' && state.pendingPermissions?.delete(event.requestId)) {
    handlePermissionResolved(context, host, runId, state, state.pendingPermissions);
    return;
  }
  const ask = askPayloadOf(event);
  if (ask) {
    handleNativeAskRequested(context, host, runId, state, ask);
    return;
  }
  // Pi can resume autonomously when an async subagent completes — the mapper
  // synthesizes a parent `turn.started` for that work (#61). Nested child
  // items without a parent turn must not unpark monitoring or worker waits (#121).
  // A list worker park (hearsay-tools/cezarion#1235), Cezar's completion wait included
  // (hearsay-tools/cezarion#1301), resumes the same way.
  if (host.line.isParked(runId) && (host.line.inPool(runId) || host.parkedOnWorkers(runId)) && isRunnerActivity(event)) {
    host.resumeParkedRun(runId, state);
  }
}

export function handlePermissionRequested(context: RunModuleContext, host: SessionHelperHost, runId: string, state: ActiveRun, requestId: string): void {
  (state.pendingPermissions ??= new Set()).add(requestId);
  host.humanWaits.prepareHumanAsk(state);
  state.session?.discardQueuedMessages();
  clearIdleTimer(state);
  clearUnreadInputTimer(state);
  clearHeldHumanInputTimer(state);
  host.line.leavePool(runId); // released below; its waits stay open
  host.line.park(runId);
  host.move(runId, 'park', { hasPendingPermission: true });
  if (state.currentStepId) context.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
  host.releaseSlot();
  // Authorization is the human's, even when this run is an owned worker.
}

export function handlePermissionResolved(context: RunModuleContext, host: SessionHelperHost, runId: string, state: ActiveRun, pendingPermissions: ReadonlySet<string>): void {
  if (!pendingPermissions.size) {
    context.store.updateRun(runId, { hasPendingPermission: false });
    state.pendingHumanAsk = hasPendingHumanAsk(runId, id => pendingHumanAskSeq(context.store, id));
    if (!state.pendingHumanAsk && state.session?.open && !context.store.getRun(runId)?.stopping) {
      host.resumeParkedRun(runId, state);
      host.flushAgentInputs(runId);
    }
  }
}

export function handleNativeAskRequested(context: RunModuleContext, host: SessionHelperHost, runId: string, state: ActiveRun, ask: NonNullable<ReturnType<typeof askPayloadOf>>): void {
  host.humanWaits.prepareHumanAsk(state);
  // A native ask is a human wait the user already sees (hearsay-tools/cezarion#1234).
  const questions = askRequestOf({ questions: ask.questions })?.questions;
  const wait = host.humanWaits.openHumanAlias(runId, state, 'native-ask', questions ? { questions } : undefined);
  if (wait) host.humanWaits.markHumanWaitSurfaced(runId, wait, questions ? { questions } : undefined);
  clearIdleTimer(state);
  host.line.leavePool(runId); // released below; its waits stay open
  host.line.park(runId);
  host.move(runId, 'park');
  if (state.currentStepId) context.store.updateStep(runId, state.currentStepId, { status: 'waiting' });
  host.releaseSlot();
  host.routeWorkerQuestion(runId);
}
