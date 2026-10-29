import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { projectConversationEvents } from '../../delegation/conversations.ts';
import { RunStore } from '../../runs/store.ts';
import { readPersistedRuns } from '../../runs/run-store.testkit.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createActiveRun } from '../active-run.ts';
import { recordOpeningAccepted } from './input-receipts.ts';

let root: string;
let store: RunStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cez-opening-receipt-')); store = RunStore.open(root); });
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }); });

function opening() {
  const parent = store.createRun({ title: 'parent', workflow: 'quick-task', task: 'parent', steps: [] });
  const recipient = store.createRun({ title: 'recipient', workflow: 'quick-task', task: 'recipient', steps: [] });
  const message = { id: randomUUID(), senderRunId: parent.id, recipientRunId: recipient.id, kind: 'request' as const,
    text: 'Resume the work', createdAt: new Date().toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const, resumed: true as const };
  store.commitDelegation([{ id: parent.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
  store.commitConversation(parent.id, { messages: [message], outcomes: [] }, { recipientRunId: recipient.id,
    input: { id: message.id, source: agentInputSchema.shape.source.enum.agent, parentRunId: parent.id, text: message.text, createdAt: message.createdAt,
      conversation: { senderRunId: parent.id, recipientRunId: recipient.id, kind: 'request' } } });
  store.updateRun(recipient.id, { continuationMessage: { id: 'continue-1', agentInputId: message.id,
    text: message.text, createdAt: message.createdAt, origin: 'lifecycle' } });
  store.flush();
  projectConversationEvents(store, store.getRun(parent.id)!);
  const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  state.openingAgentInputId = message.id;
  const host = { reconcileWorkerWaits: vi.fn(() => projectConversationEvents(store, store.getRun(parent.id)!)),
    flushAgentInputs: vi.fn(), isCurrentState: vi.fn(() => true) };
  const context = { store, repoRoot: root, dataDir: root, semaphore: new WorkspaceSemaphore(), disposed: () => false };
  const saved = () => readPersistedRuns(root).find(run => run.id === recipient.id)!;
  const deliveries = (id: string) => store.readEvents(id).filter(event => event.type === 'conversation-message' && event.delivery === 'delivered');
  return { parent, recipient, state, host, context, saved, deliveries };
}

it('publishes a committed opening receipt once without a live session and retains the replay checkpoint', () => {
  const f = opening();
  expect(f.state.session).toBeUndefined();
  recordOpeningAccepted(f.context, f.host, f.recipient.id, f.state);
  recordOpeningAccepted(f.context, f.host, f.recipient.id, f.state);
  const saved = f.saved();
  expect(saved.agentInputs?.[0]?.deliveredAt).toBeDefined();
  expect(saved.agentInputs?.[0]?.consumedAt).toBeUndefined();
  expect(saved.continuationMessage?.agentInputId).toBe(f.state.openingAgentInputId);
  for (const id of [f.parent.id, f.recipient.id]) expect(f.deliveries(id))
    .toEqual([expect.objectContaining({ deliveredAt: saved.agentInputs![0]!.deliveredAt })]);
  expect(f.host.reconcileWorkerWaits).toHaveBeenCalledTimes(1);
  expect(store.getRun(f.parent.id)?.delegation).toMatchObject({ conversation: { outcomes: [] } });
});

it('does not publish a receipt when its durable commit fails', () => {
  const f = opening();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(store, 'commitOutcome').mockImplementation(() => { throw new Error('receipt commit refused'); });
  recordOpeningAccepted(f.context, f.host, f.recipient.id, f.state);
  expect(f.saved().agentInputs?.[0]?.deliveredAt).toBeUndefined();
  expect(f.saved().continuationMessage).toBeDefined();
  for (const id of [f.parent.id, f.recipient.id]) expect(f.deliveries(id)).toEqual([]);
  expect(f.host.reconcileWorkerWaits).not.toHaveBeenCalled();
});

it.each(['cancelled', 'stale'] as const)('does not accept an opening receipt from a %s state', mode => {
  const f = opening();
  if (mode === 'cancelled') f.state.cancelled = true;
  else f.host.isCurrentState.mockReturnValue(false);
  recordOpeningAccepted(f.context, f.host, f.recipient.id, f.state);
  expect(f.saved().agentInputs?.[0]?.deliveredAt).toBeUndefined();
  expect(f.host.reconcileWorkerWaits).not.toHaveBeenCalled();
});
