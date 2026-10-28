import type { DiscoveredTasks, DiscoveryRequest } from '@open-mercato/cezar-contract/discovery';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import type { RunStore } from '../runs/store.ts';
import { finishing, isRootTask } from './conversations.ts';
import { DelegationPolicyError } from './policy.ts';

/** Read stored summaries too: review and terminal peers must remain discoverable. */
export function discoverTasks(store: RunStore, callerId: string, request: Extract<DiscoveryRequest, { kind: 'tasks' }>): DiscoveredTasks {
  const caller = store.getRun(callerId);
  if (caller?.delegation?.role !== 'root' || caller.delegation.historyDeletion) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
  const page = store.listPeerTaskSummaries({ callerId, ...request });
  const tasks = page.runs.flatMap(run => {
    const current = store.getRun(run.id);
    if (!isRootTask(current) || (current.delegation?.role === 'root' && current.delegation.historyDeletion)) return [];
    const attention = deriveAttention(run);
    const accepts = ['queued', 'running', 'waiting'].includes(current.status) && !current.stopping && !finishing(current);
    const state = current.stopping ? 'stopping' : finishing(current) ? 'finishing' : current.status;
    return [{ id: run.id, title: run.titleSummary ?? run.title, ...(run.runner === undefined ? {} : { runner: run.runner }),
      status: run.status, attention: attention.bucket, attentionLabel: attention.label, accepts,
      ...(accepts ? {} : { reason: `${state}: only its human can continue it` }) }];
  });
  return { tasks, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
}
