import { monitoringTurnFiles } from '../workflows/monitoring-turn-partitions.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
/**
 * Harness parity — the session and lifecycle matrix.
 *
 * `ui-parity.test.ts` asserts the other axis of the same requirement: that every
 * mapper emits every v2 UI capability, so the GUI degrades per-capability rather
 * than per-backend. These cells assert the rest of the contract in
 * `agent-runner.ts` — session lifecycle, provider-failure surfacing,
 * `sendMessage`, ask routing and park declarations — over the same backends.
 *
 * Spec: `.ai/specs/2026-09-04-harness-parity-matrix.md` (#68). Nine fixes
 * (#2, #3, #4, #5, #6, #46, #48, #53, #54) each repaired a failure mode on one
 * backend that no shared contract covered; every criterion here traces to one of
 * those groups, named in its comment.
 *
 * Two tiers. The seam tier drives each real runner class against that backend's
 * own offline mock, on every runner. The run tier drives a real `RunManager`, because
 * `workflows/run/` emits `ask.requested` for every runner's `cezar_ask` card, while codex and
 * opencode also emit it from the runner for a native ask, and provider failures, asks and parks
 * settle in the orchestrator (groups 1, 3 and 6).
 *
 * Rows S36–S44 are the seam contract (hearsay-tools/cezarion#2991): each runner proves on its own
 * wire that it behaves as its declared facts say. They live in `seam-contract.testkit.ts`.
 *
 * Coverage rule (hearsay-tools/cezarion#2991): a fix inside a runner class extends the seam
 * contract or that runner's own rows, which run on every runner. A fix above the seam extends a
 * shared row, which runs on the derived runner set `SHARED_RUNNERS`: the smallest set that shows
 * every declared value of each turn-path fact. A new runner declares its facts and joins the set
 * when it adds a value. Each `describeRunners` group is one family in
 * `parity-classes.testkit.ts`, and a cell registers only on the runners its row's class names.
 * Guards: `parity-classes.test.ts` (the set covers every value; every parity file has a family)
 * and `cez/runner-fact-combination` (no workflow function touches a fact source and reads two fact keys).
 *
 * `describeHarnessParity` defines every cell. `harness-parity.test.ts` runs the
 * matrix guard and the single-runner cells, and each `harness-<runner>-<part>-parity.test.ts`
 * runs one part of a runner's cells (hearsay-tools/cezarion#1288).
 */
