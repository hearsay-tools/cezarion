import type { AgentEvent, RunnerId } from '../../core/agent-runner.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
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
