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