import { TranscriptFactsQueue } from '../runs/transcript-facts-queue.ts';
import { historyPaths } from '../runs/history-file.ts';
import { MONITORING_TURN_CRITERIA, MONITORING_ACK_CRITERIA, MONITORING_ORDER_CRITERIA } from '../workflows/monitoring-turn.testkit.ts';
import { WAIT_CRITERIA } from '../workflows/waits-parity.testkit.ts';
import {
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_VIA,
  STEP_KIND,
  STEP_STATUS,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { readMockRecords } from '../mock-records.testkit.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentInputEventSchema } from '@open-mercato/cezar-contract/events';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  RUNNER_IDS,
  type RunnerId,
} from './agent-runner.ts';
import { exemptionReasonProblem } from './exemption-reason.testkit.ts';
import { runnersUnderTest } from './runners-under-test.testkit.ts';
import { TOOL_GRANT_CASES } from './tool-grant-parity-cells.testkit.ts';
import { inputDeliveryOf } from './agent-runner.ts';
import { supportsProfiles } from './agent-profiles.ts';
import { plannedWorkflow, skillTaskSteps, type WorkflowDef } from '../workflows/types.ts';
import { workerWorkflowHash, type WorkerAccountBinding, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import { promptFor, driveSeam, exemptionFor, HARNESS_ADAPTERS, SHUTDOWN_CRITERIA, MODEL_REFUSAL_CRITERIA, PERMISSION_CRITERIA, WORKFLOW_TIMEOUT_CRITERIA, NO_PROGRESS_CRITERIA, AUTONOMOUS_CRITERIA, FINAL_MESSAGE_CRITERIA, WORKER_PROGRESS_WAIT_CRITERIA, WORKFLOW_ASK_CRITERIA, STEP_COMPLETION_CRITERIA, FOLLOWUP_CRITERIA, ANSWER_DELIVERY_CRITERIA, SKILL_RESUME_CRITERIA, SKILL_PROVISION_CRITERIA, WORKTREE_SETUP_CRITERIA, PARITY_EXEMPTIONS, PINNED_SESSION_ID, seedOpencodeMockSession, type ScenarioName, waitFor } from './harness-parity-core.testkit.ts';
import { SEAM_CONTRACT_ROWS } from './seam-contract.testkit.ts';
import { CONTROL_CRITERIA } from './harness-parity-rows.testkit.ts';
import { parityRowId } from './parity-classes.testkit.ts';
import { withOwnedInputRun, withoutTaskScenario, withSkillParentRun } from './workflow-parity-core.testkit.ts';
import { blockRunWrites, muteLockedDatabaseLogs, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { HARNESS_PARITY_GROUPS, harnessParityFile, type HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessGroups, probeEnv, readRecording, vitestRegistration, type HarnessGroup, type HarnessParityScope, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { SEAM_CRITERIA } from './harness-parity-seam-tier.testkit.ts';
import { RUN_CRITERIA } from './harness-parity-run-tier.testkit.ts';
import { CONTRACT_GROUPS } from './harness-parity-contract.cells.testkit.ts';
import { OWNERSHIP_GROUPS } from './harness-parity-ownership.cells.testkit.ts';
import { PROVIDER_GROUPS } from './harness-parity-provider.cells.testkit.ts';
import { RUN_GROUPS } from './harness-parity-run.cells.testkit.ts';
import { SESSION_GROUPS, FOLLOW_ON_CRITERION, INPUT_CRITERIA } from './harness-parity-session.cells.testkit.ts';
import { SETTLEMENT_GROUPS } from './harness-parity-settlement.cells.testkit.ts';
import { STARTUP_GROUPS } from './harness-parity-startup.cells.testkit.ts';

/** One request the OpenCode serve mock recorded in `CEZ_MOCK_ARGS_FILE`. */
type OpencodeRequestRow = { method?: string; url?: string; body?: { permission?: unknown } };

const agentInput = (parentRunId: string, text = '/owned-skill mock:agent-echo parent steering'): AgentInput => ({
  id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId, text, createdAt: new Date().toISOString(),
});

/** Every matrix row with the scenario it drives, as the matrix guard reads them. */
export function parityRowScenarios(): ReadonlyArray<{ readonly id: string; readonly scenario: ScenarioName }> {
  return [
    ...PERMISSION_CRITERIA, ...MODEL_REFUSAL_CRITERIA, ...SHUTDOWN_CRITERIA,
    ...MONITORING_TURN_CRITERIA, ...MONITORING_ACK_CRITERIA, ...MONITORING_ORDER_CRITERIA,
    ...WAIT_CRITERIA, ...WORKFLOW_ASK_CRITERIA, ...STEP_COMPLETION_CRITERIA, ...FOLLOWUP_CRITERIA,
    ...ANSWER_DELIVERY_CRITERIA, ...SKILL_RESUME_CRITERIA, ...SKILL_PROVISION_CRITERIA,
    ...WORKTREE_SETUP_CRITERIA, ...AUTONOMOUS_CRITERIA, ...WORKER_PROGRESS_WAIT_CRITERIA,
    ...FINAL_MESSAGE_CRITERIA, ...NO_PROGRESS_CRITERIA, ...WORKFLOW_TIMEOUT_CRITERIA,
    ...SEAM_CRITERIA, ...SEAM_CONTRACT_ROWS, ...INPUT_CRITERIA, FOLLOW_ON_CRITERION, ...CONTROL_CRITERIA, ...RUN_CRITERIA,
  ];
}

/** The row ids each group registers on any runner, from its cell titles (hearsay-tools/cezarion#2991). */
export function harnessGroupRows(): Map<string, Set<string>> {
  const rows = new Map<string, Set<string>>();
  for (const runner of RUNNER_IDS) {
    describeHarnessParity({ runner, part: 'session' }, {
      describe: ((_name: string, ...args: unknown[]) => { (args.at(-1) as () => void)(); }) as typeof describe,
      it: (() => undefined) as unknown as typeof it,
      beforeAll: (() => undefined) as typeof beforeAll,
      afterAll: (() => undefined) as typeof afterAll,
      toolGrants: () => undefined,
      allGroups: true,
      probe: (group, title) => {
        const row = parityRowId(title);
        if (row) rows.set(group, (rows.get(group) ?? new Set()).add(row));
      },
    });
  }
  return rows;
}

export { HARNESS_PARITY_GROUPS, harnessParityFile, type HarnessParityPart };

function ownedToOwnedWorkflowsGroups(r: HarnessRegistrar): void {
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

  describeRunners('owned-workflows', 'harness parity — owned workflows', () => {
    for (const backend of runners) {
      it(`${backend} R13 runs a persisted catalog chain inside the owned worker, check step included (#451)`, async () => {
        const workflowDef = { name: 'review', source: 'file' as const, path: '.ai/cezar/workflows/review.yaml', steps: [
          { id: 'inspect', name: 'Inspect', prompt: '{{task}}', runner: backend },
          // Runs in the worker's own worktree, never the parent checkout.
          { id: 'verify', command: 'test -f a.txt && test "$(git rev-parse --show-toplevel)" = "$PWD" && printf %s "$PWD" > "$CEZ_PARITY_CWD"' },
        ] };
        await withOwnedInputRun(backend, 'cezar-done', async ({ store, manager, repoRoot, runId }) => {
          const cwdFile = join(repoRoot, 'check-cwd.txt');
          process.env.CEZ_PARITY_CWD = cwdFile;
          try {
            manager.enqueueOwnedRun(runId);
            await waitFor(() => !manager.isActive(runId), 30_000);
          } finally { delete process.env.CEZ_PARITY_CWD; }
          const run = store.getRun(runId)!;
          expect(run.error).toBeUndefined();
          expect(run.steps.map(step => ({ id: step.id, kind: step.kind, status: step.status }))).toEqual([
            { id: 'inspect', kind: STEP_KIND.agent, status: STEP_STATUS.done }, { id: 'verify', kind: STEP_KIND.check, status: STEP_STATUS.done },
          ]);
          expect(store.readEvents(runId).filter(e => e.type === 'check-output')).toMatchObject([{ stepId: 'verify', exitCode: 0 }]);
          if (run.delegation?.role !== 'worker') throw new Error('expected worker');
          expect(readFileSync(cwdFile, 'utf8')).toBe(run.delegation.workspace.path);
        }, { workflowDef });
      }, 60_000);

      it(`${backend} R42 spawns from a skill-driven parent without inheriting its skill on the native wire (#778)`, async () => {
        const name = 'skill-inheritance';
        await withSkillParentRun(backend, probeEnv(name), async ({ store, manager, repoRoot, runId }) => {
          const parentRecording = readRecording(repoRoot, name).join('\n');
          expect(parentRecording).toContain('Selected skill: /parent-skill');
          expect(parentRecording).toContain('PARENT SKILL BODY 778');
          expect(parentRecording).toContain('parent extra');
          await waitFor(() => !manager.isActive(runId), 30_000);
          const worker = store.getRun(runId)!;
          expect(worker.error).toBeUndefined();
          expect(worker.steps.map(step => ({ id: step.id, status: step.status }))).toEqual([{ id: 'task', status: STEP_STATUS.done }]);
          if (worker.delegation?.role !== 'worker') throw new Error('expected worker');
          const childRecording = readRecording(worker.delegation.workspace.path, name).join('\n');
          expect(childRecording).toContain('parent extra');
          expect(childRecording).not.toContain('Selected skill: /parent-skill');
          expect(childRecording).not.toContain('PARENT SKILL BODY 778');
          expect(worker.systemPrompt).toBe('parent extra');
        });
      }, 60_000);

      it(`${backend} R41 runs a --skill worker with the skill in its system prompt and no parent skill (#778)`, async () => {
        const workflowDef = plannedWorkflow(skillTaskSteps('worker-skill').map(step => ({ ...step, runner: backend })));
        const identity: WorkerExecutionIdentity = { kind: 'internal', workflowHash: workerWorkflowHash(workflowDef) };
        const name = 'worker-skill';
        await withOwnedInputRun(backend, 'cezar-done', async ({ store, manager, repoRoot, runId, parentRunId }) => {
          const skillsDir = join(repoRoot, '.ai/cezar/skills');
          mkdirSync(skillsDir, { recursive: true });
          writeFileSync(join(skillsDir, 'worker-skill.md'), 'WORKER SKILL BODY');
          store.updateRun(parentRunId, { systemPrompt: 'Selected skill: /parent-skill\nPARENT SKILL BODY\nparent extra' });
          store.updateRun(runId, { systemPrompt: 'parent extra' });
          manager.enqueueOwnedRun(runId);
          await waitFor(() => !manager.isActive(runId), 30_000);
          const run = store.getRun(runId)!;
          expect(run.error).toBeUndefined();
          expect(run.steps.map(step => ({ id: step.id, status: step.status }))).toEqual([{ id: 'task', status: STEP_STATUS.done }]);
          if (run.delegation?.role !== 'worker') throw new Error('expected worker');
          // Read the backend mock's argv/requests and stdin in the worker's own cwd.
          // Normalized events cannot prove that the skill reached the provider.
          const recording = readRecording(run.delegation.workspace.path, name).join('\n');
          expect(recording).toContain('WORKER SKILL BODY');
          expect(recording).toContain('parent extra');
          expect(recording).not.toContain('Selected skill: /parent-skill');
        }, { workflowDef, identity, env: probeEnv(name) });
      }, 60_000);

      it(`${backend} R14 runs an accepted mixed-runner chain under per-step identity, each step on its own pinned account (#452)`, async () => {
        const other = RUNNER_IDS[(RUNNER_IDS.indexOf(backend) + 1) % RUNNER_IDS.length]!;
        const homes = realpathSync(mkdtempSync(join(tmpdir(), 'cez-parity-accounts-')));
        // What acceptance captures for a default account: a relocated home for the providers that
        // have one (never the developer's real login), a bare provider marker for the rest.
        const binding = (provider: RunnerId): WorkerAccountBinding => {
          if (!supportsProfiles(provider)) return { provider, profileId: 'default' };
          const homePath = join(homes, provider); mkdirSync(homePath, { recursive: true });
          return { provider, profileId: 'default', homePath, ...(provider === 'claude' ? { claudeLayout: { kind: 'relocated' } } : {}) };
        };
        const workflowDef: WorkflowDef = { name: 'mixed', source: 'file', path: '.ai/cezar/workflows/mixed.yaml', steps: [
          { id: 'first', prompt: promptFor(backend, 'cezar-done'), runner: backend, agentProfile: 'default' },
          { id: 'second', prompt: promptFor(other, 'cezar-done'), runner: other, agentProfile: 'default' },
        ] };
        const identity: WorkerExecutionIdentity = { kind: 'accepted', account: binding(backend), grants: {}, workflowHash: workerWorkflowHash(workflowDef), steps: [
          { stepId: 'first', account: binding(backend), grants: {} }, { stepId: 'second', account: binding(other), grants: {} },
        ] };
        try {
          await withOwnedInputRun(backend, 'cezar-done', async ({ store, manager, runId }) => {
            manager.enqueueOwnedRun(runId);
            await waitFor(() => !manager.isActive(runId), 30_000);
            const run = store.getRun(runId)!;
            expect(run.error).toBeUndefined();
            // Each step launched on ITS runner under ITS pinned account; the run-level runner is the first step's.
            expect(run.steps.map(step => ({ id: step.id, status: step.status, backend: step.backend, profileId: step.profileId }))).toEqual([
              { id: 'first', status: STEP_STATUS.done, backend, profileId: 'default' }, { id: 'second', status: STEP_STATUS.done, backend: other, profileId: 'default' },
            ]);
            expect(run.runner).toBe(backend);
          }, { workflowDef, identity, agentProfile: 'default', extraBackends: [other] });
        } finally { rmSync(homes, { recursive: true, force: true }); }
      }, 60_000);

    }
  });
}

function opencodeDurableInput(r: HarnessRegistrar): void {
  const { scope, describe, it } = r;
  if (scope === 'once') {
    describe('OpenCode durable input acknowledgements', () => {
      it.each(['rejected', 'finished', 'cancelled'] as const)('%s opening answer never checkpoints an unanswered ask', async outcome => {
        await withOwnedInputRun('opencode', 'ask', async fixture => {
          const { runId, parentRunId } = fixture;
          fixture.manager.enqueueOwnedRun(runId);
          await waitFor(() => fixture.store.transcriptFacts(runId).pendingAsk?.routedMessageId !== undefined);
          const input = agentInput(parentRunId);
          expect(fixture.manager.steerWorker(runId, input)).toBe('queued');
          const { store, manager } = await fixture.restart();
          const before = store.readEvents(runId).at(-1)!.seq;
          withoutTaskScenario(store, runId);
          // The parent's answer reopens the closed session as its opening input (hearsay-tools/cezarion#2410).
          const reply = await fixture.answer(outcome === 'rejected' ? 'mock:reject-agent-post' : 'mock:hold');
          // The reopened session waits for capacity, so it may not have started yet.
          await waitFor(() => manager.isActive(runId) || store.getRun(runId)?.status === 'failed');
          if (outcome !== 'rejected') {
            await waitFor(() => store.readEvents(runId).some(e => e.seq > before && e.type === 'turn.started'));
            if (outcome === 'finished') expect(manager.finish(runId)).toBe(true);
            else manager.cancel(runId);
          }
          await waitFor(() => !manager.isActive(runId));
          const events = store.readEvents(runId).filter(e => e.seq > before);
          if (outcome === 'rejected') {
            // A parent's rejected answer stays queued for another try, so the worker waits.
            expect(store.getRun(runId)?.status).toBe('waiting');
            expect(events.filter(e => e.type === 'error')).toHaveLength(1);
            expect(events.findIndex(e => e.type === 'error')).toBeLessThan(events.findIndex(e => e.type === 'turn-end'));
          }
          expect(events.filter(e => e.type === 'human-input-delivered')).toEqual([]);
          // #505: the queued message steers into the answering turn right behind the answer,
          // so it may carry a delivery receipt; the input itself is unchanged and never lost.
          const withoutReceipts = (inputs: AgentInput[] | undefined) => inputs?.filter(entry => entry.id !== reply).map(({ deliveredAt: _d, consumedAt: _c, awaitingRead: _a, ...rest }) => rest);
          expect(withoutReceipts(store.getRun(runId)?.agentInputs)).toEqual([input]);
          // hearsay-tools/cezarion#1260: Finish closes the question it never saw answered, without a
          // delivery. A Stop closes it with the worker (hearsay-tools/cezarion#2410). A rejected answer
          // leaves it for another answer.
          const askSeq = store.readEvents(runId).find(e => e.type === 'ask.requested')!.seq;
          const closed = { finished: 'finish', cancelled: 'worker-stopped', rejected: undefined }[outcome];
          expect(events.filter(e => e.type === 'human-ask-closed')).toEqual(closed ? [expect.objectContaining({ askSeq, reason: closed })] : []);
          const recovered = await fixture.restart();
          expect(hasPendingAsk(recovered.store, runId)).toBe(outcome === 'rejected');
          if (outcome === 'rejected') expect(recovered.manager.continueRun(runId).ok).toBe(false);
          expect(withoutReceipts(recovered.store.getRun(runId)?.agentInputs)).toEqual([input]);
        });
      }, 60_000);

      it.each(['fresh', 'continuation'] as const)('%s late reply acknowledgement plus DONE retries accepted input', async mode => {
        await withOwnedInputRun('opencode', 'baseline', async ({ store, manager, runId, parentRunId, answer }) => {
          const prompt = 'mock:ask-reply-late-cezar-done';
          if (mode === 'fresh') store.updateRun(runId, { task: prompt });
          manager.enqueueOwnedRun(runId);
          let asked = 0;
          if (mode === 'continuation') {
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            manager.finish(runId);
            await waitFor(() => !manager.isActive(runId));
            // The idle worker's park may already be Cezar's fallback question (hearsay-tools/cezarion#1301).
            asked = store.readEvents(runId).filter(e => e.type === 'ask.requested').length;
            expect(manager.continueRun(runId, { text: prompt }).ok).toBe(true);
          }
          await waitFor(() => store.readEvents(runId).filter(e => e.type === 'ask.requested').length > asked);
          const input = agentInput(parentRunId);
          expect(manager.steerWorker(runId, input)).toBe('queued');
          await answer('Vitest');
          await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.deliveredAt);
          await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes(input.text)));
          expect(manager.isActive(runId)).toBe(true);
        });
      }, 60_000);

      it('rejected mid-session human POST remains nonfatal', async () => {
        await withOwnedInputRun('opencode', 'baseline', async ({ store, manager, runId }) => {
          manager.enqueueOwnedRun(runId);
          await waitFor(() => store.getRun(runId)?.status === 'waiting');
          expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:reject-agent-post' }])).toBe(true);
          await waitFor(() => store.readEvents(runId).some(e => e.type === 'note' && String(e.message).includes('prompt failed')));
          expect(store.readEvents(runId).filter(e => e.type === 'error')).toEqual([]);
          expect(manager.isActive(runId)).toBe(true);
          manager.finish(runId);
          await waitFor(() => !manager.isActive(runId));
          expect(['done', 'review']).toContain(store.getRun(runId)?.status);
        });
      }, 60_000);

      it.each(['fresh', 'continuation'] as const)('%s rejected agent POST fails without draining more accepted input', async mode => {
        await withOwnedInputRun('opencode', 'baseline', async ({ store, manager, runId, parentRunId }) => {
          manager.enqueueOwnedRun(runId);
          await waitFor(() => store.getRun(runId)?.status === 'waiting');
          if (mode === 'continuation') {
            manager.finish(runId);
            await waitFor(() => !manager.isActive(runId));
            expect(manager.continueRun(runId, { text: 'mock:baseline' }).ok).toBe(true);
            await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
          }
          const rejected = agentInput(parentRunId, 'mock:reject-agent-post');
          expect(manager.steerWorker(runId, rejected)).toBe('queued');
          const pending = agentInput(parentRunId);
          expect(manager.steerWorker(runId, pending)).toBe('queued');
          await waitFor(() => store.readEvents(runId).some(e => e.type === 'error'));
          await waitFor(() => !manager.isActive(runId));
          expect(store.getRun(runId)?.status).toBe('failed');
          expect(store.getRun(runId)?.error).toContain('agent input failed');
          expect(store.getRun(runId)?.agentInputs?.[1]).toEqual(pending);
        });
      }, 60_000);
    });
  }
}

