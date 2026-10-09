import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@open-mercato/cezar-contract';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { inputDeliveryOf, RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { createRunner } from './runner-factory.ts';
import { ANSWER_DELIVERY_CRITERIA, HARNESS_ADAPTERS, exemptionFor, promptFor, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

// hearsay-tools/cezarion#935: a Continue executing a human answer keeps that answer's
// checkpoint until turn-end for crash recovery. The checkpoint must not hold worker
// conversation input arriving through the ordinary send path while the answer runs.
beforeEach(() => vi.stubEnv('CEZ_DELEGATION', '1'));
afterEach(() => vi.unstubAllEnvs());

interface AnswerFixture {
  store: RunStore; manager: RunManager; runId: string; askSeq: number;
  /** The parent's ordinary `worker send`, with no inbox read or manual flush. */
  send: (text: string, requestId?: string) => Promise<string>;
}

/** A worker whose genuine human question survives a closed session, ready for Continue. */
async function withAnsweredWorker(backend: RunnerId, env: Record<string, string>, body: (fixture: AnswerFixture) => Promise<void>): Promise<void> {
  await withOwnedInputRun(backend, 'ask', async fixture => {
    const { repoRoot, runId, parentRunId } = fixture;
    fixture.manager.enqueueOwnedRun(runId);
    // Without the parent's steer grant, the question falls back to the human (#505).
    await waitFor(() => fixture.store.readEvents(runId).some(event => event.type === 'worker-question-fallback'));
    await waitFor(() => fixture.store.getRun(runId)?.status === 'waiting');
    const askSeq = fixture.store.readEvents(runId).find(event => event.type === 'ask.requested')!.seq;
    // Native question turns stay open, so a restart is the session close every wire shares.
    const { store, manager } = await fixture.restart();
    expect(manager.isActive(runId)).toBe(false);
    const parent = store.getRun(parentRunId)!;
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    store.commitDelegation([{ id: parentRunId, delegation: { ...parent.delegation, permissions: ['spawn', 'steer'] } }]);
    const credentials = new CredentialRegistry();
    const caller = credentials.authenticate(credentials.issue('project', parentRunId, randomUUID()))!;
    const service = new DelegationService();
    service.registerProject({ id: 'project', root: repoRoot, store, manager });
    const send = async (text: string, requestId?: string) => {
      const id = randomUUID();
      await service.send(caller, { id, recipientRunId: runId, text, timeoutSeconds: 600,
        ...(requestId ? { kind: 'reply' as const, requestId } : { kind: 'progress' as const }) });
      return id;
    };
    try { await body({ store, manager, runId, askSeq, send }); } finally { credentials.close(); }
  }, { env });
}

const input = (store: RunStore, runId: string, id: string) => store.getRun(runId)?.agentInputs?.find(entry => entry.id === id);
const projectionSeq = (store: RunStore, runId: string, id: string, delivery: string) => store.readEvents(runId)
  .find(event => event.type === 'conversation-message' && (event.message as ConversationMessage).id === id && event.delivery === delivery)?.seq;
const checkpoints = (store: RunStore, runId: string, askSeq: number) => store.readEvents(runId)
  .filter(event => event.type === 'human-input-delivered' && event.askSeq === askSeq);
const firstAfter = (store: RunStore, runId: string, type: string, seq: number) => store.readEvents(runId)
  .find(event => event.type === type && event.seq > seq)?.seq;
const lastSeq = (store: RunStore, runId: string) => store.readEvents(runId).at(-1)?.seq ?? 0;

for (const backend of RUNNER_IDS) {
  const [steer, declared, held] = ANSWER_DELIVERY_CRITERIA;

  const steerExemption = exemptionFor(steer.id, backend);
  if (steerExemption) {
    it(`${backend} is exempt from ${steer.id} — ${steerExemption.reason}`, () => {
      expect(steerExemption.kind).toBe('scenario-unconstructible');
      expect(HARNESS_ADAPTERS[backend].scenarios[steer.scenario]).toBeUndefined();
      expect(inputDeliveryOf(createRunner(backend)).mode).toBe('boundary');
    });
  } else {
    it(`${backend} ${steer.id} ${steer.name}`, async () => {
      // Long enough that a held message cannot reach the tool before it returns.
      await withAnsweredWorker(backend, { CEZ_MOCK_STEER_MS: '1500' }, async ({ store, manager, runId, askSeq, send }) => {
        const start = lastSeq(store, runId);
        expect(manager.continueRun(runId, { text: `Vitest ${promptFor(backend, steer.scenario)}` }).ok).toBe(true);
        await waitFor(() => firstAfter(store, runId, 'tool-call', start) !== undefined);
        const id = await send('mock:agent-echo review progress during the answer');
        await waitFor(() => !!input(store, runId, id)?.consumedAt);
        // The answer's durable checkpoint stays at turn-end, after the message was read.
        await waitFor(() => checkpoints(store, runId, askSeq).length === 1);
        const turnEnd = firstAfter(store, runId, 'turn-end', start)!;
        expect(projectionSeq(store, runId, id, 'delivered')).toBeLessThan(turnEnd);
        expect(projectionSeq(store, runId, id, 'consumed')).toBeLessThan(turnEnd);
        expect(checkpoints(store, runId, askSeq)[0]!.seq).toBeGreaterThan(turnEnd);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        expect(checkpoints(store, runId, askSeq)).toHaveLength(1);
      });
    }, 60_000);
  }

  it(`${backend} ${declared.id} ${declared.name}`, async () => {
    const releaseFile = join(tmpdir(), `cez-935-release-${randomUUID()}`);
    try {
      await withAnsweredWorker(backend, { CEZ_MOCK_RELEASE_FILE: releaseFile }, async ({ store, manager, runId, askSeq, send }) => {
        const mode = inputDeliveryOf(createRunner(backend)).mode;
        const start = lastSeq(store, runId);
        expect(manager.continueRun(runId, { text: `Vitest ${promptFor(backend, declared.scenario)}` }).ok).toBe(true);
        await waitFor(() => firstAfter(store, runId, 'turn.started', start) !== undefined);
        const id = await send('mock:agent-echo review progress during the held answer');
        if (mode === 'steer') {
          // The harness accepts it while the answer is still held before any content.
          await waitFor(() => !!input(store, runId, id)?.deliveredAt);
          expect(firstAfter(store, runId, 'turn-end', start)).toBeUndefined();
        } else {
          // A boundary wire refuses busy input: nothing reaches it until the answer ends.
          await new Promise(resolve => setTimeout(resolve, 300));
          expect(input(store, runId, id)?.deliveredAt).toBeUndefined();
        }
        expect(checkpoints(store, runId, askSeq)).toEqual([]);
        writeFileSync(releaseFile, '');
        await waitFor(() => !!input(store, runId, id)?.deliveredAt);
        await waitFor(() => checkpoints(store, runId, askSeq).length === 1);
        const turnEnd = firstAfter(store, runId, 'turn-end', start)!;
        const delivered = projectionSeq(store, runId, id, 'delivered')!;
        if (mode === 'steer') expect(delivered).toBeLessThan(turnEnd);
        else expect(delivered).toBeGreaterThan(checkpoints(store, runId, askSeq)[0]!.seq);
        expect(checkpoints(store, runId, askSeq)[0]!.seq).toBeGreaterThan(turnEnd);
      });
    } finally { rmSync(releaseFile, { force: true }); }
  }, 60_000);

  it(`${backend} ${held.id} ${held.name}`, async () => {
    await withAnsweredWorker(backend, {}, async ({ store, manager, runId, askSeq, send }) => {
      const quiet = () => new Promise(resolve => setTimeout(resolve, 300));
      // A genuinely unanswered question holds the message; it is not the answer.
      const early = await send('mock:agent-echo progress before the answer');
      await quiet();
      expect(input(store, runId, early)?.deliveredAt).toBeUndefined();
      expect(store.readEvents(runId).filter(event => event.type === 'user-message')).toEqual([]);

      // The answer raises a newer question; it holds later input like the first one did.
      const start = lastSeq(store, runId);
      expect(manager.continueRun(runId, { text: `Vitest ${promptFor(backend, held.scenario)}` }).ok).toBe(true);
      await waitFor(() => firstAfter(store, runId, 'ask.requested', start) !== undefined);
      const newer = firstAfter(store, runId, 'ask.requested', start)!;
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      const later = await send('mock:agent-echo progress after the newer question');
      await quiet();
      expect(input(store, runId, later)?.deliveredAt).toBeUndefined();
      expect(checkpoints(store, runId, newer)).toEqual([]);

      // With the steer grant the newer question reaches the parent (#505), whose reply is
      // the one input it admits. A steer wire may have read the early message inside the
      // answer; a boundary wire holds it behind the newer question too. The reply releases both.
      const routedTo = () => store.readEvents(runId).find(event => event.type === 'worker-question-routed' && event.askSeq === newer);
      await waitFor(() => routedTo() !== undefined);
      const routed = routedTo()!;
      await send('Vitest', String(routed.messageId));
      await waitFor(() => [early, later].every(id => !!input(store, runId, id)?.deliveredAt));
      expect(projectionSeq(store, runId, later, 'delivered')).toBeGreaterThan(newer);
      expect(checkpoints(store, runId, askSeq)).toHaveLength(1);
      await waitFor(() => checkpoints(store, runId, newer).length === 1);
      expect(checkpoints(store, runId, newer)[0]).toMatchObject({ source: 'parent' });
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
    });
  }, 60_000);
}
