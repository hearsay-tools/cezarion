import { randomUUID } from 'node:crypto';
import type { AgentInput } from '@open-mercato/cezar-contract/delegation';
import type { ContentBlock } from '../../core/agent-runner.ts';
import type { AgentSession } from '../../core/claude-cli-runner.ts';
import type { AskRequest } from '../../core/ask.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import { enqueueAgentInput, hasLiveInboxClaim } from '../../delegation/input.ts';
import { recordRequestRefusal, type CompletionRefusal } from '../completion-policy.ts';
import { NO_WAIT_NUDGE_NOTE, NO_WAIT_NO_REPLY_NOTE, COMPLETION_NO_REPLY_NOTE, COMPLETION_NUDGE_NOTE, AUTONOMOUS_ASK_NOTE, AUTONOMOUS_NUDGE, stepScopedNudge, type TurnEndOutcome } from '../turn-end.ts';
import type { ActiveRun } from '../active-run.ts';
import type { RunExitId } from '../run-states.ts';
import { clearIdleTimer, clearNoWaitNudgeReplyTimer, harnessOwesInput } from './input-timers.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import * as completionGateReads from './completion-gate.ts';
import type { HumanWaits } from './human-waits.ts';
import type { RunLine } from './run-line.ts';
import type { RunModuleContext } from './types.ts';

interface TurnNudgesHost {
  active: Map<string, ActiveRun>;
  move(id: string, exit: RunExitId, patch: Omit<Parameters<RunStore['updateRun']>[1], 'status'>): RunRecord | undefined;
  workerExecutionStopped(id: string): boolean;
  executionBlockedByRootFinish(run: RunRecord): boolean;
  countAutomaticWakes(id: string): number;
  hasQueuedAgentInputs(id: string): boolean;
  submitAgentInput(id: string, state: ActiveRun, content: ContentBlock[]): boolean;
  resumeParkedRun(id: string, state: ActiveRun): void;
  chargeAutomaticWake(id: string): number;
  retryWaitAdmission(id: string): void;
  armIdleTimer(id: string, state: ActiveRun): void;
  openTurnEndHumanWait(id: string, state: ActiveRun, step: string | undefined, via: 'no-wait' | 'budget', note: string): void;
  settledTurnOutcome(id: string, entry: 'turn-end' | 'ack' | 'ready' | 'gate' | 'reply-timer', outcome: TurnEndOutcome): TurnEndOutcome | undefined;
  queueWaitWake(id: string): void;
  noWaitNudgeReplyMs(): number;
}

export class TurnNudges {
  constructor(private readonly context: RunModuleContext, private readonly humanWaits: HumanWaits,
    private readonly line: RunLine, private readonly completionGateHost: completionGateReads.CompletionGateHost,
    private readonly host: TurnNudgesHost, private readonly maxAutoContinues: number, private readonly completionWillWait: string) {}
  awaitCompletionNudgeReply(runId: string, state: ActiveRun, session: AgentSession): void {
    state.completionNudged = session;
    const refusal = completionGateReads.completionRefusal(this.context, this.completionGateHost, runId);
    if (refusal) recordRequestRefusal(state, refusal);
    state.noWaitNudgeSawContent = false;
    clearIdleTimer(state);
    this.armNoWaitNudgeReplyTimer(runId, state);
  }