function matrixGuards(r: HarnessRegistrar): void {
  const { scope, describe, it, registeredGroups } = r;
  if (scope === 'once') {
    describe('harness parity — the matrix itself', () => {
      const allIds = [
        ...SHUTDOWN_CRITERIA.map(c => c.id),
    ...MODEL_REFUSAL_CRITERIA.map(c => c.id),
        ...PERMISSION_CRITERIA.map(c => c.id),
        ...MONITORING_TURN_CRITERIA.map(c => c.id),
        ...MONITORING_ACK_CRITERIA.map(c => c.id),
        ...MONITORING_ORDER_CRITERIA.map(c => c.id),
        ...WAIT_CRITERIA.map(c => c.id),
        ...WORKFLOW_ASK_CRITERIA.map(c => c.id),
        ...STEP_COMPLETION_CRITERIA.map(c => c.id),
        ...FOLLOWUP_CRITERIA.map(c => c.id),
        ...ANSWER_DELIVERY_CRITERIA.map(c => c.id),
        ...SKILL_RESUME_CRITERIA.map(c => c.id),
        ...SKILL_PROVISION_CRITERIA.map(c => c.id),
        ...WORKTREE_SETUP_CRITERIA.map(c => c.id),
        ...AUTONOMOUS_CRITERIA.map(c => c.id),
        ...FINAL_MESSAGE_CRITERIA.map(c => c.id),
        ...WORKER_PROGRESS_WAIT_CRITERIA.map(c => c.id),
        ...NO_PROGRESS_CRITERIA.map(c => c.id),
        ...WORKFLOW_TIMEOUT_CRITERIA.map((c) => c.id),
        ...SEAM_CRITERIA.map((c) => c.id),
        ...SEAM_CONTRACT_ROWS.map((c) => c.id),
        ...INPUT_CRITERIA.map((c) => c.id),
        FOLLOW_ON_CRITERION.id,
        ...CONTROL_CRITERIA.map((c) => c.id),
        ...RUN_CRITERIA.map((c) => c.id),
      ];
      const rows = parityRowScenarios();
      const scenarioOf = (id: string): ScenarioName => {
        const row = rows.find(c => c.id === id);
        if (!row) throw new Error(`unknown criterion id "${id}"`);
        return row.scenario;
      };

      // AC #6: a new id in RUNNER_IDS fails here until every row is addressed.
      it('every criterion is a live row or a declared exemption for every runner', () => {
        const missing: string[] = [];
        for (const backend of RUNNER_IDS) {
          for (const id of allIds) {
            const declared = HARNESS_ADAPTERS[backend]?.scenarios[scenarioOf(id)] !== undefined;
            if (!declared && !exemptionFor(id, backend)) missing.push(`${backend}/${id}`);
          }
        }
        expect(missing).toEqual([]);
      });

      it('R26 enumerates each runner ask path with a live prompt or a named exemption', () => {
        // Independent wire inventory: deleting an adapter variant must fail this
        // guard, even when another ask kind still exercises the same backend.
        const expectedKinds: Record<RunnerId, readonly string[]> = {
          claude: ['cezar_ask'],
          codex: ['item/tool/requestUserInput'],
          opencode: ['question.asked'],
          pi: ['cezar_ask'],
          cursor: ['cezar_ask'],
          omp: ['cezar_ask'],
        };
        for (const backend of RUNNER_IDS) {
          const cases = HARNESS_ADAPTERS[backend]?.askResumeCases;
          expect(cases).toBeDefined();
          if (exemptionFor('R26', backend)) continue;
          expect(cases.map(ask => ask.kind)).toEqual(expectedKinds[backend]);
          expect(cases.length).toBeGreaterThan(0);
          expect(new Set(cases.map(ask => ask.kind)).size).toBe(cases.length);
          expect(cases.some(ask => ask.scenario === 'ask-resume')).toBe(true);
          for (const ask of cases) {
            expect(ask.kind.trim()).not.toBe('');
            expect(ask.answer.trim()).not.toBe('');
            expect(promptFor(backend, ask.scenario).trim()).not.toBe('');
          }
        }
      });

      it('protocol and matrix prose name runners without a counted roster', () => {
        const countedRunners = /\b(?:[2-9]\d*|1\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:real|offline|native|supported|existing|unrelated|passing|per-runner|wire)\s+)*(?:runners?|backends?|mocks?|mock selectors|test files)\b/gi;
        for (const path of ['AGENT_PROTOCOL.md', '.ai/specs/2026-09-04-harness-parity-matrix.md',
          'packages/cezar/src/core/harness-parity.test.ts', 'packages/cezar/src/core/harness-parity-cells.testkit.ts',
          'packages/cezar/src/core/harness-parity.testkit.ts', 'packages/cezar/src/core/harness-parity-core.testkit.ts',
          'packages/cezar/src/core/workflow-parity.testkit.ts', 'packages/cezar/src/core/workflow-parity-core.testkit.ts']) {
          const source = readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
          expect(source.match(countedRunners) ?? [], path).toEqual([]);
        }
      });

      it('every repository path the protocol names exists', () => {
        // A backticked token is a repository path when it has a directory, a source or doc
        // extension and plain path characters only: no wildcard, `<placeholder>`, `{a,b}` or space.
        // It resolves from the repository root or from `packages/cezar/src/`.
        const repositoryPath = /^[\w.@-]+(?:\/[\w.@-]+)+\.(?:[cm]?[jt]s|tsx|md)$/;
        const root = new URL('../../../../', import.meta.url);
        const prose = readFileSync(new URL('AGENT_PROTOCOL.md', root), 'utf8').replace(/^```[\s\S]*?^```/gm, '');
        const named = new Set([...prose.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!)
          .filter(token => repositoryPath.test(token) && !token.split('/').includes('..')));
        expect(named.size).toBeGreaterThan(0);
        const missing = [...named].filter(path => !['', 'packages/cezar/src/'].some(base => existsSync(new URL(base + path, root))));
        expect(missing.sort()).toEqual([]);
      });

      it('runs every runner\'s cells from its own file', () => {
        const routes = Object.values(HARNESS_PARITY_GROUPS).flat();
        expect([...routes].sort()).toEqual([...registeredGroups].sort());
        expect(new Set(registeredGroups).size).toBe(registeredGroups.length);
        for (const backend of RUNNER_IDS) for (const part of Object.keys(HARNESS_PARITY_GROUPS) as HarnessParityPart[]) {
          const file = harnessParityFile(backend, part);
          expect(existsSync(new URL(`./${file}`, import.meta.url)), file).toBe(true);
          const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
          expect(source, file).toContain(`describeHarnessParity({ runner: '${backend}', part: '${part}' });`);
          expect(source.match(/describeHarnessParity\(/g), file).toHaveLength(1);
        }
      });

      it('every runner id has an adapter', () => {
        for (const backend of RUNNER_IDS) {
          expect(HARNESS_ADAPTERS[backend]?.backend).toBe(backend);
        }
      });

      it('no exemption names a criterion or runner that does not exist', () => {
        for (const exemption of PARITY_EXEMPTIONS) {
          expect(allIds).toContain(exemption.criterion);
          expect(RUNNER_IDS as readonly string[]).toContain(exemption.backend);
          expect(exemptionReasonProblem(exemption.reason), `${exemption.criterion}/${exemption.backend}`).toBeUndefined();
        }
      });

      it('each exemption kind agrees with whether a scenario prompt is declared', () => {
        for (const exemption of PARITY_EXEMPTIONS) {
          const declared =
            HARNESS_ADAPTERS[exemption.backend].scenarios[scenarioOf(exemption.criterion)] !==
            undefined;
          // A contradictory entry is worse than none: `capability-absent` needs the
          // scenario to be drivable so the inversion means something, and
          // `scenario-unconstructible` claims the opposite.
          expect({ criterion: exemption.criterion, backend: exemption.backend, declared }).toEqual({
            criterion: exemption.criterion,
            backend: exemption.backend,
            declared: exemption.kind === 'capability-absent',
          });
        }
      });

      it('uses no skipped or pending cell — an inapplicable one is a declared exemption', () => {
        for (const url of [new URL(import.meta.url), new URL('../workflows/worker-parent-attention.testkit.ts', import.meta.url), ...['monitoring-turn-rows.testkit.ts', 'monitoring-turn-partitions.testkit.ts', 'monitoring-turn-coverage.test.ts', ...monitoringTurnFiles].map(file => new URL(`../workflows/${file}`, import.meta.url)), new URL('./skill-resume-parity.testkit.ts', import.meta.url)]) {
          const source = readFileSync(url, 'utf8');
          expect(source).not.toMatch(/\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(/);
        }
      });
    });
  }
}

function opencodeRestrictedSessions(r: HarnessRegistrar): void {
  const { scope, describe, it } = r;
  if (scope === 'once') {
    describe('harness parity — D1 OpenCode sessions an older cezar restricted', () => {
      // OpenCode appends permission rules and has no remove, so a `task` deny an older cezar
      // added stays on its session; cezar neither PATCHes it again nor tries to lift it.
      it('opencode governed Continue sends no PATCH when the session already denies task', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-native-wire-sticky-'));
        const path = join(dir, 'wire.ndjson');
        try {
          seedOpencodeMockSession(path, {
            permission: [{ permission: 'task', pattern: '*', action: 'deny' }],
          });
          const obs = await driveSeam('opencode', 'baseline', { spec: {
            cwd: dir, resume: true, restrictCrossSessionMessaging: true,
            env: { CEZ_MOCK_ARGS_FILE: path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' },
          } });
          expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
          const rows = readMockRecords<OpencodeRequestRow>(path);
          expect(rows.some(row => row.method === 'GET' && row.url === `/session/${PINNED_SESSION_ID}`)).toBe(true);
          expect(rows.filter(row => row.method === 'POST' && row.url === '/session')).toEqual([]);
          expect(rows.filter(row => row.method === 'PATCH')).toEqual([]);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 45000);

      it('opencode governed Continue POSTs a session with no task deny when GET /session/{id} 404s', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-native-wire-fallback-'));
        const path = join(dir, 'wire.ndjson');
        try {
          const obs = await driveSeam('opencode', 'baseline', { spec: {
            cwd: dir, resume: true, restrictCrossSessionMessaging: true,
            env: { CEZ_MOCK_ARGS_FILE: path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' },
          } });
          expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
          const rows = readMockRecords<OpencodeRequestRow>(path);
          expect(rows.some(row => row.method === 'GET' && row.url === `/session/${PINNED_SESSION_ID}`)).toBe(true);
          const created = rows.find(row => row.method === 'POST' && row.url === '/session');
          expect(created).toBeDefined();
          expect(created?.body?.permission).toBeUndefined();
          expect(rows.filter(row => row.method === 'PATCH')).toEqual([]);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 45000);
    });
  }
}

/** Every group and once-only block, in the order the once file and the dry collections register them. */
const HARNESS_PARITY_ORDER: readonly HarnessGroup[] = [
  CONTRACT_GROUPS.contract, STARTUP_GROUPS.startup, SESSION_GROUPS.seam, SESSION_GROUPS['tool-grants'], SESSION_GROUPS.input,
  RUN_GROUPS.diagnostics, OWNERSHIP_GROUPS.continue, OWNERSHIP_GROUPS.restart, OWNERSHIP_GROUPS.owner, OWNERSHIP_GROUPS.adopt,
  OWNERSHIP_GROUPS.stop, SESSION_GROUPS.session, PROVIDER_GROUPS.provider, RUN_GROUPS.run, RUN_GROUPS.child, RUN_GROUPS.hooks,
  RUN_GROUPS.answer, ownedToOwnedWorkflowsGroups, opencodeDurableInput, matrixGuards, SESSION_GROUPS.governed,
  opencodeRestrictedSessions, SESSION_GROUPS['native-message'], SESSION_GROUPS.spec, SESSION_GROUPS.tools, SESSION_GROUPS.cdp,
  SETTLEMENT_GROUPS.cleanup, SETTLEMENT_GROUPS['multi-continue'], SETTLEMENT_GROUPS.superseded, SETTLEMENT_GROUPS.disposal,
  SETTLEMENT_GROUPS.scratch, RUN_GROUPS.monitoring, RUN_GROUPS.prs, SETTLEMENT_GROUPS.permission,
  SETTLEMENT_GROUPS['default-permission'], SETTLEMENT_GROUPS.retirements, SETTLEMENT_GROUPS['permission-failure'],
  SETTLEMENT_GROUPS.malformed, SETTLEMENT_GROUPS['early-permission'], SETTLEMENT_GROUPS['late-permission'],
  SETTLEMENT_GROUPS.mcp,
];

/** Every part at once: the once file's guards and single-runner cells, or a dry collection. */
export function describeHarnessParity(scope: HarnessParityScope, registration: HarnessRegistration = vitestRegistration()): void {
  describeHarnessGroups(scope, registration, HARNESS_PARITY_ORDER, TOOL_GRANT_CASES.length);
}

/** Collect the real row registrations without starting their hooks or test bodies. */
export function harnessParityRegistrations(runner: RunnerId, part?: HarnessParityPart): string[] {
  const names: string[] = [];
  describeHarnessParity({ runner, part: part ?? 'session' }, {
    describe: ((_name: string, body: () => void) => body()) as typeof describe,
    it: ((name: string) => { names.push(name); }) as typeof it,
    beforeAll: (() => undefined) as typeof beforeAll,
    afterAll: (() => undefined) as typeof afterAll,
    toolGrants: () => { for (const entry of TOOL_GRANT_CASES) names.push(`${runner} tool grant ${entry.id}`); },
    allGroups: part === undefined,
  });
  return names;
}
