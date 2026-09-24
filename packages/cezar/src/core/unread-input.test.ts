import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { HARNESS_ADAPTERS, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

// #505: accepted input a finished turn never read goes back to the queue and is
// submitted again; DONE and park never finish over it.
describe('unread agent input is resubmitted (#505)', () => {
  const late = (parentRunId: string): AgentInput => ({ id: randomUUID(), source: 'agent', parentRunId,
    text: 'mock:agent-echo late parent guidance', createdAt: new Date().toISOString() });

  it('codex resubmits a steer the finished turn never read, then reads it once', async () => {
    await withOwnedInputRun('codex', 'steer-late', async ({ store, manager, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('late window')));
      const input = late(parentRunId);
      manager.steerWorker(runId, input);
      await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.consumedAt, 15_000);
      expect(store.readEvents(runId).some(e => e.type === 'note' && String(e.message).includes('did not read'))).toBe(true);
      // Codex marks it read when it enters the thread history, before the reply text lands.
      const echoes = () => store.readEvents(runId).filter(e => e.type === 'text' && String(e.text).includes('late parent guidance'));
      await waitFor(() => echoes().length > 0, 15_000);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(echoes()).toHaveLength(1);
    });
  }, 60_000);

  it('codex keeps a CEZ:DONE session open until a resubmitted input is read', async () => {
    const adapter = HARNESS_ADAPTERS.codex as { scenarios: Record<string, string> };
    const original = adapter.scenarios['steer-late']!;
    adapter.scenarios['steer-late'] = 'mock:steer-late mock:done-late';
    try {
      await withOwnedInputRun('codex', 'steer-late', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('late window')));
        manager.steerWorker(runId, late(parentRunId));
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.consumedAt, 15_000);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('late parent guidance')), 15_000);
        // The goal-achieved close never ran over the unread input.
        const closed = store.readEvents(runId).findIndex(e => e.type === 'lifecycle' && String(e.message).includes('goal achieved'));
        const echoed = store.readEvents(runId).findIndex(e => e.type === 'text' && String(e.text).includes('late parent guidance'));
        expect(echoed).toBeGreaterThan(-1);
        // The run did not close over the unread input: any close comes after it was read.
        expect(closed === -1 || closed > echoed).toBe(true);
        const reads = store.readEvents(runId).filter(e => e.type === 'text' && String(e.text).includes('late parent guidance'));
        expect(reads).toHaveLength(1);
      });
    } finally { adapter.scenarios['steer-late'] = original; }
  }, 60_000);

  it('claude replays accepted but unread input after a restart, and reads it', async () => {
    const saved = process.env.CEZ_MOCK_STEER_MS; process.env.CEZ_MOCK_STEER_MS = '5000';
    try {
      await withOwnedInputRun('claude', 'steer-tool', async fixture => {
        const { runId, parentRunId } = fixture;
        fixture.manager.enqueueOwnedRun(runId);
        await waitFor(() => fixture.store.readEvents(runId).some(e => e.type === 'tool-call'));
        const input = late(parentRunId);
        fixture.manager.steerWorker(runId, input);
        await waitFor(() => !!fixture.store.getRun(runId)?.agentInputs?.[0]?.deliveredAt);
        expect(fixture.store.getRun(runId)?.agentInputs?.[0]).toMatchObject({ awaitingRead: true });
        const { store, manager } = await fixture.restart();
        expect(store.getRun(runId)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
        if (!manager.isActive(runId)) expect(manager.continueRun(runId, { text: 'mock:agent-echo resume' }).ok).toBe(true);
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.consumedAt, 15_000);
        expect(store.getRun(runId)?.agentInputs?.[0]?.awaitingRead).toBeUndefined();
        // Re-delivered exactly once after the restart.
        const echoes = () => store.readEvents(runId).filter(e => e.type === 'text' && String(e.text).includes('late parent guidance'));
        await waitFor(() => echoes().length > 0, 15_000);
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(echoes()).toHaveLength(1);
      });
    } finally { if (saved === undefined) delete process.env.CEZ_MOCK_STEER_MS; else process.env.CEZ_MOCK_STEER_MS = saved; }
  }, 60_000);

  it('codex returns input to the queue when its turn fails before anything read it (#505 review)', async () => {
    const saved = process.env.CEZ_MOCK_CODEX_NO_USER_ITEM; process.env.CEZ_MOCK_CODEX_NO_USER_ITEM = '1';
    try {
      await withOwnedInputRun('codex', 'baseline', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        const input: AgentInput = { id: randomUUID(), source: 'agent', parentRunId, text: 'mock:provider-error guidance', createdAt: new Date().toISOString() };
        manager.steerWorker(runId, input);
        await waitFor(() => !manager.isActive(runId), 15_000);
        expect(store.getRun(runId)?.status).toBe('failed');
        // Never reported read: it is queued again, not shown as delivered.
        expect(store.getRun(runId)?.agentInputs).toEqual([input]);
      });
    } finally { if (saved === undefined) delete process.env.CEZ_MOCK_CODEX_NO_USER_ITEM; else process.env.CEZ_MOCK_CODEX_NO_USER_ITEM = saved; }
  }, 60_000);
});