  queueCompletionRefusal(runId: string, refusal: CompletionRefusal): boolean {
    const state = this.host.active.get(runId);
    this.context.store.appendEvent(runId, { type: 'note', tone: 'warning', message: `Completion blocked: ${refusal.message}` });
    this.host.move(runId, 'park', { finishedAt: undefined });
    this.context.store.flush();
    if (this.humanWaits.holdsAgentWaits(runId)) return true;
    // One refusal owed at a time: the copy already queued reopens the run (hearsay-tools/cezarion#1301).
    if (completionGateReads.owesCompletionRefusal(this.context, this.completionGateHost, runId)) {
      try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
      return true;
    }
    if (this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) {
      this.humanWaits.surfaceHumanWait(runId, state, this.humanWaits.openHumanAlias(runId, state, 'budget'));
      return true;
    }
    const text = refusal.liveWorkerIds.length ? `${refusal.message} ${this.completionWillWait}` : refusal.message;
    // Its purpose is on the persisted input, so a Continue after a failed run and a restart still
    // deliver it as the nudge (hearsay-tools/cezarion#1301).
    const input: AgentInput = { id: randomUUID(), parentRunId: runId, source: 'lifecycle', purpose: 'completion-refusal', text, createdAt: new Date().toISOString() };
    // The refusal is queued with its charge (hearsay-tools/cezarion#1805): no restart delivers it uncharged.
    const spent = (this.context.store.getRun(runId)?.automaticWakes ?? 0) + 1;
    try {
      enqueueAgentInput(this.context.store.getRun(runId)!, input);
      this.context.store.commitOutcome(runId, { kind: 'charged', automaticWakes: spent }, { enqueue: [input] });
    } catch (error) {
      console.warn(`[cez] completion refusal not queued: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
    this.context.store.appendEvent(runId, { type: 'agent-input', input });
    this.context.store.appendEvent(runId, { type: 'note', message: `${COMPLETION_NUDGE_NOTE} (${spent}/${this.maxAutoContinues}): ${refusal.code}` });
    try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
    return true;
  }

  retireCompletionRefusal(runId: string): boolean {
    const inputs = this.context.store.getRun(runId)?.agentInputs ?? [];
    const kept = inputs.filter(input => input.deliveredAt || input.purpose !== 'completion-refusal' || hasLiveInboxClaim(input));
    if (kept.length === inputs.length) return false;
    try { this.context.store.commitAgentInputs(runId, kept); }
    catch (error) {
      console.warn(`[cez] completion refusal not retired: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    return true;
  }

  canAutoContinue(runId: string, state: ActiveRun): boolean {
    const run = this.context.store.getRun(runId);
    return !!run && !this.context.disposed() && !run.stopping && !state.cancelled && !state.finishRequested &&
      !state.agentInputError && !state.pendingHumanAsk && !hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id)) && !!state.session?.open &&
      !this.host.workerExecutionStopped(runId) && !this.host.executionBlockedByRootFinish(run) && !run.waits?.length &&
      !state.agentInputFlight && !harnessOwesInput(state) && !this.host.hasQueuedAgentInputs(runId);
  }

  tryAutonomousNudge(runId: string, state: ActiveRun, stepId: string, ask: AskRequest | null,
    text = stepScopedNudge(AUTONOMOUS_NUDGE, !!state.session && state.nextStep?.session === state.session)): boolean {
    const session = state.session;
    if (!state.autonomous || !session || !this.canAutoContinue(runId, state)) return false;
    state.autonomousNudgePending = undefined;
    clearIdleTimer(state);
    // One budget with the timer wakes (hearsay-tools/cezarion#1234).
    if (this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) {
      this.context.store.appendEvent(runId, { type: 'note', stepId, message: `autonomous — safety cap reached (${this.maxAutoContinues}); automatic continuation paused` });
      return false;
    }
    const content: ContentBlock[] = [{ type: 'text', text }];
    // sendAgentMessage deliberately refuses portable asks on some native wires.
    // The existing answer transport clears that marker, but is safe ONLY for this
    // fresh turn-end ask line: the guards above exclude every pending native/persisted
    // question. Do not route via deliverMessage, which attributes a human answer.
    // Ordinary nudges keep #505's acknowledged agent-input failure semantics.
    const sent = ask ? session.sendMessage(content) : this.host.submitAgentInput(runId, state, content);
    if (!sent) {
      // An unregistered ask line uses sendMessage: its POST may still be awaiting ACK
      // after the next SSE turn ends. It is not an agentInputFlight. Keep this
      // exact boundary running until onAgentInputReady retries, without charging
      // the cap or claiming delivery. Missing readiness closes via the idle bound.
      if (!ask && session.open && !state.agentInputError && !state.agentSessionError) {
        state.autonomousNudgePending = session;
        this.host.armIdleTimer(runId, state);
      }
      return false;
    }
    if (ask) this.host.resumeParkedRun(runId, state);
    // The marker is stripped from visible text. Retain the question as a note,
    // never an ask card or a fabricated human-input-delivered acknowledgement.
    if (ask) this.context.store.appendEvent(runId, {
      type: 'note', stepId,
      message: `${AUTONOMOUS_ASK_NOTE}: ${ask.questions.map(question => question.question).join(' | ')}`,
    });
    const spent = this.host.chargeAutomaticWake(runId);
    this.context.store.appendEvent(runId, {
      type: 'note', stepId,
      message: `autonomous — continuing without pausing (${spent}/${this.maxAutoContinues})`,
    });
    return true;
  }

