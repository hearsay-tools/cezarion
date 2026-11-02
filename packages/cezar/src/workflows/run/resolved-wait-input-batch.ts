import type { AgentInput } from '@open-mercato/cezar-contract/delegation';
import type { RunRecord } from '../../runs/store.ts';
import { agentInputBatch } from '../../delegation/input.ts';
import { resolvedWaits, waitInputId, waitResultText } from '../waits.ts';

export function resolvedWaitInputBatch(
  run: RunRecord,
  resolved: ReturnType<typeof resolvedWaits>,
  queue: AgentInput[],
  format: (input: AgentInput) => string,
  options: Parameters<typeof waitResultText>[1],
): { text: string; inputIds: string[] } | undefined {
  // One wake turn delivers every resolved wait, oldest first, then the conversation input
  // that would lead the next batch (hearsay-tools/cezarion#1233).
  const results = resolved.flatMap(wait => {
    const input = run.agentInputs?.find(entry => entry.id === waitInputId(wait) && !entry.deliveredAt);
    if (!input) return [];
    const result = waitResultText(wait, options);
    // An upgraded wait whose wake is a queued message (`wakeInputId`) delivers that message
    // with its receipt; only a lifecycle input is replaced by the result.
    return [{ id: input.id, text: input.source === 'lifecycle' ? format({ ...input, text: result })
      : `${format(input)}\n\n${result}` }];
  });
  if (!results.length) return undefined;
  const conversation = agentInputBatch(queue, input => format(input));
  const following = conversation?.inputs.every(input => input.conversation) ? conversation.inputs : [];
  const text = [...results.map(result => result.text), ...following.map(input => format(input))].join('\n\n');
  return { text, inputIds: [...results, ...following].map(input => input.id) };
}
