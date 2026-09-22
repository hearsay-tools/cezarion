import { agentInputSchema, type AgentInput } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { DelegationPolicyError } from './policy.ts';

/** Pure admission: callers persist the returned queue before attempting delivery. */
export function enqueueAgentInput(run: RunRecord, input: AgentInput): AgentInput[] {
  if (!['queued', 'running', 'waiting'].includes(run.status) ||
    (run.delegation?.role === 'worker' && run.delegation.destroy)) {
    throw new DelegationPolicyError('incompatible_state', 'run state does not accept agent input');
  }
  const parsed = agentInputSchema.parse(input);
  if (parsed.deliveredAt) throw new DelegationPolicyError('invalid_input', 'new input cannot already be delivered');
  const queue = run.agentInputs ?? [];
  if (queue.some(entry => entry.id === parsed.id)) throw new DelegationPolicyError('invalid_input', 'duplicate input ID');
  if (queue.filter(entry => !entry.deliveredAt).length >= 32) {
    throw new DelegationPolicyError('capacity_limit', 'agent input capacity reached');
  }
  return [...queue, parsed];
}

export function nextAgentInput(queue: readonly AgentInput[], pendingHumanAsk: boolean): AgentInput | undefined {
  return pendingHumanAsk ? undefined : queue.find(input => !input.deliveredAt);
}

/** Drain a bounded FIFO snapshot of conversations into one provider turn. Lifecycle
 * inputs remain barriers, and an individually valid large message is never split. */
export function agentInputBatch(queue: readonly AgentInput[], format: (input: AgentInput) => string): { inputs: AgentInput[]; text: string } | undefined {
  const inputs: AgentInput[] = []; const parts: string[] = []; let length = 0;
  for (const input of queue) {
    if (input.deliveredAt) continue;
    if (inputs.length && (!inputs[0]!.conversation || !input.conversation)) break;
    const text = format(input);
    if (inputs.length && length + 2 + text.length > 100_000) break;
    inputs.push(input); parts.push(text); length += text.length + (parts.length > 1 ? 2 : 0);
    if (inputs.length === 32) break;
  }
  return inputs.length ? { inputs, text: parts.join('\n\n') } : undefined;
}