  sendTurnEndNudge(runId: string, state: ActiveRun, stepId: string | undefined, text: string): boolean {
    if (state.autonomous) return !!stepId && this.tryAutonomousNudge(runId, state, stepId, null, text);
    if (!this.canAutoContinue(runId, state)) return false;
    state.noWaitNudgeSawContent = false;
    if (!this.host.submitAgentInput(runId, state, [{ type: 'text', text }])) return false;
    state.noWaitNudged = state.session;
    clearIdleTimer(state);
    this.armNoWaitNudgeReplyTimer(runId, state);
    const spent = this.host.chargeAutomaticWake(runId);
    this.context.store.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: `${NO_WAIT_NUDGE_NOTE} (${spent}/${this.maxAutoContinues})` });
    return true;
  }

  /** Heartbeats and nested subagent items are not a reply. A `turn.started` counts only while the
   *  reply timer runs or after it expired on this session: OpenCode and Cursor emit a synthetic one
   *  inside `sendAgentMessage`, and a later send goes through `submitAgentInput`, which resumes. */
  isNoWaitNudgeReply(state: ActiveRun, event: { type: string; item?: { parentItemId?: string } }): boolean {
    if (event.type === 'turn.started') return state.noWaitNudgeReplyTimer !== undefined || state.noWaitNudgeParked === state.session;
    if (event.type === 'text' || event.type === 'tool-call' || event.type === 'tool-result') return true;
    if (event.type === 'item.delta' || !event.type.startsWith('item.')) return false;
    return event.item?.parentItemId === undefined;
  }

  noteNoWaitNudgeContent(runId: string, state: ActiveRun, event: { type: string; item?: { parentItemId?: string } }): void {
    if (!this.isNoWaitNudgeReply(state, event)) return;
    state.noWaitNudgeSawContent = true;
    clearNoWaitNudgeReplyTimer(state);
    if (state.noWaitNudgeParked !== state.session || !this.line.isParked(runId)) return;
    if (state.pendingHumanAsk || hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store, id))) return;
    this.host.resumeParkedRun(runId, state);
    state.noWaitNudgeParked = undefined;
  }

  armNoWaitNudgeReplyTimer(runId: string, state: ActiveRun): void {
    clearNoWaitNudgeReplyTimer(state);
    if (state.noWaitNudgeSawContent) return;
    const session = state.session;
    if (!session?.open) return;
    const timer = setTimeout(() => {
      state.noWaitNudgeReplyTimer = undefined;
      if (this.context.disposed() || this.host.active.get(runId) !== state || state.session !== session || !session.open ||
        state.cancelled || state.finishRequested || this.line.isParked(runId)) return;
      state.noWaitNudgeParked = session;
      // The note names the nudge left unanswered (hearsay-tools/cezarion#1301).
      this.host.openTurnEndHumanWait(runId, state, state.currentStepId, 'no-wait', state.completionNudged === session ? COMPLETION_NO_REPLY_NOTE : NO_WAIT_NO_REPLY_NOTE);
      this.host.settledTurnOutcome(runId, 'reply-timer', { kind: 'park', keepsSlot: false });
    }, this.host.noWaitNudgeReplyMs());
    timer.unref?.();
    state.noWaitNudgeReplyTimer = timer;
  }
}
