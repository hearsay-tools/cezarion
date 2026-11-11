import type { RunnerId } from './agent-runner.ts';
import type { HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessPart, type HarnessGroup, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { agentInputEventSchema } from '@open-mercato/cezar-contract/events';
import { WAIT_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { historyPaths } from '../runs/history-file.ts';
import { blockRunWrites, hasPendingAsk, muteLockedDatabaseLogs } from '../runs/run-store.testkit.ts';
import { TranscriptFactsQueue } from '../runs/transcript-facts-queue.ts';
import { fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { inputDeliveryOf } from './agent-runner.ts';
import { promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { runnersUnderTest } from './runners-under-test.testkit.ts';
import { withOwnedInputRun, withoutTaskScenario } from './workflow-parity-core.testkit.ts';

export const agentInput = (parentRunId: string, text = '/owned-skill mock:agent-echo parent steering'): AgentInput => ({
  id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId, text, createdAt: new Date().toISOString(),
});

export const OWNED_INPUT_GROUPS = {
  owned(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
    describeRunners('owned', 'harness parity — owned input run tier', () => {
      for (const backend of runners) {
        it(`${backend} R6 queues before/during asks and drains only after the parent's answer`, async () => {
          await withOwnedInputRun(backend, 'ask', async ({ store, manager, repoRoot, runId, parentRunId, answer }) => {
            // A real registry entry must NOT expand agent-originated slash text.
            const skills = join(repoRoot, '.ai/cezar/skills');
            mkdirSync(skills, { recursive: true });
            writeFileSync(join(skills, 'owned-skill.md'), '---\nname: owned-skill\n---\nEXPANDED HUMAN SKILL');
            const first = agentInput(parentRunId);
            const second = agentInput(parentRunId, 'mock:agent-echo second steering');
            expect(manager.steerWorker(runId, first)).toBe('queued');
            expect(store.getRun(runId)?.agentInputs).toEqual([first]);
            manager.enqueueOwnedRun(runId);
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'ask.requested'));
            const askSeq = store.readEvents(runId).find(e => e.type === 'ask.requested')!.seq;
            expect(manager.steerWorker(runId, second)).toBe('queued');
            // bound: observe the real runner's native ask boundary for 150 ms; refused steering must not start a turn or answer the ask.
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(store.getRun(runId)?.status).toBe('waiting');
            // #505: input queued before the session opened steers into the opening turn on a
            // `steer` runner. A native ask holds a `boundary` runner's turn open, so nothing reaches
            // it. A cezar_ask is the workflow's human wait, not the runner's: the parent's message
            // reaches a `boundary` runner at the turn boundary as an admitted wake beside the open
            // question, which stays pending and is never answered by it (hearsay-tools/cezarion#1235).
            const steer = inputDeliveryOf(runnersUnderTest()(backend)).mode === 'steer';
            const humanWait = store.getRun(runId)?.waits?.find(wait => wait.kind === WAIT_KIND.human && wait.phase === WAIT_PHASE.open);
            const delivered = (id: string) => !!store.getRun(runId)?.agentInputs?.find(input => input.id === id)?.deliveredAt;
            if (!steer && humanWait?.via === WAIT_VIA.cezar_ask) {
              await waitFor(() => delivered(first.id));
              await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('parent steering')));
              const beside = store.readEvents(runId).filter(e => e.type === 'text' && String(e.text).includes('parent steering')).map(e => String(e.text)).join('\n');
              expect(beside).toContain('Still open:');
              expect(store.transcriptFacts(runId).pendingAsk?.seq).toBe(askSeq);
            } else {
              expect(delivered(first.id)).toBe(steer);
            }
            // Input accepted while the question is pending never reaches the session before the answer.
            expect(delivered(second.id)).toBe(false);
            expect(store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
            expect(store.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([]);
            const attributed = store.readEvents(runId).filter(e => e.type === 'agent-input').map(e => agentInputEventSchema.parse(e).input);
            expect(attributed).toEqual([first, second]);
            const reply = await answer('Vitest');
            await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('second steering')));
            const texts = store.readEvents(runId).filter(e => e.type === 'text').map(e => e.text).join('\n');
            expect(texts).toContain(first.text);
            expect(texts).not.toContain('EXPANDED HUMAN SKILL');
            // The parent's reply answers it through the answer seam; no human message is shown.
            expect(store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
            expect(store.getRun(runId)?.agentInputs?.map(input => input.id)).toEqual([first.id, second.id, reply]);
            // The answer retired this ask; the answered turn's end may raise Cezar's fallback question
            // on the idle worker (hearsay-tools/cezarion#1301), which is a new one.
            expect(store.transcriptFacts(runId).pendingAsk?.seq).not.toBe(askSeq);
            expect(store.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([expect.objectContaining({ askSeq, source: 'parent' })]);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            const afterAsk = agentInput(parentRunId, 'mock:agent-echo after ask');
            expect(manager.steerWorker(runId, afterAsk)).toBe('queued');
            await waitFor(() => !!store.getRun(runId)?.agentInputs?.find(input => input.id === afterAsk.id)?.deliveredAt);
          });
        }, 60_000);

        it(`${backend} R7 restart retains pending asks and input; only the parent's answer drains it`, async () => {
          await withOwnedInputRun(backend, 'ask', async fixture => {
            const { runId, parentRunId } = fixture;
            fixture.manager.enqueueOwnedRun(runId);
            await waitFor(() => fixture.store.readEvents(runId).some(e => e.type === 'ask.requested'));
            const input = agentInput(parentRunId);
            expect(fixture.manager.steerWorker(runId, input)).toBe('queued');
            const joins = vi.spyOn(TranscriptFactsQueue.prototype, 'join');
            let recovered: Awaited<ReturnType<typeof fixture.restart>>;
            try {
              recovered = await fixture.restart(dataDir => {
                for (const id of [parentRunId, runId]) rmSync(historyPaths(dataDir, id).facts, { force: true });
                joins.mockClear();
              });
              expect(joins).not.toHaveBeenCalled();
            } finally { joins.mockRestore(); }
            const { store, manager } = recovered!;
            expect(store.getRun(runId)?.status).toBe('waiting');
            expect(store.getRun(runId)?.agentInputs).toEqual([input]);
            // Neither a bare Continue nor a human answer drains it: the question is the parent's.
            expect(manager.continueRun(runId).ok).toBe(false);
            expect(manager.continueRun(runId, { text: 'Vitest' }).ok).toBe(false);
            expect(store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
            withoutTaskScenario(store, runId);
            await fixture.answer('Vitest');
            await waitFor(() => store.getRun(runId)?.agentInputs?.[0]?.deliveredAt !== undefined);
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('parent steering')));
            expect(store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
            expect(store.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([expect.objectContaining({ source: 'parent' })]);
          });
        }, 60_000);

        it(`${backend} refused answer delivery retains the ask live and after restart`, async () => {
          await withOwnedInputRun(backend, 'ask', async fixture => {
            const { manager, store, runId, parentRunId } = fixture;
            manager.enqueueOwnedRun(runId);
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'ask.requested'));
            const askSeq = store.readEvents(runId).find(e => e.type === 'ask.requested')!.seq;
            await waitFor(() => store.transcriptFacts(runId).pendingAsk?.routedMessageId !== undefined && store.getRun(runId)?.status === 'waiting');
            const session = [...fixtureWork(manager).liveSessions][0]!;
            // The session refuses the parent's answer once: it stays queued, and the ask stays pending.
            const refuse = vi.spyOn(session, 'sendMessage').mockReturnValue(false);
            const reply = await fixture.answer('refused answer');
            await waitFor(() => refuse.mock.calls.length > 0 || !!store.getRun(runId)?.agentInputs?.find(entry => entry.id === reply)?.deliveredAt);
            refuse.mockRestore();
            expect(store.getRun(runId)?.agentInputs?.find(entry => entry.id === reply)?.deliveredAt).toBeUndefined();
            expect(store.transcriptFacts(runId).pendingAsk?.seq).toBe(askSeq);
            expect(store.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([]);
            expect(hasPendingAsk(store, runId)).toBe(true);
            const input = agentInput(parentRunId);
            expect(manager.steerWorker(runId, input)).toBe('queued');
            withoutTaskScenario(store, runId);
            const recovered = await fixture.restart();
            // Recovery delivers the parent's accepted answer; no human answers it.
            expect(recovered.manager.continueRun(runId).ok).toBe(false);
            expect(recovered.store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
            await waitFor(() => !!recovered.store.getRun(runId)?.agentInputs?.find(entry => entry.id === input.id)?.deliveredAt);
            // #505: input can land mid-turn, so delivery no longer implies the answering turn
            // ended; the answer's durable checkpoint is still that turn's end.
            await waitFor(() => recovered.store.readEvents(runId).some(e => e.type === 'human-input-delivered'));
            expect(recovered.store.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([expect.objectContaining({ askSeq, source: 'parent' })]);
            // The answer retired this ask; the answered turn's end may raise Cezar's fallback question
            // on the idle worker (hearsay-tools/cezarion#1301), which is a new one.
            expect(recovered.store.transcriptFacts(runId).pendingAsk?.seq).not.toBe(askSeq);
          });
        }, 60_000);

        it(`${backend} R10 accepted input precedes DONE but explicit termination is never prolonged`, async () => {
          for (const stop of ['finish', 'cancel', 'destroy'] as const) {
            await withOwnedInputRun(backend, 'cezar-done', async ({ store, manager, runId, parentRunId }) => {
              const accepted = agentInput(parentRunId, 'mock:hold');
              expect(manager.steerWorker(runId, accepted)).toBe('queued');
              manager.enqueueOwnedRun(runId);
              await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.deliveredAt);
              const pending = agentInput(parentRunId);
              expect(manager.steerWorker(runId, pending)).toBe('queued');
              if (stop === 'destroy') {
                const delegation = store.getRun(runId)!.delegation!;
                if (delegation.role !== 'worker') throw new Error('expected worker');
                store.commitDelegation([{ id: runId, delegation: { ...delegation,
                  destroy: { requestedAt: new Date().toISOString(), phase: 'requested', remaining: ['process', 'worktree', 'branch'] },
                } }]);
                expect(() => manager.steerWorker(runId, agentInput(parentRunId))).toThrow(/state/i);
              }
              if (stop === 'cancel') manager.cancel(runId);
              else manager.finish(runId);
              await waitFor(() => !manager.isActive(runId));
              expect(store.getRun(runId)?.agentInputs?.[1]).toEqual(pending);
              expect(['review', 'done', 'cancelled']).toContain(store.getRun(runId)?.status);
              expect(store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
            });
          }
        }, 60_000);

        it(`${backend} R11 post-send checkpoint failure interrupts and reports failure without dropping input`, async () => {
          await withOwnedInputRun(backend, 'baseline', async ({ store, manager, repoRoot, runId, parentRunId }) => {
            manager.enqueueOwnedRun(runId);
            // The idle worker parks on Cezar's fallback question, routed to its parent
            // (hearsay-tools/cezarion#1301, hearsay-tools/cezarion#2410).
            await waitFor(() => store.getRun(runId)?.status === 'waiting' && store.transcriptFacts(runId).pendingAsk?.routedMessageId !== undefined);
            store.flush();
            let unblock: (() => void) | undefined;
            // The input supersedes that question with a write to the parent's conversation first; the
            // failure this cell injects is the input's own delivery checkpoint, after it.
            const failAfterEnqueue = ({ event }: { event: { type: string; reason?: unknown } }) => {
              if (event.type === 'human-ask-closed' && event.reason === 'superseded') unblock ??= blockRunWrites(join(repoRoot, '.ai/cezar'));
            };
            store.on('event', failAfterEnqueue);
            const input = agentInput(parentRunId, 'mock:hold');
            const unmute = muteLockedDatabaseLogs();
            try {
              expect(manager.steerWorker(runId, input)).toBe('queued');
              await waitFor(() => store.readEvents(runId).some(event => event.type === 'error' && String(event.message).includes('agent input delivery checkpoint failed')));
              expect(store.getRun(runId)?.agentInputs).toEqual([input]);
            } finally {
              store.off('event', failAfterEnqueue);
              unblock?.();
              unmute();
            }
            await waitFor(() => !manager.isActive(runId));
            expect(store.getRun(runId)?.status).toBe('failed');
            expect(store.getRun(runId)?.error).toContain('agent input delivery checkpoint failed');
            expect(store.getRun(runId)?.agentInputs).toEqual([input]);
          });
        }, 60_000);

        it(`${backend} R9 continuation asks keep input queued through delayed native reply acknowledgement`, async () => {
          await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId, answer }) => {
            manager.enqueueOwnedRun(runId);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            manager.finish(runId);
            await waitFor(() => !manager.isActive(runId));
            // The idle worker's park may already be Cezar's fallback question (hearsay-tools/cezarion#1301):
            // wait for the continuation's own ask.
            const asked = store.readEvents(runId).filter(e => e.type === 'ask.requested').length;
            expect(manager.continueRun(runId, { text: promptFor(backend, 'ask-reply-late') }).ok).toBe(true);
            await waitFor(() => store.readEvents(runId).filter(e => e.type === 'ask.requested').length > asked);
            const input = agentInput(parentRunId);
            expect(manager.steerWorker(runId, input)).toBe('queued');
            // The continuation's ask is the worker's own: its parent answers it (hearsay-tools/cezarion#2410).
            await answer('Vitest');
            await waitFor(() => store.getRun(runId)?.agentInputs?.[0]?.deliveredAt !== undefined);
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes(input.text)));
            expect(store.readEvents(runId).filter(e => e.type === 'user-message').map(e => e.text))
              .toEqual([promptFor(backend, 'ask-reply-late')]);
          });
        }, 60_000);

        it(`${backend} R8 queued restart/starting inputs persist; disk failure emits and delivers nothing`, async () => {
          await withOwnedInputRun(backend, 'hold', async fixture => {
            const { runId, parentRunId, repoRoot } = fixture;
            fixture.store.flush();
            const unblock = blockRunWrites(join(repoRoot, '.ai/cezar'));
            try {
              expect(() => fixture.manager.steerWorker(runId, agentInput(parentRunId))).toThrow();
              expect(fixture.store.getRun(runId)?.agentInputs).toBeUndefined();
              expect(fixture.store.readEvents(runId).filter(e => e.type === 'agent-input')).toEqual([]);
            } finally { unblock(); }
            const input = agentInput(parentRunId);
            expect(fixture.manager.steerWorker(runId, input)).toBe('queued');
            const { store, manager } = await fixture.restart();
            const second = agentInput(parentRunId, 'mock:agent-echo during startup');
            expect(manager.steerWorker(runId, second)).toBe('queued');
            await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('during startup')));
            expect(store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
            manager.finish(runId);
            await waitFor(() => !manager.isActive(runId));
            expect(() => manager.steerWorker(runId, agentInput(parentRunId))).toThrow(/state/i);
          });
        }, 60_000);
      }
    });
  },
} satisfies Readonly<Record<string, HarnessGroup>>;

/** Register the owned-input part's cells for one runner: `harness-<runner>-owned-input-parity.test.ts`. */
export function describeHarnessParity(scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration): void {
  describeHarnessPart('owned-input', OWNED_INPUT_GROUPS, scope, registration);
}
