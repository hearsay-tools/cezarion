import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RunStore } from '../runs/store.ts';

/** Persisted terminal family with an observation that has not yet been projected. */
export function seedSettledFamily(store: RunStore, root: string) {
  const parent = store.createRun({ title: 'historical parent', task: 'history', workflow: 'quick-task', steps: [] });
  store.updateRun(parent.id, { delegation: { role: 'root', permissions: [], receipts: [] } });
  const workerId = randomUUID();
  const worker = store.createOwnedRun({ title: 'historical worker', task: 'history', workflow: 'quick-task', steps: [] }, parent.id, randomUUID(), {
    role: 'worker', parentRunId: parent.id, permissions: [], workspace: {
      ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
      path: join(root, 'workers', workerId), branch: `cez/${workerId.slice(0, 8)}`, baselineSha: '0'.repeat(40),
    },
  }, 'a'.repeat(64));
  store.updateRun(worker.id, { status: 'done' });
  store.updateRun(parent.id, { status: 'done' });
  const messageId = randomUUID();
  // Seed before RunManager construction in unit tests; native-wire tests only use
  // this family as unrelated history and permit its initial projection.
  store.commitConversation(parent.id, { messages: [{ id: messageId, senderRunId: parent.id, recipientRunId: worker.id,
    kind: 'progress', text: 'Historical progress', createdAt: new Date().toISOString(), requestHash: 'b'.repeat(64), state: 'accepted' }], outcomes: [] });
  return { parentId: parent.id, workerId: worker.id, messageId };
}

export function cleanupCheckpoint(store: RunStore, workerId: string) {
  const worker = store.getRun(workerId)!;
  if (worker.delegation?.role !== 'worker') throw new Error('expected worker');
  store.commitDelegation([{ id: workerId, delegation: { ...worker.delegation,
    destroy: { requestedAt: new Date().toISOString(), phase: 'terminating', remaining: ['process', 'worktree', 'branch'] },
  } }]);
}
