import { testHome } from '../home/test-home.testkit.ts';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it as registerTest, describe, vi } from 'vitest';
import type { ConversationMessage } from '@open-mercato/cezar-contract';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { inputDeliveryOf, RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { createRunner } from './runner-factory.ts';
import { ANSWER_DELIVERY_CRITERIA, HARNESS_ADAPTERS, exemptionFor, promptFor, waitFor } from './harness-parity.testkit.ts';
import { withOwnedInputRun, withoutTaskScenario } from './workflow-parity.testkit.ts';

// hearsay-tools/cezarion#935: a Continue executing an answer keeps that answer's checkpoint until
// turn-end for crash recovery. The checkpoint must not hold worker conversation input arriving
// through the ordinary send path while the answer runs. The answer is the parent's reply, which
// reopens the closed session: a worker's question has one addressee (hearsay-tools/cezarion#2410).
afterEach(() => vi.unstubAllEnvs());

interface AnswerFixture {
  store: RunStore; manager: RunManager; runId: string; askSeq: number;
  /** The parent's ordinary `worker send`, with no inbox read or manual flush. */
  send: (text: string, requestId?: string) => Promise<string>;
  /** The parent's reply to the worker's pending question, which reopens its closed session. */
  answer: (text: string) => Promise<string>;
  /** Close every session again; `store` and `manager` are the reopened ones afterwards. */
  restart: () => Promise<void>;
}

/** A worker whose own question, routed to its parent, survives a closed session, ready for the
 *  parent's answer. */
async function withAnsweredWorker(backend: RunnerId, env: Record<string, string>, body: (fixture: AnswerFixture) => Promise<void>): Promise<void> {
  await withOwnedInputRun(backend, 'ask', async fixture => {
    const { repoRoot, runId, parentRunId } = fixture;
    fixture.manager.enqueueOwnedRun(runId);
    await waitFor(() => fixture.store.readEvents(runId).some(event => event.type === 'worker-question-routed'));
    await waitFor(() => fixture.store.getRun(runId)?.status === RUN_STATUS.waiting);
    const askSeq = fixture.store.readEvents(runId).find(event => event.type === 'ask.requested')!.seq;
    // Native question turns stay open, so a restart is the session close every wire shares.
    let { store, manager } = await fixture.restart();
    expect(manager.isActive(runId)).toBe(false);
    withoutTaskScenario(store, runId);
    const credentials = new CredentialRegistry();
    const caller = credentials.authenticate(credentials.issue('project', parentRunId, randomUUID()))!;
    const service = new DelegationService();
    service.registerProject({ home: testHome(), id: 'project', root: repoRoot, store, manager });
    const send = async (text: string, requestId?: string) => {
      const id = randomUUID();
      await service.send(caller, { id, recipientRunId: runId, text, timeoutSeconds: 600,
        ...(requestId ? { kind: 'reply' as const, requestId } : { kind: 'progress' as const }) });
      return id;
    };
    const questionId = String(store.readEvents(runId).find(event => event.type === 'worker-question-routed' && event.askSeq === askSeq)!.messageId);
    const answer = (text: string) => send(text, questionId);
    const answerFixture: AnswerFixture = { store, manager, runId, askSeq, send, answer, restart: async () => {
      ({ store, manager } = await fixture.restart());
      Object.assign(answerFixture, { store, manager });
      service.registerProject({ home: testHome(), id: 'project', root: repoRoot, store, manager });
    } };
    try { await body(answerFixture); } finally { credentials.close(); }
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
function steering(backend: RunnerId, it: typeof registerTest = registerTest): void {

  const [steer] = ANSWER_DELIVERY_CRITERIA;

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
      await withAnsweredWorker(backend, { CEZ_MOCK_STEER_MS: '1500' }, async ({ store, runId, askSeq, send, answer }) => {
        const start = lastSeq(store, runId);
        await answer(`Vitest ${promptFor(backend, steer.scenario)}`);
        await waitFor(() => firstAfter(store, runId, 'tool-call', start) !== undefined);
        const id = await send('mock:agent-echo review progress during the answer');
        await waitFor(() => !!input(store, runId, id)?.consumedAt);
        // The answer's durable checkpoint stays at turn-end, after the message was read.
        await waitFor(() => checkpoints(store, runId, askSeq).length === 1);
        const turnEnd = firstAfter(store, runId, 'turn-end', start)!;
        expect(projectionSeq(store, runId, id, 'delivered')).toBeLessThan(turnEnd);
        expect(projectionSeq(store, runId, id, 'consumed')).toBeLessThan(turnEnd);
        expect(checkpoints(store, runId, askSeq)[0]!.seq).toBeGreaterThan(turnEnd);
        await waitFor(() => store.getRun(runId)?.status === RUN_STATUS.waiting);
        expect(checkpoints(store, runId, askSeq)).toEqual([expect.objectContaining({ source: 'parent' })]);
      });
    }, 60_000);
  }
}

function declaredDelivery(backend: RunnerId, it: typeof registerTest = registerTest): void {

  const [, declared] = ANSWER_DELIVERY_CRITERIA;

  it(`${backend} ${declared.id} ${declared.name}`, async () => {
    const releaseFile = join(tmpdir(), `cez-935-release-${randomUUID()}`);
    try {
      await withAnsweredWorker(backend, { CEZ_MOCK_RELEASE_FILE: releaseFile }, async ({ store, runId, askSeq, send, answer }) => {
        const mode = inputDeliveryOf(createRunner(backend)).mode;
        const start = lastSeq(store, runId);
        await answer(`Vitest ${promptFor(backend, declared.scenario)}`);
        await waitFor(() => firstAfter(store, runId, 'turn.started', start) !== undefined);
        const id = await send('mock:agent-echo review progress during the held answer');
        if (mode === 'steer') {
          // The harness accepts it while the answer is still held before any content.
          await waitFor(() => !!input(store, runId, id)?.deliveredAt);
          expect(firstAfter(store, runId, 'turn-end', start)).toBeUndefined();
        } else {
          // A boundary wire refuses busy input: `send` offered it to the session, which refused it.
          // The order check after the release proves nothing reached the wire before the answer ended.
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
}

function pendingQuestion(backend: RunnerId, it: typeof registerTest = registerTest): void {

  const [, , held] = ANSWER_DELIVERY_CRITERIA;

  it(`${backend} ${held.id} ${held.name}`, async () => {
    await withAnsweredWorker(backend, {}, async answerFixture => {
      const { runId, askSeq, send } = answerFixture;
      let { store, manager } = answerFixture;
      // Messages held behind a native question, each with the question it waits behind.
      const heldBehindNative: { id: string; seq: number }[] = [];
      // hearsay-tools/cezarion#1235 phase 3a (§ Messages beside a pending question): a native
      // question takes nothing but its answer, so the message waits for the answer's turn end; a
      // cezar_ask question takes it beside the card. Either way it is never the answer.
      const question = (seq: number) => store.getRun(runId)?.waits?.find(wait => wait.kind === WAIT_KIND.human && wait.phase === WAIT_PHASE.open && wait.askSeq === seq);
      const expectBesideOrHeld = async (id: string, seq: number) => {
        if (question(seq)?.via === WAIT_VIA['native-ask']) {
          // `send` offered it to the run, which held it; the order check at the end proves it
          // reached the wire only after the question's answer.
          expect(input(store, runId, id)?.deliveredAt).toBeUndefined();
          expect(question(seq)).toBeDefined();
          heldBehindNative.push({ id, seq });
        } else {
          await waitFor(() => !!input(store, runId, id)?.deliveredAt);
          // The beside turn ends and parks for a question again.
          await waitFor(() => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes(input(store, runId, id)!.text)));
          await waitFor(() => store.getRun(runId)?.status === RUN_STATUS.waiting && store.transcriptFacts(runId).pendingAsk !== undefined);
          // Delivered beside the card, not instead of it: the original question is still open.
          expect(question(seq)).toBeDefined();
        }
        expect(checkpoints(store, runId, seq)).toEqual([]);
        expect(store.readEvents(runId).filter(event => event.type === 'user-message' && String(event.text).includes(input(store, runId, id)!.text))).toEqual([]);
      };
      const early = await send('mock:agent-echo progress before the answer');
      await expectBesideOrHeld(early, askSeq);

      // The answer raises a newer question; later input is held or delivered beside it the same way.
      // A cezar_ask question's run reopened through the scheduler to take the message; close that
      // session again so every wire answers in a fresh one. A mock that asked again there routed
      // its new question to the parent, which answers it.
      if (manager.isActive(runId)) {
        await answerFixture.restart();
        ({ store, manager } = answerFixture);
      }
      const pending = store.transcriptFacts(runId).pendingAsk!;
      const answered = pending.seq;
      const start = lastSeq(store, runId);
      const answer = `Vitest ${promptFor(backend, held.scenario)}`;
      expect(pending.routedMessageId).toBeDefined();
      // Each question's answer, by the question's seq.
      const answers = new Map([[answered, await send(answer, pending.routedMessageId)]]);
      await waitFor(() => firstAfter(store, runId, 'ask.requested', start) !== undefined);
      const newer = firstAfter(store, runId, 'ask.requested', start)!;
      await waitFor(() => store.getRun(runId)?.status === RUN_STATUS.waiting);
      await waitFor(() => checkpoints(store, runId, answered).length === 1);
      expect(checkpoints(store, runId, answered)[0]?.source).toBe('parent');
      const later = await send('mock:agent-echo progress after the newer question');
      await expectBesideOrHeld(later, newer);

      // With the steer grant the newer question reaches the parent (#505), whose reply is
      // the one input it answers, through the answer seam. Every message is delivered by then.
      const routedTo = () => store.readEvents(runId).find(event => event.type === 'worker-question-routed' && event.askSeq === newer);
      await waitFor(() => routedTo() !== undefined);
      const routed = routedTo()!;
      answers.set(newer, await send('Vitest', String(routed.messageId)));
      await waitFor(() => [early, later].every(id => !!input(store, runId, id)?.deliveredAt));
      expect(projectionSeq(store, runId, later, 'delivered')).toBeGreaterThan(newer);
      expect(checkpoints(store, runId, answered)).toHaveLength(1);
      await waitFor(() => checkpoints(store, runId, newer).length === 1);
      expect(checkpoints(store, runId, newer)[0]).toMatchObject({ source: 'parent' });
      // A native question takes nothing but its answer: a held message reaches the wire only after
      // that answer did.
      for (const { id, seq } of heldBehindNative) {
        expect(projectionSeq(store, runId, id, 'delivered')).toBeGreaterThan(projectionSeq(store, runId, answers.get(seq)!, 'delivered')!);
      }
      await waitFor(() => store.getRun(runId)?.status === RUN_STATUS.waiting);
    });
  }, 60_000);
}

export const answerDeliveryCells = { 'steering': steering, 'declared-delivery': declaredDelivery, 'pending-question': pendingQuestion };
export const ANSWER_DELIVERY_GROUPS = Object.fromEntries(Object.keys(answerDeliveryCells).map(family => [family, RUNNER_IDS.map(runner => ({ runner, family: family as keyof typeof answerDeliveryCells }))]));
export function registerAnswerDeliveryGroup(group: keyof typeof answerDeliveryCells): void {
  describe('conversation answer delivery', () => {
    for (const row of ANSWER_DELIVERY_GROUPS[group]!) answerDeliveryCells[row.family](row.runner);
  });
}
