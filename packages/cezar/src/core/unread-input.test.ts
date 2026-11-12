import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { HARNESS_ADAPTERS, waitFor } from './harness-parity.testkit.ts';
import { withOwnedInputRun } from './workflow-parity.testkit.ts';

// #505: accepted input a finished turn never read goes back to the queue and is
// submitted again; DONE and park never finish over it.
describe('unread agent input is resubmitted (#505)', () => {
  const late = (parentRunId: string): AgentInput => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId,
    text: 'mock:agent-echo late parent guidance', createdAt: new Date().toISOString() });

  /** A test-owned steer window: CEZ_MOCK_STEER_GATE holds the mock's steering window (the
   * steer-late tail, the steer-tool hold) open until `release`, so a mock timer never ends the
   * turn before the steer lands (hearsay-tools/squawk#3196). `gate` is the env value; `wire` is a
   * scratch file for mocks that record their requests. */
  const steerGate = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-steer-gate-'));
    const gate = join(dir, 'release');
    return {
      gate,
      wire: join(dir, 'wire.ndjson'),
      release: (): void => { writeFileSync(gate, ''); },
      cleanup: (): void => { rmSync(dir, { recursive: true, force: true }); },
    };
  };

  it('codex resubmits a steer the finished turn never read, then reads it once', async () => {
    const { gate, release, cleanup } = steerGate();
    try {
      await withOwnedInputRun('codex', 'steer-late', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('late window')));
        const input = late(parentRunId);
        manager.steerWorker(runId, input);
        // The gated window is still open: the steer was accepted inside the turn.
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.deliveredAt, 10_000);
        release();
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.consumedAt, 15_000);
        expect(store.readEvents(runId).some(e => e.type === 'note' && String(e.message).includes('did not read'))).toBe(true);
        // Codex marks it read when it enters the thread history, before the reply text lands.
        const echoes = () => store.readEvents(runId).filter(e => e.type === 'text' && String(e.text).includes('late parent guidance'));
        await waitFor(() => echoes().length > 0, 15_000);
        // bound: negative window. A second resubmission of the same input would reach the mock within a few event-loop turns of the first echo; 300 ms covers them.
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(echoes()).toHaveLength(1);
      }, { env: { CEZ_MOCK_STEER_GATE: gate } });
    } finally { cleanup(); }
  }, 60_000);

  it('codex keeps a cezar_done session open until a resubmitted input is read', async () => {
    const adapter = HARNESS_ADAPTERS.codex as { scenarios: Record<string, string> };
    const original = adapter.scenarios['steer-late']!;
    adapter.scenarios['steer-late'] = 'mock:steer-late mock:late-cezar-done';
    const { gate, release, cleanup } = steerGate();
    try {
      await withOwnedInputRun('codex', 'steer-late', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('late window')));
        manager.steerWorker(runId, late(parentRunId));
        // The gated window is still open: the steer was accepted inside the turn.
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.deliveredAt, 10_000);
        release();
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
      }, { env: { CEZ_MOCK_STEER_GATE: gate } });
    } finally { adapter.scenarios['steer-late'] = original; cleanup(); }
  }, 60_000);

  it('claude replays accepted but unread input after a restart, and reads it', async () => {
    const { gate, release, cleanup } = steerGate();
    try {
      await withOwnedInputRun('claude', 'steer-tool', async fixture => {
        const { runId, parentRunId } = fixture;
        fixture.manager.enqueueOwnedRun(runId);
        await waitFor(() => fixture.store.readEvents(runId).some(e => e.type === 'tool-call'));
        const input = late(parentRunId);
        fixture.manager.steerWorker(runId, input);
        // The gated hold keeps the turn open: the steer was accepted inside it, and the restart
        // below ends the turn before the mock could read it. No timer decides.
        await waitFor(() => !!fixture.store.getRun(runId)?.agentInputs?.[0]?.deliveredAt, 10_000);
        expect(fixture.store.getRun(runId)?.agentInputs?.[0]).toMatchObject({ awaitingRead: true });
        // The resumed session replays the steer-tool scenario, whose hold uses the same gate:
        // release it once the old session is gone and before the new one spawns.
        const { store, manager } = await fixture.restart(() => release());
        expect(store.getRun(runId)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
        if (!manager.isActive(runId)) expect(manager.continueRun(runId, { text: 'mock:agent-echo resume' }).ok).toBe(true);
        try {
          await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.consumedAt, 15_000);
        } catch (error) {
          console.error('DEBUG run record:', JSON.stringify(store.getRun(runId), null, 2));
          console.error('DEBUG events:', JSON.stringify(store.readEvents(runId), null, 2));
          throw error;
        }
        expect(store.getRun(runId)?.agentInputs?.[0]?.awaitingRead).toBeUndefined();
        // Re-delivered exactly once after the restart.
        const echoes = () => store.readEvents(runId).filter(e => e.type === 'text' && String(e.text).includes('late parent guidance'));
        await waitFor(() => echoes().length > 0, 15_000);
        // bound: negative window. A second delivery after the restart would reach the mock within a few event-loop turns of the first echo; 500 ms covers them.
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(echoes()).toHaveLength(1);
      }, { env: { CEZ_MOCK_STEER_GATE: gate } });
    } finally { cleanup(); }
  }, 60_000);

  it('codex returns input to the queue when its turn fails before anything read it (#505 review)', async () => {
    const saved = process.env.CEZ_MOCK_CODEX_NO_USER_ITEM; process.env.CEZ_MOCK_CODEX_NO_USER_ITEM = '1';
    try {
      await withOwnedInputRun('codex', 'baseline', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        const input: AgentInput = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId, text: 'mock:provider-error guidance', createdAt: new Date().toISOString() };
        manager.steerWorker(runId, input);
        await waitFor(() => !manager.isActive(runId), 15_000);
        expect(store.getRun(runId)?.status).toBe('failed');
        // Never reported read: it is queued again, not shown as delivered.
        expect(store.getRun(runId)?.agentInputs).toEqual([input]);
      });
    } finally { if (saved === undefined) delete process.env.CEZ_MOCK_CODEX_NO_USER_ITEM; else process.env.CEZ_MOCK_CODEX_NO_USER_ITEM = saved; }
  }, 60_000);

  it('opencode resubmits input its lost-wake report retired while the POST was still unacknowledged (#505 review)', async () => {
    const { gate, wire, release, cleanup } = steerGate();
    try {
      await withOwnedInputRun('opencode', 'steer-late', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('late window')));
        manager.steerWorker(runId, late(parentRunId));
        // The steer POST is on the mock's request wire while the gated window still holds the
        // turn; its acknowledgement is deliberately still pending (CEZ_MOCK_OPENCODE_STEER_ACK_MS),
        // so the delivery checkpoint cannot be the release signal here.
        await waitFor(() => existsSync(wire) && readFileSync(wire, 'utf8').includes('late parent guidance'), 10_000);
        release();
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.consumedAt, 20_000);
        await waitFor(() => store.getRun(runId)?.status === 'waiting', 20_000);
      }, { env: { CEZ_MOCK_OPENCODE_STEER_ACK_MS: '3000', CEZ_MOCK_STEER_GATE: gate, CEZ_MOCK_ARGS_FILE: wire } });
    } finally { cleanup(); }
  }, 60_000);

  it('codex never closes a cezar_done session as done when requeueing unread input fails (#505 local review)', async () => {
    const adapter = HARNESS_ADAPTERS.codex as { scenarios: Record<string, string> };
    const original = adapter.scenarios['steer-late']!;
    adapter.scenarios['steer-late'] = 'mock:steer-late mock:late-cezar-done';
    const { gate, release, cleanup } = steerGate();
    try {
      await withOwnedInputRun('codex', 'steer-late', async ({ store, manager, runId, parentRunId }) => {
        const commit = store.commitOutcome.bind(store);
        vi.spyOn(store, 'commitOutcome').mockImplementation((id, outcomes, ...rest) => {
          if ([outcomes].flat().some(outcome => outcome.kind === 'requeued')) throw new Error('disk full');
          return commit(id, outcomes, ...rest);
        });
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('late window')));
        manager.steerWorker(runId, late(parentRunId));
        // The gated window is still open: the steer was accepted inside the turn, so the turn's
        // end requeues it and reaches the injected requeue failure, never a fresh turn's read.
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.deliveredAt, 10_000);
        release();
        await waitFor(() => !manager.isActive(runId), 15_000);
        expect(store.getRun(runId)?.status).toBe('failed');
        expect(store.readEvents(runId).some(e => e.type === 'error' && String(e.message).includes('requeue'))).toBe(true);
      }, { env: { CEZ_MOCK_STEER_GATE: gate } });
    } finally { adapter.scenarios['steer-late'] = original; vi.restoreAllMocks(); cleanup(); }
  }, 60_000);
});
