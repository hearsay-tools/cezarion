import type { AgentInput } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../../runs/store.ts';
import { agentInputBatch } from '../../delegation/input.ts';
import type { ActiveRun } from '../active-run.ts';
import { chargesBudget, chargesBudgetMessage, resolvedWaits } from '../waits.ts';

/** The conversation messages the next submission would carry, if nothing but
 * conversation input leads the queue (lifecycle input stays a barrier). */
export function pendingConversationBatch(run: RunRecord | undefined, state: ActiveRun, formatAgentInput: (input: AgentInput) => string, answerId?: string): { inputs: AgentInput[]; text: string } | undefined {
  // The answer this batch rides on settles every human wait, so only a CI or timer wait holds it
  // (hearsay-tools/cezarion#1234).
  if (!run || run.waits?.some(wait => wait.kind !== 'human') || state.agentInputFlight) return undefined;
  const batch = agentInputBatch((run.agentInputs ?? []).filter(input => input.id !== state.openingAgentInputId && input.id !== answerId),
    input => formatAgentInput(input));
  return batch?.inputs.every(input => input.conversation) ? batch : undefined;
}

/** A batch with timer results is an automatic wake, and so is an admitted wake turn a peer message
 *  opens (spec 2026-10-27-task-communication-protocol § 8). Past the budget a peer message opens
 *  no turn (`pendingConversationWakes`), so one carried by another wake is free. */
export function reservesAutomaticWake(run: RunRecord | undefined, flight: NonNullable<ActiveRun['agentInputFlight']>, inputIds: readonly string[], automaticWakes: () => number, MAX_AUTO_CONTINUES: number): boolean {
  if (resolvedWaits(run ?? {}).some(wait => chargesBudget(wait) && inputIds.includes(wait.id))) return true;
  return !!flight.admittedWake && automaticWakes() < MAX_AUTO_CONTINUES &&
    !!run?.agentInputs?.some(input => inputIds.includes(input.id) && chargesBudgetMessage(input));
}

export function formatAgentInput(input: AgentInput, getRun: (runId: string) => RunRecord | undefined): string {
  const attribution = input.conversation;
  const text = attribution ? `Agent conversation ${JSON.stringify({ id: input.id, ...attribution })}\n${input.text}` : input.text;
  return text + agentInputOutcomeText(input, getRun(input.parentRunId));
}

export function agentInputOutcomeText(input: AgentInput, root: RunRecord | undefined): string {
  const outcome = input.conversation && root?.delegation?.role === 'root' ? root.delegation.conversation?.outcomes.find(entry =>
    entry.requestId === (input.conversation?.requestId ?? input.id)) : undefined;
  return outcome ? `\nRequest outcome: ${outcome.status}. This delivery does not reopen the settled request.` : '';
}
