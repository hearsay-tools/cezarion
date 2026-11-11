import { testHome } from '../home/test-home.testkit.ts';
import { monitoringTurnFiles } from '../workflows/monitoring-turn-partitions.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { observationClock } from './observation-clock.testkit.ts';
import { IDLE_TIMEOUT_MS } from '../workflows/run.ts';
import { createApp } from '../server/server.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
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
  RUN_STATUS,
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_VIA,
  STEP_KIND,
  STEP_STATUS,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunManager } from '../workflows/run.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { readMockRecords } from '../mock-records.testkit.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentInputEventSchema } from '@open-mercato/cezar-contract/events';
import type { AgentInput } from '@open-mercato/cezar-contract';
import type { UiEvent } from './ui-events.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  RUNNER_IDS,
  type RunnerId,
} from './agent-runner.ts';
import { exemptionReasonProblem } from './exemption-reason.testkit.ts';
import { runnersUnderTest } from './runners-under-test.testkit.ts';
import { TOOL_GRANT_CASES } from './tool-grant-parity-cells.testkit.ts';
import { inputDeliveryOf } from './agent-runner.ts';
import { agentTmpDir, resolveAgentTmpDir } from '../runs/agent-tmpdir.ts';
import * as gitWorktree from '../git-worktree.ts';
import { cleanupCheckpoint, seedSettledFamily } from '../workflows/delegation-reconcile.testkit.ts';
import { supportsProfiles } from './agent-profiles.ts';
import { plannedWorkflow, skillTaskSteps, type WorkflowDef } from '../workflows/types.ts';
import { workerWorkflowHash, type WorkerAccountBinding, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import { promptFor, driveSeam, textEvents, exemptionFor, HARNESS_ADAPTERS, SHUTDOWN_CRITERIA, MODEL_REFUSAL_CRITERIA, PERMISSION_CRITERIA, WORKFLOW_TIMEOUT_CRITERIA, NO_PROGRESS_CRITERIA, AUTONOMOUS_CRITERIA, FINAL_MESSAGE_CRITERIA, WORKER_PROGRESS_WAIT_CRITERIA, WORKFLOW_ASK_CRITERIA, STEP_COMPLETION_CRITERIA, FOLLOWUP_CRITERIA, ANSWER_DELIVERY_CRITERIA, SKILL_RESUME_CRITERIA, SKILL_PROVISION_CRITERIA, WORKTREE_SETUP_CRITERIA, PARITY_EXEMPTIONS, PINNED_SESSION_ID, seedOpencodeMockSession, type ScenarioName, waitFor } from './harness-parity-core.testkit.ts';
import { SEAM_CONTRACT_ROWS } from './seam-contract.testkit.ts';
import { CONTROL_CRITERIA } from './harness-parity-rows.testkit.ts';
import { parityRowId } from './parity-classes.testkit.ts';
import { withOwnedInputRun, withoutTaskScenario, withSkillParentRun, driveRun, type RunObservation } from './workflow-parity-core.testkit.ts';
import { blockRunWrites, crashStore, muteLockedDatabaseLogs, readPersistedRuns, seedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { HARNESS_PARITY_GROUPS, harnessParityFile, type HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessGroups, probeEnv, readRecording, vitestRegistration, type HarnessGroup, type HarnessParityScope, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { SEAM_CRITERIA } from './harness-parity-seam-tier.testkit.ts';
import { driveObservedRun, openTimerWait, RUN_CRITERIA, runRows, TERMINAL, timerWakeOf } from './harness-parity-run-tier.testkit.ts';
import { CONTRACT_GROUPS } from './harness-parity-contract.cells.testkit.ts';
import { PROVIDER_GROUPS } from './harness-parity-provider.cells.testkit.ts';
import { SESSION_GROUPS, FOLLOW_ON_CRITERION, INPUT_CRITERIA } from './harness-parity-session.cells.testkit.ts';
import { STARTUP_GROUPS } from './harness-parity-startup.cells.testkit.ts';

/** One request the OpenCode serve mock recorded in `CEZ_MOCK_ARGS_FILE`. */
type OpencodeRequestRow = { method?: string; url?: string; body?: { permission?: unknown } };

/** Keep the exact fire-and-forget settlement promise owned by the fixture. */
function observeSettlements(manager: RunManager) {
  const work = fixtureWork(manager);
  const track = work.track.bind(work);
  const pending: Promise<unknown>[] = [];
  const spy = vi.spyOn(work, 'track').mockImplementation((label, promise) => {
    if (label === 'settleSuccess') pending.push(promise);
    return track(label, promise);
  });
  return { pending, restore: () => spy.mockRestore() };
}

// #723: use the real RunManager on both event-handler construction paths.
async function continueDiagnosticRun(backend: RunnerId, prompt: string): Promise<RunObservation> {
  return driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
    async ({ store, manager, runId, idle }) => {
      await idle.advance(IDLE_TIMEOUT_MS);
      await waitFor(() => !manager.isActive(runId));
      expect(manager.continueRun(runId, { text: prompt }).ok).toBe(true);
      await waitFor(() => TERMINAL.includes(store.getRun(runId)?.status ?? ''), 30_000);
    });
}

/** Flush until `runId` has left the store's memory; false if it never does. */
async function leavesMemory(store: RunStore, runId: string): Promise<boolean> {
  try {
    await waitFor(() => { store.flush(); return !store.heldIds().includes(runId); }, 10_000);
    return true;
  } catch {
    return false;
  }
}

const agentInput = (parentRunId: string, text = '/owned-skill mock:agent-echo parent steering'): AgentInput => ({
  id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId, text, createdAt: new Date().toISOString(),
});

// ---- the pending request's lifecycle (hearsay-tools/cezarion#1266, P3–P8) --------------------

type PermissionRequestedEvent = Extract<UiEvent, { type: 'permission.requested' }>;
type StoredEvent = Record<string, unknown>;
const joinedText = (events: readonly StoredEvent[]) => events.filter(event => event.type === 'text').map(event => event.text).join('');
const permissionResolutionsOf = (events: readonly StoredEvent[]) => events.filter(event => event.type === 'permission.resolved');

/** A fresh `CEZ_MOCK_RELEASE_FILE` path; the mock waits for the file before its next step. */
async function withRelease<T>(body: (release: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'cez-permission-'));
  try { return await body(join(dir, 'release')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function answerThroughRoute(repoRoot: string, store: RunStore, manager: Parameters<typeof createApp>[0]['manager'], runId: string,
  request: StoredEvent, optionId: string): Promise<Response> {
  return apiRequest(createApp({ home: testHome(), repoRoot, store, manager, version: 'test' }), `/api/v1/runs/${runId}/permissions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: request.requestId, optionId }),
  });
}

const optionPicked = (request: StoredEvent, pick: string) =>
  (request.options as Array<{ id: string; label: string }>).find(option => option.label.toLowerCase().includes(pick))!;

const RETIREMENTS = [
  { id: 'P3', scenario: 'approval-resolved', text: 'Native approval settled without a cockpit answer.' },
  { id: 'P4', scenario: 'approval-turn-end', text: 'Turn ended with the approval still pending.' },
] as const;

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

function diagnosticsToStopGroups(r: HarnessRegistrar): void {
  const { describeRunners, scope, runners, it, parityRow } = r;
  describeRunners('diagnostics', 'harness parity — recoverable skill diagnostics (hearsay-tools/cezarion#723, hearsay-tools/cezarion#1265)', () => {
    for (const backend of runners) {
      for (const continuation of [false, true]) {
        const id = continuation ? 'R45' : 'R44';
        parityRow<RunObservation>(backend, {
          id, name: `${id} ${continuation ? 'continued' : 'fresh'} skill warnings preserve successful completion`, scenario: 'skill-warning',
          assert: obs => {
            expect(['review', 'done']).toContain(obs.record?.status);
            expect(obs.record?.error).toBeFalsy();
            expect(obs.events.filter(e => e.type === 'error')).toEqual([]);
            for (const root of ['.claude', '.agents']) {
              expect(obs.events).toContainEqual(expect.objectContaining({ type: 'note',
                message: `opencode: optional skill skipped: Failed to parse skill /home/agent/${root}/skills/pen-design/SKILL.md. Check that the skill file and any symlink target are readable; repair or reinstall the skill.`,
              }));
            }
            expect(obs.events).toContainEqual(expect.objectContaining({ type: 'note',
              message: 'opencode: optional skill skipped: /home/agent/.agents/skills/bad4/SKILL.md has invalid YAML frontmatter (unexpected end of the stream within a double quoted scalar at line 6, column 1: ^). Fix the frontmatter between the --- lines, for example by quoting values that contain a colon or a quote, or remove the skill.',
            }));
            expect(obs.events.filter(e => e.type === 'turn.completed').every(e => e.stopReason === 'end_turn')).toBe(true);
            expect(obs.events.some(e => e.type === 'turn.completed')).toBe(true);
          },
        }, () => continuation ? continueDiagnosticRun(backend, promptFor(backend, 'skill-warning'))
          : driveRun(backend, 'skill-warning', record => TERMINAL.includes(record?.status ?? '')));
      }
      it(`${backend} R46 continued provider failures stay fatal and actionable`, async () => {
        const obs = await continueDiagnosticRun(backend, promptFor(backend, 'provider-error'));
        expect(obs.record?.status).toBe('failed');
        expect(obs.record?.error?.trim()).toBeTruthy();
        expect(obs.events).toContainEqual(expect.objectContaining({ type: 'error' }));
      }, 45_000);
    }
    if (scope === 'once') {
      const fatalDetail: Record<string, string> = {
        'unscoped-provider-failure': 'restoring service',
        'scoped-skill-failure': '/skills/required/SKILL.md',
        'scoped-frontmatter-failure': '/skills/bad4/SKILL.md: Failed to parse YAML frontmatter',
      };
      for (const continuation of [false, true]) for (const [scenario, detail] of Object.entries(fatalDetail)) {
        it(`opencode ${continuation ? 'continued' : 'fresh'} ${scenario} remains fatal`, async () => {
          const prompt = `mock:${scenario}`;
          const obs = continuation ? await continueDiagnosticRun('opencode', prompt)
            : await driveRun('opencode', { prompt }, record => TERMINAL.includes(record?.status ?? ''));
          expect(obs.record?.status).toBe('failed');
          expect(obs.record?.error).toContain('provider');
          expect(obs.record?.error).toContain(detail);
        }, 45_000);
      }
    }
  }, true);

  // #779: only the live set is in memory. A finished run is read back from runs.db; Continue loads
  // it into the held set (the `continue` pin), `runContinuation` pins it through the same `activate`
  // helper `execute` uses, and it leaves memory again once the continuation settles.
  describeRunners('continue', 'harness parity — Continue on a finished run (#779)', () => {
    for (const backend of runners) {
      parityRow<{ pins: string[]; left: boolean; heldWhileContinuing: boolean; leftAgain: boolean; obs: RunObservation }>(backend, {
        id: 'R48', name: 'R48 Continue loads a finished run into memory and lets it go after it settles', scenario: 'cezar-done',
        assert: ({ pins, left, heldWhileContinuing, leftAgain, obs }) => {
          expect(left).toBe(true);
          expect(heldWhileContinuing).toBe(true);
          expect(leftAgain).toBe(true);
          // `execute` pins the first execution, then Continue's admission and `runContinuation`.
          expect(pins).toEqual(['active', 'continue', 'active']);
          expect(TERMINAL).toContain(obs.record?.status);
          expect(obs.record?.steps.map((step) => step.id)).toContain('continue-1');
        },
      }, async () => {
        const pins: string[] = [];
        let left = false, heldWhileContinuing = false, leftAgain = false;
        const obs = await driveRun(backend, 'cezar-done', record => TERMINAL.includes(record?.status ?? ''), 30_000,
          async ({ store, manager, runId }) => {
            await waitFor(() => !manager.isActive(runId));
            left = await leavesMemory(store, runId);
            expect(manager.continueRun(runId, { text: promptFor(backend, 'cezar-done') }).ok).toBe(true);
            heldWhileContinuing = store.heldIds().includes(runId);
            await waitFor(() => TERMINAL.includes(store.getRun(runId)?.status ?? '') && !manager.isActive(runId), 30_000);
            leftAgain = await leavesMemory(store, runId);
          },
          { beforeStart: ({ store }) => {
            const pin = store.pin.bind(store);
            store.pin = (id, holder) => { pins.push(holder); return pin(id, holder); };
          } });
        return { pins, left, heldWhileContinuing, leftAgain, obs };
      });
    }
  });

  // #779: older controllers could cancel a root and leave its Finish intent on the record. Restart
  // repairs that in the delegation sweep, which since #779 reaches only what `open` loads; a finished
  // root the sweep missed would be refused by every Continue ("parent finish is pending") for good.
  describeRunners('restart', 'harness parity — restart repairs a stale root Finish intent (#779)', () => {
    for (const backend of runners) {
      parityRow<{ repaired: boolean; left: boolean; continued: { ok: boolean; error?: string }; final: RunRecord | undefined }>(backend, {
        id: 'R49', name: "R49 restart clears a cancelled root's stale Finish intent and Continue resumes it", scenario: 'cezar-done',
        assert: ({ repaired, left, continued, final }) => {
          expect(continued).toEqual({ ok: true });
          expect(repaired).toBe(true);
          expect(left).toBe(true);
          expect(TERMINAL).toContain(final?.status);
          expect(final?.steps.map((step) => step.id)).toContain('continue-1');
        },
      }, async () => {
        let repaired = false, left = false;
        let continued: { ok: boolean; error?: string } = { ok: false };
        let final: RunRecord | undefined;
        await driveObservedRun(backend, 'cezar-done', record => TERMINAL.includes(record?.status ?? ''), 30_000,
          async ({ store, manager, runId, repoRoot }) => {
            await waitFor(() => !manager.isActive(runId));
            const dataDir = join(repoRoot, '.ai/cezar');
            store.flush();
            const records = readPersistedRuns(dataDir);
            await drainFixtureManagers(repoRoot);
            store.close();
            // The snapshot an older controller left: cancelled, intent still on it, no conversation.
            seedRuns(dataDir, records.map((record) => record.id !== runId ? record : { ...record, status: RUN_STATUS.cancelled,
              delegation: { role: 'root', permissions: [], receipts: [], finishRequestedAt: new Date().toISOString() } }));
            const rebooted = RunStore.open(dataDir, { keepLive: true });
            const recovered = createFixtureManager(rebooted, repoRoot);
            try {
              await recovered.recover();
              const root = rebooted.getRun(runId)?.delegation;
              repaired = root?.role === 'root' && root.finishRequestedAt === undefined;
              left = await leavesMemory(rebooted, runId);
              continued = recovered.continueRun(runId, { text: promptFor(backend, 'cezar-done') });
              if (continued.ok) await waitFor(() => TERMINAL.includes(rebooted.getRun(runId)?.status ?? '') && !recovered.isActive(runId), 30_000);
              final = structuredClone(rebooted.getRun(runId));
            } finally {
              await drainFixtureManagers(repoRoot);
              rebooted.close();
            }
          });
        return { repaired, left, continued, final };
      });
    }
  });

  // #779 plan step 3: `serve` and a headless `cez run` open one runs.db. A headless open (no
  // keepLive) settled every live row as interrupted and saved it, so the owner's parked run — whose
  // row only the owner's whole-file saves used to put back — loaded `failed` at the next restart and
  // its question could no longer be answered there. A run another live process claims is left alone.
  describeRunners('owner', 'harness parity — a second process leaves a parked run to its owner (#779)', () => {
    for (const backend of runners) {
      parityRow<{ afterHeadless: string | undefined; afterRestart: string | undefined; answered: { ok: boolean; error?: string }; final: RunRecord | undefined }>(backend, {
        id: 'R50', name: 'R50 a headless open beside the owner leaves its parked run waiting, and a restart still answers it', scenario: 'ask',
        assert: ({ afterHeadless, afterRestart, answered, final }) => {
          expect(afterHeadless).toBe('waiting');
          expect(afterRestart).toBe('waiting');
          expect(answered).toEqual({ ok: true });
          expect(TERMINAL).toContain(final?.status);
        },
      }, async () => {
        let afterHeadless: string | undefined, afterRestart: string | undefined;
        let answered: { ok: boolean; error?: string } = { ok: false };
        let final: RunRecord | undefined;
        await driveObservedRun(backend, 'ask', record => record?.status === 'waiting', 30_000,
          async ({ store, runId, repoRoot }) => {
            const dataDir = join(repoRoot, '.ai/cezar');
            store.flush();
            // A headless `cez run` opens the project and exits while the owner still runs.
            RunStore.open(dataDir).close();
            afterHeadless = readPersistedRuns(dataDir).find((record) => record.id === runId)?.status;
            // The owner exits: its store closes first, so nothing its manager does from here on
            // reaches runs.db, then its session ends as a dead process's would. A new owner recovers.
            store.close();
            await drainFixtureManagers(repoRoot);
            const rebooted = RunStore.open(dataDir, { keepLive: true });
            const recovered = createFixtureManager(rebooted, repoRoot);
            try {
              await recovered.recover();
              afterRestart = rebooted.getRun(runId)?.status;
              answered = recovered.continueRun(runId, { text: promptFor(backend, 'cezar-done') });
              if (answered.ok) await waitFor(() => TERMINAL.includes(rebooted.getRun(runId)?.status ?? '') && !recovered.isActive(runId), 30_000);
              final = structuredClone(rebooted.getRun(runId));
            } finally {
              await drainFixtureManagers(repoRoot);
              rebooted.close();
            }
          });
        return { afterHeadless, afterRestart, answered, final };
      });
    }
  });

  // #779 plan step 3: a control (archive, Stop, Continue…) on a run whose owning process died adopts
  // it first. Adopting settles it — nothing is resumed behind the user's back, whichever runner it
  // used — and Continue is the one control that starts its agent again, on its own session.
  describeRunners('adopt', 'harness parity — adopting a dead owner\'s run mid-turn (#779)', () => {
    for (const backend of runners) {
      parityRow<{ adopted: boolean; startedByAdoption: string[]; settled: RunRecord | undefined; continued: { ok: boolean; error?: string }; startedByContinue: string[]; resumed: RunRecord | undefined }>(backend, {
        id: 'R51', name: 'R51 adopting a dead owner\'s run mid-turn starts no agent, and Continue resumes it', scenario: 'hold',
        assert: ({ adopted, startedByAdoption, settled, continued, startedByContinue, resumed }) => {
          expect(adopted).toBe(true);
          expect(startedByAdoption).toEqual([]);
          expect(settled).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('interrupted') });
          expect(continued).toEqual({ ok: true });
          // Continue resumes the session the dead owner opened, through the one continuation path.
          expect(startedByContinue).toEqual(['runContinuation']);
          expect(resumed?.steps.map((step) => step.id)).toContain('continue-1');
        },
      }, async () => {
        let adopted = false;
        const startedByAdoption: string[] = [], startedByContinue: string[] = [];
        let settled: RunRecord | undefined, resumed: RunRecord | undefined;
        let continued: { ok: boolean; error?: string } = { ok: false };
        // Mid-turn, with the session the owner opened recorded: what a restart would resume.
        await driveObservedRun(backend, 'hold', record => record?.status === 'running' && record.steps.some((step) => step.sessionId !== undefined), 30_000,
          async ({ store, manager, runId, repoRoot }) => {
            await waitFor(() => [...fixtureWork(manager).liveSessions].some(session => session.open));
            const dataDir = join(repoRoot, '.ai/cezar');
            store.flush();
            // This cockpit was already running beside the owner, which then crashed mid-session.
            const cockpit = RunStore.open(dataDir, { keepLive: true });
            try {
              manager.dispose();
              crashStore(store);
              await drainFixtureManagers(repoRoot);
              const recovered = createFixtureManager(cockpit, repoRoot);
              let adopting = true;
              const work = fixtureWork(recovered);
              const realTrack = work.track.bind(work);
              vi.spyOn(work, 'track').mockImplementation((label, promise) => {
                if (label === 'execute' || label === 'runContinuation') (adopting ? startedByAdoption : startedByContinue).push(label);
                return realTrack(label, promise);
              });
              // Recovery dispatches transcript work with setImmediate; keep that signal real.
              vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
              adopted = await recovered.adoptOrphanedRun(runId);
              await vi.advanceTimersByTimeAsync(300);
              vi.useRealTimers();
              adopting = false;
              settled = structuredClone(cockpit.getRun(runId));
              continued = recovered.continueRun(runId, { text: promptFor(backend, 'cezar-done') });
              if (continued.ok) await waitFor(() => startedByContinue.length > 0, 30_000);
              resumed = structuredClone(cockpit.getRun(runId));
            } finally {
              vi.useRealTimers();
              await drainFixtureManagers(repoRoot);
              cockpit.close();
            }
          });
        return { adopted, startedByAdoption, settled, continued, startedByContinue, resumed };
      });
    }
  });

  // #779: Stop is the control an adoption carries out itself. The run it stops ends cancelled, as an
  // accepted Stop always reads, rather than interrupted, whichever runner it used; nothing starts.
  describeRunners('stop', 'harness parity — Stop on a dead owner\'s run mid-turn (#779)', () => {
    for (const backend of runners) {
      parityRow<{ adopted: boolean; started: string[]; stopped: RunRecord | undefined }>(backend, {
        id: 'R52', name: 'R52 Stop on a dead owner\'s run mid-turn ends it cancelled and starts no agent', scenario: 'hold',
        assert: ({ adopted, started, stopped }) => {
          expect(adopted).toBe(true);
          expect(started).toEqual([]);
          expect(stopped).toMatchObject({ status: RUN_STATUS.cancelled });
          expect(stopped?.error).toBeUndefined();
          expect(stopped?.stopping).toBeUndefined();
          expect(stopped?.steps.some((step) => step.status === 'running' || step.status === 'waiting')).toBe(false);
        },
      }, async () => {
        let adopted = false;
        const started: string[] = [];
        let stopped: RunRecord | undefined;
        await driveObservedRun(backend, 'hold', record => record?.status === 'running' && record.steps.some((step) => step.sessionId !== undefined), 30_000,
          async ({ store, manager, runId, repoRoot }) => {
            await waitFor(() => [...fixtureWork(manager).liveSessions].some(session => session.open));
            const dataDir = join(repoRoot, '.ai/cezar');
            store.flush();
            const cockpit = RunStore.open(dataDir, { keepLive: true });
            try {
              manager.dispose();
              crashStore(store);
              await drainFixtureManagers(repoRoot);
              const recovered = createFixtureManager(cockpit, repoRoot);
              const work = fixtureWork(recovered);
              const realTrack = work.track.bind(work);
              vi.spyOn(work, 'track').mockImplementation((label, promise) => {
                if (label === 'execute' || label === 'runContinuation') started.push(label);
                return realTrack(label, promise);
              });
              // Recovery dispatches transcript work with setImmediate; keep that signal real.
              vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
              adopted = await recovered.adoptOrphanedRun(runId, { stop: true });
              await vi.advanceTimersByTimeAsync(300);
              vi.useRealTimers();
              stopped = structuredClone(cockpit.getRun(runId));
            } finally {
              vi.useRealTimers();
              await drainFixtureManagers(repoRoot);
              cockpit.close();
            }
          });
        return { adopted, started, stopped };
      });
    }
  });
}

function runToOwnedWorkflowsGroups(r: HarnessRegistrar): void {
  const { describeRunners, runners, it } = r;
  describeRunners('run', 'harness parity — run tier', () => runRows(r, RUN_CRITERIA.filter(row => row.id !== 'R17')));

  // #121/#401: release native child frames only AFTER the manager has parked.
  // Waiting for the final wire-derived event prevents a green test that returned
  // before the late frames were read. OpenCode discards closed child scopes;
  // its passive usage barrier proves those frames crossed the SSE transport.
  describeRunners('child', 'harness parity — late child attention', () => {
    for (const backend of runners) {
      const exempt = exemptionFor('R15', backend);
      if (exempt) {
        it(`${backend} is exempt from R15 — ${exempt.reason}`, () => {
          expect(exempt.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].scenarios['subagent-after-park']).toBeUndefined();
        });
        continue;
      }
      it(`${backend} R15 keeps its monitoring wake after post-park child items`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-post-park-'));
        const release = join(dir, 'release');
        try {
          await driveRun(backend, { prompt: `${promptFor(backend, 'subagent-after-park')} parity-release=${release}` },
            record => record?.status === 'waiting', 30_000,
            async ({ store, runId }) => {
              expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting });
              const wake = timerWakeOf(store.getRun(runId));
              expect(wake).toBeDefined();
              const before = store.readEvents(runId).length;
              const changes: Array<{ status: string; monitoringWakeAt?: string | undefined }> = [];
              const recordChange = (record: NonNullable<RunObservation['record']>) => {
                if (record.id === runId) changes.push({ status: record.status, monitoringWakeAt: timerWakeOf(record) });
              };
              store.on('run', recordChange);
              try {
                writeFileSync(release, 'go');
                await waitFor(() => store.readEvents(runId).slice(before).some(event =>
                  backend === 'opencode'
                    ? event.type === 'usage.updated' && (event.usage as { total?: number } | undefined)?.total === 424242
                    : JSON.stringify(event).includes('Post-park child update processed.')));
                expect({ ...store.getRun(runId), monitoringWakeAt: timerWakeOf(store.getRun(runId)) }).toMatchObject({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
                for (const change of changes) expect(change).toEqual({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
                const after = store.readEvents(runId).slice(before);
                expect(after.some(event => event.type === 'turn.started')).toBe(false);
                const childItems = (backend === 'opencode' ? store.readEvents(runId).slice(0, before) : after)
                  .filter(event => event.type.startsWith('item.') && event.item && (event.item as { parentItemId?: string }).parentItemId);
                expect(childItems.length).toBeGreaterThan(0);
                if (backend === 'opencode') expect(after.some(event => event.type.startsWith('item.'))).toBe(false);
              } finally { store.off('run', recordChange); }
            });
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 60_000);
    }
  });

  // #961: native hook frames reach the event log and nothing else. A hook that
  // completes after the run parked (Squeal's async `waiter`) must neither wake the
  // run, move its wake time, nor open a turn; the mid-turn hook must not end one.
  describeRunners('hooks', 'harness parity — hooks never move run state', () => {
    for (const backend of runners) {
      const exempt = exemptionFor('R77', backend);
      if (exempt) {
        it(`${backend} is exempt from R77 — ${exempt.reason}`, () => {
          expect(exempt.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].scenarios['hook-after-park']).toBeUndefined();
        });
        continue;
      }
      it(`${backend} R77 keeps a parked run parked through mid-turn and late hook items`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-hook-park-'));
        const release = join(dir, 'release');
        try {
          await driveRun(backend, { prompt: `${promptFor(backend, 'hook-after-park')} parity-release=${release}` },
            record => record?.status === 'waiting', 30_000,
            async ({ store, runId }) => {
              expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting });
              const wake = timerWakeOf(store.getRun(runId));
              expect(wake).toBeDefined();
              const before = store.readEvents(runId).length;
              const changes: Array<{ status: string; monitoringWakeAt?: string | undefined }> = [];
              const recordChange = (record: NonNullable<RunObservation['record']>) => {
                if (record.id === runId) changes.push({ status: record.status, monitoringWakeAt: timerWakeOf(record) });
              };
              store.on('run', recordChange);
              try {
                writeFileSync(release, 'go');
                await waitFor(() => store.readEvents(runId).slice(before).some(event => JSON.stringify(event).includes('Late hook processed.')));
                expect({ ...store.getRun(runId), monitoringWakeAt: timerWakeOf(store.getRun(runId)) }).toMatchObject({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
                for (const change of changes) expect(change).toEqual({ status: RUN_STATUS.waiting, monitoringWakeAt: wake });
                expect(store.readEvents(runId).slice(before).some(event => event.type === 'turn.started')).toBe(false);
                const hooks = store.readEvents(runId)
                  .filter(event => event.type === 'item.completed' && (event.item as { kind?: string } | undefined)?.kind === 'hook')
                  .map(event => (event.item as { id: string }).id);
                expect(hooks).toHaveLength(2);
                expect(new Set(hooks).size).toBe(2);
              } finally { store.off('run', recordChange); }
            });
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 60_000);
    }
  });

  // #398: a native answer's turn boundary must not ask the human to prompt again.
  // R6 deliberately tests markerless owned-input draining; it cannot prove completion.
  describeRunners('answer', 'harness parity — answer to completion run tier', () => {
    for (const backend of runners) {
      const exempt = exemptionFor('R26', backend);
      if (exempt) {
        it(`${backend} is exempt from R26 — ${exempt.reason}`, () => {
          expect(exempt.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].askResumeCases).toEqual([]);
          expect(HARNESS_ADAPTERS[backend].scenarios['ask-resume']).toBeUndefined();
        });
        continue;
      }
      for (const ask of HARNESS_ADAPTERS[backend].askResumeCases) {
        it(`${backend} R26 completes after ${ask.kind} without another needs-you park`, async () => {
          await withOwnedInputRun(backend, ask.scenario, async ({ store, manager, runId, answer }) => {
            manager.enqueueOwnedRun(runId);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            expect(hasPendingAsk(store, runId)).toBe(true);
            // Check the real ask card too: relabelling the question fixture as a
            // plan fixture must not silently remove create_plan coverage.
            const expectedHeader = ask.kind === 'cursor/create_plan' ? 'Plan'
              : ask.kind === 'cursor/ask_question' ? 'Tests' : 'Library';
            expect(store.readEvents(runId).find(event => event.type === 'ask.requested')?.questions)
              .toMatchObject([{ header: expectedHeader }]);
            const statuses: string[] = [];
            const recordStatus = (run: { id: string; status: string }) => {
              if (run.id === runId) statuses.push(run.status);
            };
            store.on('run', recordStatus);
            try {
              // The parent answers (hearsay-tools/cezarion#2410): the parked worker takes it as a wake.
              await answer(ask.answer);
              await waitFor(() => store.getRun(runId)?.status !== 'waiting');
              statuses.length = 0;
              await waitFor(() => !manager.isActive(runId) || statuses.includes('waiting'));
              expect(statuses).not.toContain('waiting');
              expect(store.getRun(runId)?.status).toBe('done');
              expect(store.getRun(runId)?.steps[0]?.status).toBe('done');
              expect(hasPendingAsk(store, runId)).toBe(false);
            } finally {
              store.off('run', recordStatus);
            }
            const events = store.readEvents(runId);
            expect(events.filter(event => event.type === 'ask.requested')).toHaveLength(1);
            // The parent's answer is its conversation reply, never a human message.
            expect(events.filter(event => event.type === 'user-message')).toEqual([]);
            expect(events.filter(event => event.type === 'human-input-delivered')).toEqual([expect.objectContaining({ source: 'parent' })]);
          });
        }, 45_000);
      }
    }
  });

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

function cleanupToMcpGroups(r: HarnessRegistrar): void {
  const { describeRunners, runners, it, parityRow, permissionExemption } = r;
  // #661: native runner completion precedes the real durable cleanup checkpoint.
  // Every adapter supplies baseline; there is no wire exemption for this path.
  describeRunners('cleanup', 'harness parity — terminal cleanup reconciliation', () => {
    for (const backend of runners) {
      it(`${backend} R20 cleanup checkpoints read only their family`, async () => {
        await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, repoRoot }) => {
          manager.enqueueOwnedRun(runId);
          await waitFor(() => store.getRun(runId)?.status === 'waiting');
          expect(manager.finish(runId)).toBe(true);
          await waitFor(() => !manager.isActive(runId) && store.readWorkerExecution(runId)?.phase === 'complete');
          const unrelated = seedSettledFamily(store, repoRoot);
          const reads = vi.spyOn(store, 'readEvents');
          try {
            cleanupCheckpoint(store, runId);
            expect(store.readWorkerExecution(runId)?.phase).toBe('complete');
            expect(reads.mock.calls.map(([id]) => id)).not.toContain(unrelated.parentId);
            expect(reads.mock.calls.map(([id]) => id)).not.toContain(unrelated.workerId);
          } finally { reads.mockRestore(); }
        });
      }, 60_000);
    }
  });

  // #473: successful settlement closes intermediate Continues left by idle close.
  describeRunners('multi-continue', 'harness parity — multi-Continue settlement', () => {
    for (const backend of runners) {
      for (const status of ['done', 'review', 'cancelled'] as const) {
        const criterion = status === 'done' ? 'R28' : status === 'review' ? 'R29' : 'R30';
        it(`${backend} ${criterion} closes every live step when multi-Continue finishes as ${status}`, async () => {
          vi.stubEnv('CEZ_REVIEW_GATE', status === 'review' ? '1' : '0');
          try {
            await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
              async ({ store, manager, runId, repoRoot, idle }) => {
                for (let turn = 0; turn < 2; turn++) {
                  await idle.advance(IDLE_TIMEOUT_MS);
                  await waitFor(() => !manager.isActive(runId));
                  // Idle close remains a park, not successful task completion.
                  expect(store.getRun(runId)?.status).toBe('waiting');
                  expect(store.getRun(runId)?.steps.every(step => step.status === 'waiting' && !step.finishedAt)).toBe(true);
                  expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
                  await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                }
                const before = store.getRun(runId)!;
                expect(before.steps.map(step => step.id)).toEqual(['task', 'continue-1', 'continue-2']);
                // driveRun uses an in-place repository; expose that real diff to the gate.
                store.updateRun(runId, { worktreePath: repoRoot, baseBranch: 'main' });
                writeFileSync(join(repoRoot, 'a.txt'), 'changed for review\n');
                if (status === 'cancelled') {
                  let release!: (diff: string) => void;
                  const diff = vi.spyOn(gitWorktree, 'worktreeDiff').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
                  try {
                    expect(manager.finish(runId)).toBe(true);
                    await waitFor(() => release !== undefined);
                    expect(manager.cancel(runId)).toBe(true);
                  } finally {
                    release?.('changed');
                    diff.mockRestore();
                  }
                } else expect(manager.finish(runId)).toBe(true);
                await waitFor(() => !manager.isActive(runId));
                const completed = store.getRun(runId)!;
                expect(completed.status).toBe(status);
                expect(completed.steps.map(step => step.status)).toEqual(['done', status === 'cancelled' ? 'cancelled' : 'done', 'done']);
                for (const step of completed.steps) expect(step.finishedAt).toBeDefined();
                expect(completed.currentStepId).toBeUndefined();
              });
          } finally { vi.unstubAllEnvs(); }
        }, 60_000);
      }
    }
  });

  describeRunners('superseded', 'harness parity — inactive Finish superseded by Continue', () => {
    for (const backend of runners) {
      for (const queued of [false, true]) {
        const criterion = queued ? 'R34' : 'R33';
        it(`${backend} ${criterion} rejects stale Finish after Continue ${queued ? 'queues' : 'starts and idle-closes'}`, async () => {
          await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
            async ({ store, manager, runId, repoRoot, idle, semaphore }) => {
              const idleClose = async () => {
                await idle.advance(IDLE_TIMEOUT_MS);
                await waitFor(() => !manager.isActive(runId));
                expect(store.getRun(runId)?.status).toBe('waiting');
              };
              await idleClose();
              store.updateRun(runId, { worktreePath: repoRoot, baseBranch: 'main' });
              let release: ((diff: string) => void) | undefined;
              const diff = vi.spyOn(gitWorktree, 'worktreeDiff').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
              // Observe the real fire-and-forget settlement, including its config I/O.
              const settlement = observeSettlements(manager);
              // Hold only scheduler capacity; the run and its idle close use native wires.
              const capacity = queued ? vi.spyOn(semaphore, 'busy').mockReturnValue(Number.MAX_SAFE_INTEGER) : undefined;
              try {
                expect(manager.finish(runId)).toBe(true);
                await waitFor(() => release !== undefined);
                expect(settlement.pending).toHaveLength(1);
                const pending = settlement.pending[0]!;
                expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }, queued).ok).toBe(true);
                if (!queued) {
                  await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                  await idleClose();
                }
                expect(fixtureWork(manager).liveSessions.size).toBe(0);
                const before = structuredClone(store.getRun(runId)!);
                expect(before.status).toBe(queued ? 'queued' : 'waiting');
                expect(before.steps.at(-1)).toMatchObject({ id: 'continue-1', status: queued ? 'pending' : 'waiting' });
                release!('changed');
                await pending;
                const after = store.getRun(runId)!;
                expect(after.status).toBe(before.status);
                expect(after.steps).toEqual(before.steps);
                expect(after.finishedAt).toBeUndefined();
                expect(store.readEvents(runId).some(event => event.type === 'lifecycle' &&
                  (event.message === 'run finished' || (typeof event.message === 'string' && event.message.startsWith('changes ready for review'))))).toBe(false);
              } finally {
                release?.('changed');
                await Promise.allSettled(settlement.pending);
                diff.mockRestore();
                settlement.restore();
                // Cancel queued work before restoring capacity so teardown cannot launch it.
                manager.cancel(runId);
                capacity?.mockRestore();
              }
            });
        }, 60_000);
      }
    }
  });

  describeRunners('disposal', 'harness parity — accepted Finish across disposal', () => {
    for (const backend of runners) {
      for (const continuation of [false, true]) {
        const criterion = continuation ? 'R32' : 'R31';
        it(`${backend} ${criterion} honors ${continuation ? 'Continue' : 'fresh'} Finish when disposed during diff I/O`, async () => {
          vi.stubEnv('CEZ_REVIEW_GATE', '0');
          try {
            await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
              async ({ store, manager, runId, repoRoot, idle }) => {
                if (continuation) {
                  await idle.advance(IDLE_TIMEOUT_MS);
                  await waitFor(() => !manager.isActive(runId));
                  expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
                  await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                }
                store.updateRun(runId, { worktreePath: repoRoot, baseBranch: 'main' });
                let release: ((diff: string) => void) | undefined;
                const diff = vi.spyOn(gitWorktree, 'worktreeDiff').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
                // dispose clears active immediately. Observe actual engine cleanup,
                // so assertions and fixture deletion wait for the settlement callback.
                const settlement = observeSettlements(manager);
                try {
                  expect(manager.finish(runId)).toBe(true);
                  await waitFor(() => release !== undefined);
                  manager.dispose();
                  release!('changed');
                  expect(settlement.pending).toHaveLength(1);
                  await Promise.all(settlement.pending);
                  const completed = store.getRun(runId)!;
                  expect(completed.status).toBe('done');
                  expect(completed.finishedAt).toBeDefined();
                  expect(completed.currentStepId).toBeUndefined();
                  expect(completed.steps).toHaveLength(continuation ? 2 : 1);
                  for (const step of completed.steps) expect(step).toMatchObject({ status: STEP_STATUS.done, finishedAt: expect.any(String) });
                } finally {
                  release?.('changed');
                  diff.mockRestore();
                  settlement.restore();
                }
              });
          } finally { vi.unstubAllEnvs(); }
        }, 60_000);
      }
    }
  });

  // #515: task scratch outlives a process, on both workflow and Continue paths.
  describeRunners('scratch', 'harness parity — live task scratch', () => {
    for (const backend of runners) {
      it(`${backend} R22 retains scratch across idle close and Continue, then reaps on finish`, async () => {
        await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
          async ({ store, manager, runId, repoRoot, idle }) => {
            const original = resolveAgentTmpDir(join(repoRoot, '.ai/cezar'), runId);
            const dirs = new Set([agentTmpDir(join(repoRoot, '.ai/cezar'), runId), original]);
            const nextRoot = mkdtempSync(join(realpathSync('/tmp'), 'cez-next-'));
            const keys = ['TMPDIR', 'TEMP', 'TMP'] as const;
            const previous = keys.map(key => process.env[key]);
            try {
              for (const key of keys) process.env[key] = nextRoot;
              for (const dir of dirs) {
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, 'notes'), 'keep across turns');
              }
              for (let turn = 0; turn < 2; turn++) {
                await idle.advance(IDLE_TIMEOUT_MS);
                await waitFor(() => !manager.isActive(runId));
                expect(store.getRun(runId)?.status).toBe('waiting');
                for (const dir of dirs) expect(readFileSync(join(dir, 'notes'), 'utf8')).toBe('keep across turns');
                expect(resolveAgentTmpDir(join(repoRoot, '.ai/cezar'), runId)).toBe(original);
                expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
                await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                for (const dir of dirs) expect(readFileSync(join(dir, 'notes'), 'utf8')).toBe('keep across turns');
              }
              expect(manager.finish(runId)).toBe(true);
              await waitFor(() => !manager.isActive(runId));
              expect(['done', 'review']).toContain(store.getRun(runId)?.status);
              for (const dir of dirs) expect(existsSync(dir)).toBe(false);
            } finally {
              keys.forEach((key, index) => {
                if (previous[index] === undefined) delete process.env[key];
                else process.env[key] = previous[index];
              });
              rmSync(nextRoot, { recursive: true, force: true });
            }
          });
      }, 60_000);

      parityRow(backend, {
        id: 'R23', scenario: 'ask', name: 'R23 retains pending-question worker scratch after its process completes',
        assert(observation: { active: boolean; status: string | undefined; phase: string | undefined; scratch: string }) {
          expect(observation.active).toBe(false);
          expect(observation.status).toBe(RUN_STATUS.waiting);
          expect(observation.phase).toBe('complete');
          expect(observation.scratch).toBe('pending answer');
        },
      }, async () => {
        const idle = observationClock(delay => delay === IDLE_TIMEOUT_MS && /armIdleTimer/.test(new Error().stack ?? ''));
        let observation!: { active: boolean; status: string | undefined; phase: string | undefined; scratch: string };
        try {
          await withOwnedInputRun(backend, 'ask', async ({ manager, store, runId, repoRoot }) => {
            manager.enqueueOwnedRun(runId);
            // bound: the public native or portable ask frame identifies the parked question.
            await waitFor(() => store.readEvents(runId).some(event => event.type === 'ask.requested'));
            const scratch = resolveAgentTmpDir(join(repoRoot, '.ai/cezar'), runId);
            writeFileSync(join(scratch, 'notes'), 'pending answer');
            const nativeAsk = exemptionFor('R23', backend);
            if (nativeAsk) {
              expect(nativeAsk.kind).toBe('capability-absent');
              expect(idle.pending).toBe(0);
            } else {
              // bound: the portable ask's completed turn arms its shipped idle timer.
              await waitFor(() => idle.pending > 0);
            }
            await idle.advance(IDLE_TIMEOUT_MS);
            if (nativeAsk) {
              expect(manager.isActive(runId)).toBe(true);
              expect(store.getRun(runId)?.status).toBe(RUN_STATUS.waiting);
              expect(store.readWorkerExecution(runId)?.phase).not.toBe('complete');
            } else {
              // bound: idle expiry closes the owned process and releases its active run.
              await waitFor(() => !manager.isActive(runId));
            }
            observation = { active: manager.isActive(runId), status: store.getRun(runId)?.status,
              phase: store.readWorkerExecution(runId)?.phase, scratch: readFileSync(join(scratch, 'notes'), 'utf8') };
          });
          return observation;
        } finally { idle.restore(); }
      });
    }
  });

  // #399 incident: issue Agent context, run 3a3c1ffa (original history unavailable).
  // Prompt delivery is the contract under test; these offline wires cannot prove
  // that a live model follows the instruction. Markerless output must still wait.
  // hearsay-tools/cezarion#1234: every runner honors cezarTools, so every session here is taught
  // the lifecycle tools instead of the markers.
  describeRunners('monitoring', 'harness parity — monitoring wrap-up contract (#399)', () => {
    const promptRules = [
      'When the goal is fully achieved and verified and you have no question for the user, call cezar_done, then end your turn.',
      'call cezar_wait with kind "pr" for a pull request\'s checks or its merge, or kind "timer" to re-check later, then end your turn.',
    ];
    type Wire = {
      userText?: string; method?: string; url?: string; prompt?: string;
      params?: { input?: { text?: string }[]; prompt?: { text?: string }[] };
      body?: { parts?: { text?: string }[] };
    };
    const records = (path: string) => readMockRecords<Wire | string[]>(path);
    // Print carries its combined prompt on stdin; Claude/Pi/OMP keep the system prompt in argv.
    const stdinWire = (backend: RunnerId) => backend === 'claude' || backend === 'pi' || backend === 'omp';
    const stdinRowText = (row: Wire): string[] => row.userText === undefined ? [] : [row.userText];
    const cursorCombinedRowText = (backend: RunnerId, row: string[]): string[] =>
      backend === 'cursor' && row.at(-1)?.includes('\n\n---\n\n') ? [row.at(-1)!] : [];
    // The per-backend prompt carrier: Codex turn input, Cursor session prompts, OpenCode body parts.
    const providerRowParts = (backend: RunnerId, row: Wire) =>
      backend === 'codex' && row.method === 'turn/start' ? row.params?.input
        : backend === 'cursor' && row.method === 'session/prompt' ? row.params?.prompt
        : backend === 'opencode' && /\/(message|prompt_async)$/.test(row.url ?? '') ? row.body?.parts : undefined;
    const joinRowParts = (parts: { text?: string }[]): string => parts.map(part => part.text ?? '').join('\n');
    const messages = (backend: RunnerId, dir: string): string[] => {
      const channel = stdinWire(backend) ? 'stdin' : 'args';
      const wire = backend === 'cursor' ? [...records(join(dir, 'args')), ...records(join(dir, 'stdin'))]
        : records(join(dir, channel));
      return wire.flatMap(row => {
        if (Array.isArray(row)) return cursorCombinedRowText(backend, row);
        if (stdinWire(backend)) return stdinRowText(row);
        if (backend === 'cursor' && row.method === 'cursor-print/stdin' && row.prompt !== undefined) return [row.prompt];
        const parts = providerRowParts(backend, row);
        return parts ? [joinRowParts(parts)] : [];
      });
    };
    const systemPrompt = (backend: RunnerId, dir: string): string => {
      if (!stdinWire(backend)) return messages(backend, dir)[0] ?? '';
      const argv = records(join(dir, 'args')).find(Array.isArray) ?? [];
      const index = argv.indexOf('--append-system-prompt');
      expect(index).toBeGreaterThanOrEqual(0);
      return argv[index + 1] ?? '';
    };
    const assertRules = (text: string, rules: readonly string[]) => {
      for (const rule of rules) expect(text).toContain(rule);
      expect(text).not.toContain('CEZ:MONITORING');
    };
    const recording = async (body: (dir: string) => Promise<void>) => {
      const dir = mkdtempSync(join(tmpdir(), 'cez-monitoring-prompt-'));
      vi.stubEnv('CEZ_MOCK_ARGS_FILE', join(dir, 'args'));
      vi.stubEnv('CEZ_MOCK_STDIN_FILE', join(dir, 'stdin'));
      try { await body(dir); }
      finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
    };
    const clearRecording = (dir: string) => {
      for (const channel of ['args', 'stdin']) writeFileSync(join(dir, channel), '');
    };

    for (const backend of runners) {
      for (const continued of [false, true]) {
        it(`${backend} ${continued ? 'R37 Continue' : 'R36 fresh'} receives the shared monitoring wrap-up contract`, async () => {
          await recording(async dir => {
            await driveObservedRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
              async ({ store, manager, runId, idle }) => {
                if (continued) {
                  await idle.advance(IDLE_TIMEOUT_MS);
                  await waitFor(() => !manager.isActive(runId));
                  clearRecording(dir);
                  expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
                  await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                }
                assertRules(systemPrompt(backend, dir), promptRules);
                expect(systemPrompt(backend, dir)).toContain('When a user decision or missing input is needed, call cezar_ask');
              });
          });
        }, 60_000);
      }

      it(`${backend} R38 restart recovery receives the shared monitoring wrap-up contract`, async () => {
        await recording(async dir => {
          await withOwnedInputRun(backend, 'cezar-wait', async fixture => {
            fixture.manager.enqueueOwnedRun(fixture.runId);
            await waitFor(() => fixture.store.getRun(fixture.runId)?.status === 'waiting' && !!timerWakeOf(fixture.store.getRun(fixture.runId)));
            clearRecording(dir);
            const wakeClock = observationClock(() => /WaitEngine\.armWait/.test(new Error().stack ?? ''));
            const { manager } = await fixture.restart();
            // hearsay-tools/cezarion#1233: recovery re-arms the park's persisted monitoring timer
            // instead of resuming at once; its wake starts the recovered session.
            expect(wakeClock.pending).toBe(1);
            wakeClock.fire(0);
            await waitFor(() => manager.isActive(fixture.runId) && messages(backend, dir).length > 0);
            assertRules(systemPrompt(backend, dir), promptRules);
          });
        });
      }, 60_000);

      // A cezar_wait timer's wake reaches each native message channel as its result text with the
      // next-step instruction, never as a user message (hearsay-tools/cezarion#2397: the marker
      // monitoring park this cell drove is gone; MONITORING_WAKE_NUDGE now answers only Claude's
      // ScheduleWakeup and the live-workers timer).
      it(`${backend} R39 a timer wake delivers its result and next-step instruction on the native message channel`, async () => {
        await recording(async dir => {
          const wakeClock = observationClock(() => /WaitEngine\.armWait/.test(new Error().stack ?? ''));
          await driveRun(backend, 'cezar-wait', record => record?.status === 'waiting' && !!timerWakeOf(record), 30_000,
            async ({ store, runId }) => {
              const waitId = openTimerWait(store.getRun(runId))!.id;
              expect(wakeClock.pending).toBe(1);
              wakeClock.fire(0);
              await waitFor(() => messages(backend, dir).length > 1);
              const wake = messages(backend, dir)[1]!;
              expect(wake).toContain(`Timer ${waitId} fired: Re-check the downstream work.`);
              expect(wake).toContain('Continue toward the task goal; register another wait if you are still waiting.');
              expect(store.readEvents(runId).some(event => event.type === 'user-message')).toBe(false);
            });
        });
      }, 60_000);

      it(`${backend} R40 completion prose without a marker still parks waiting`, async () => {
        await driveRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
          async ({ store, manager, runId }) => {
            const prose = 'The PR merged. No further monitoring is needed. Everything is complete.';
            expect(manager.sendMessage(runId, [{ type: 'text', text: `mock:agent-echo ${prose}` }])).toBe(true);
            await waitFor(() => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes(prose)));
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            expect(manager.isActive(runId)).toBe(true);
          });
      }, 60_000);
    }
  });

  // hearsay-tools/cezarion#922: every task-owned declaration, through each native runner wire.
  describeRunners('prs', 'harness parity — multi-pr collection', () => {
    for (const backend of runners) {
      for (const continuation of [false, true]) {
        it(`${backend} ${continuation ? 'PR2' : 'PR1'} multi-pr retains fresh and continued declarations`, async () => {
          let dataDir = '';
          const observed = await driveRun(backend, 'multi-pr-refs', record => record?.status === 'done', 60_000,
            async ({ store, manager, runId }) => {
              expect(store.getRun(runId)?.pullRequests?.map(pr => pr.number)).toEqual([812, 813, 814, 815, 816]);
              expect(store.getRun(runId)?.markerRefs?.pr).toBe(816);
              if (continuation) {
                await waitFor(() => !manager.isActive(runId));
                expect(manager.continueRun(runId, { text: 'mock:multi-pr-refs-continue' }).ok).toBe(true);
                await waitFor(() => !manager.isActive(runId) && store.getRun(runId)?.status === 'done', 60_000);
                expect(store.getRun(runId)?.markerRefs?.pr).toBe(817);
              }
              store.flush();
              expect(readPersistedRuns(dataDir).find(run => run.id === runId)?.pullRequests?.map((pr: NonNullable<RunRecord['pullRequests']>[number]) => pr.number))
                .toEqual(continuation ? [812, 813, 814, 815, 816, 817] : [812, 813, 814, 815, 816]);
            }, { beforeStart: ({ repoRoot }) => { dataDir = join(repoRoot, '.ai/cezar'); } });
          expect(observed.record?.pullRequests?.some(pr => pr.number === 999)).toBe(false);
        }, 150_000);
      }
    }
  });

  describeRunners('permission', 'native permission routing (hearsay-tools/cezarion#1049)', () => {
    for (const backend of runners) {
      const exemption = exemptionFor('P1', backend);
      if (exemption) {
        it(`${backend} P1 exemption — ${exemption.reason}`, () => {
          expect(exemption.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].scenarios.approval).toBeUndefined();
        });
        continue;
      }
      for (const { pick: decision, echo } of HARNESS_ADAPTERS[backend].approvalDecisions!) {
        it(`${backend} P1 ${decision} answers the native request through the cockpit API`, async () => {
          let repoRoot = '';
          const observation = await driveRun(backend, 'approval', run => !!run && ['done', 'review'].includes(run.status), 30_000, async ({ store, manager, runId }) => {
            // Continue builds ActiveRun at a second site. Old capabilities must stay
            // retired while a fresh native approval parks the resumed generation.
            const first = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
            await waitFor(() => !manager.isActive(runId));
            expect(manager.continueRun(runId, { text: 'mock:approval' })).toEqual({ ok: true });
            await waitFor(() => store.readEvents(runId).filter(event => event.type === 'permission.requested').length === 2);
            const request = store.readEvents(runId).filter(event => event.type === 'permission.requested')[1]!;
            expect(request.requestId).not.toBe(first.requestId);
            expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
            const old = (first.options as Array<{ id: string }>)[0]!;
            expect(manager.respondPermission(runId, first.requestId as string, old.id)).toBe(false);
            const choice = (request.options as Array<{ id: string; label: string }>).find(option => option.label.toLowerCase().includes(decision))!;
            expect(manager.respondPermission(runId, request.requestId as string, choice.id)).toBe(true);
            await waitFor(() => ['done', 'review'].includes(store.getRun(runId)?.status ?? '') && !manager.isActive(runId));
          }, {
            autonomous: true,
            beforeStart: context => { repoRoot = context.repoRoot; },
            during: async ({ store, manager, runId }) => {
              await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
              expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
              const request = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
              const options = request.options as Array<{ id: string; label: string }>;
              const choice = options.find(option => option.label.toLowerCase().includes(decision));
              expect(choice).toBeDefined();
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
              expect(manager.respondPermission(runId, request.requestId as string, 'not-offered')).toBe(false);
              const app = createApp({ home: testHome(), repoRoot, store, manager, version: 'test' });
              const response = await apiRequest(app, `/api/v1/runs/${runId}/permissions`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ requestId: request.requestId, optionId: choice!.id }),
              });
              expect(response.status).toBe(200);
              expect(await response.json()).toEqual({ delivered: true });
              expect(manager.respondPermission(runId, request.requestId as string, choice!.id)).toBe(false);
            },
          });
          expect(observation.events).toContainEqual(expect.objectContaining({ type: 'permission.resolved', optionId: expect.any(String) }));
          expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
          expect(observation.events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain(echo);
          expect(observation.record?.hasPendingPermission).toBe(false);
          expect(observation.events.some(event => event.type === 'ask.requested')).toBe(false);
        }, 45_000);
      }
    }
  });

  describeRunners('default-permission', 'default permission asks (hearsay-tools/cezarion#1266)', () => {
    for (const backend of runners) {
      const exemption = exemptionFor('P2', backend);
      if (exemption) {
        it(`${backend} P2 exemption — ${exemption.reason}`, () => {
          expect(exemption.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].scenarios['permission-default']).toBeUndefined();
        });
        continue;
      }
      it(`${backend} P2 answers its built-in default permission ask without parking`, async () => {
        const observation = await driveRun(backend, 'permission-default', run => !!run && ['done', 'review'].includes(run.status), 30_000);
        expect(observation.events.some(event => event.type === 'permission.requested')).toBe(false);
        expect(observation.record?.hasPendingPermission).toBeFalsy();
        expect(observation.events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain('Approval response: {"reply":"once"}');
        expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
      }, 45_000);
    }
  });

  for (const { id, scenario, text } of RETIREMENTS) {
    describeRunners(`retirement-${id}`, `${id} ${PERMISSION_CRITERIA.find(c => c.id === id)!.name} (hearsay-tools/cezarion#1266)`, () => {
      for (const backend of runners) {
        if (permissionExemption(id, backend, scenario)) continue;
        it(`${backend} ${id} retires the card, its capability and the run's pending permission`, async () => {
          await withRelease(async (release) => {
            let requestId = '';
            // P4's agent calls cezar_done while the request is still pending, and a pending request
            // refuses it (human_question_pending), so its run parks once the turn end retires the card.
            const settled = (run: RunObservation['record']) => !!run && (['done', 'review'].includes(run.status) ||
              (id === 'P4' && run.status === RUN_STATUS.waiting && run.hasPendingPermission === false));
            // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
            const observation = await driveRun(backend, scenario, settled, 30_000, undefined, {
              env: { CEZ_MOCK_RELEASE_FILE: release },
              during: async ({ store, manager, runId }) => {
                await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
                const request = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
                requestId = request.requestId as string;
                expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
                expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
                writeFileSync(release, 'go');
                await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.resolved' && event.requestId === requestId));
                // The retired card answers nothing, whether or not the run has moved on yet.
                expect(manager.respondPermission(runId, requestId, (request.options as Array<{ id: string }>)[0]!.id)).toBe(false);
              },
            });
            const resolutions = permissionResolutionsOf(observation.events);
            expect(resolutions).toEqual([expect.objectContaining({ requestId, reason: expect.any(String) })]);
            expect(resolutions[0]).not.toHaveProperty('optionId');
            expect(observation.record?.hasPendingPermission).toBe(false);
            expect(joinedText(observation.events)).toContain(text);
            expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
          });
        // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
        }, 45_000);
      }
    });
  }

  describeRunners('permission-failure', `P5 ${PERMISSION_CRITERIA.find(c => c.id === 'P5')!.name} (hearsay-tools/cezarion#1266)`, () => {
    for (const backend of runners) {
      if (permissionExemption('P5', backend, 'approval-reply-fails')) continue;
      it(`${backend} P5 replaces the card it could not deliver and keeps the run waiting`, async () => {
        let repoRoot = '';
        const { pick, echo } = HARNESS_ADAPTERS[backend].approvalDecisions![0]!;
        let freshId = '';
        // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
        const observation = await driveRun(backend, 'approval-reply-fails', run => !!run && ['done', 'review'].includes(run.status), 30_000, undefined, {
          beforeStart: context => { repoRoot = context.repoRoot; },
          during: async ({ store, manager, runId }) => {
            const requests = () => store.readEvents(runId).filter(event => event.type === 'permission.requested');
            await waitFor(() => requests().length === 1);
            const first = requests()[0]!;
            const firstChoice = optionPicked(first, pick);
            // From the refused answer to the replacement card, the run never stops waiting on a card.
            const changes: Array<{ status: string; hasPendingPermission?: boolean | undefined }> = [];
            const recordChange = (record: RunRecord) => {
              if (record.id === runId) changes.push({ status: record.status, hasPendingPermission: record.hasPendingPermission });
            };
            store.on('run', recordChange);
            try {
              const response = await answerThroughRoute(repoRoot, store, manager, runId, first, firstChoice.id);
              expect(response.status).toBe(200);
              expect(await response.json()).toEqual({ delivered: true });
              await waitFor(() => requests().length === 2 &&
                store.readEvents(runId).some(event => event.type === 'permission.resolved' && event.requestId === first.requestId));
            } finally { store.off('run', recordChange); }
            for (const change of changes) expect(change).toEqual({ status: RUN_STATUS.waiting, hasPendingPermission: true });
            const events = store.readEvents(runId);
            const fresh = requests()[1]!;
            freshId = fresh.requestId as string;
            expect(freshId).not.toBe(first.requestId);
            const oldResolution = events.findIndex(event => event.type === 'permission.resolved' && event.requestId === first.requestId);
            expect(events.findIndex(event => event.type === 'permission.requested' && event.requestId === freshId)).toBeLessThan(oldResolution);
            expect(events[oldResolution]).toMatchObject({ reason: expect.any(String) });
            expect(events[oldResolution]).not.toHaveProperty('optionId');
            expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
            expect(manager.respondPermission(runId, first.requestId as string, firstChoice.id)).toBe(false);
            expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
            const retry = await answerThroughRoute(repoRoot, store, manager, runId, fresh, optionPicked(fresh, pick).id);
            expect(retry.status).toBe(200);
          },
        });
        expect(permissionResolutionsOf(observation.events).filter(event => event.optionId !== undefined))
          .toEqual([expect.objectContaining({ requestId: freshId, optionId: expect.any(String) })]);
        expect(observation.record?.hasPendingPermission).toBe(false);
        expect(joinedText(observation.events)).toContain(echo);
        expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
      // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
      }, 45_000);
    }
  });

  describeRunners('malformed', `P6 ${PERMISSION_CRITERIA.find(c => c.id === 'P6')!.name} (hearsay-tools/cezarion#1266)`, () => {
    for (const backend of runners) {
      if (permissionExemption('P6', backend, 'approval-malformed')) continue;
      it(`${backend} P6 refuses the malformed request natively and the turn goes on`, async () => {
        // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
        const observation = await driveRun(backend, 'approval-malformed', run => !!run && ['done', 'review'].includes(run.status), 30_000);
        expect(observation.events.some(event => event.type === 'permission.requested')).toBe(false);
        expect(observation.record?.hasPendingPermission).toBeFalsy();
        expect(observation.statuses).not.toContain('waiting');
        expect(joinedText(observation.events)).toContain(HARNESS_ADAPTERS[backend].malformedApprovalEcho!);
        expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
      // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
      }, 45_000);
    }
  });

  describeRunners('early-permission', `P7 ${PERMISSION_CRITERIA.find(c => c.id === 'P7')!.name} (hearsay-tools/cezarion#1266)`, () => {
    for (const backend of runners) {
      if (permissionExemption('P7', backend, 'permission-classify')) continue;
      // Agent input reaches a session only through `sendAgentMessage`, so the cell drives the seam.
      it(`${backend} P7 refuses agent input before the card and drops the request settled meanwhile`, async () => {
        await withRelease(async (release) => {
          const argsFile = `${release}.args.ndjson`;
          let inputReady = 0;
          const observation = await driveSeam(backend, 'permission-classify', {
            spec: { env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_RELEASE_FILE: release } },
            sessionOptions: { onAgentInputReady: () => { inputReady += 1; } },
            whileOpen: async (session, observed) => {
              await waitFor(() => existsSync(`${release}.config-read`));
              expect(session.sendAgentMessage([{ type: 'text', text: 'steer' }])).toBe(false);
              const before = inputReady;
              writeFileSync(`${release}.settle`, 'go');
              // SSE frames are handled in order: the text after the native reply proves it was read.
              await waitFor(() => observed.v2.some(event => JSON.stringify(event).includes('OpenCode settled the ask itself.')));
              await waitFor(() => inputReady > before);
              writeFileSync(release, 'go');
              await waitFor(() => observed.v2.some(event => event.type === 'permission.requested'));
              const requests = observed.v2.filter((event): event is PermissionRequestedEvent => event.type === 'permission.requested');
              expect(requests).toHaveLength(1);
              expect(JSON.parse(requests[0]!.details!)).toMatchObject({ patterns: ['marker'] });
              const allow = requests[0]!.options.find(option => option.label.toLowerCase().includes('allow once'))!;
              expect(session.respondPermission!(requests[0]!.requestId, allow.id)).toBe(true);
              await waitFor(() => observed.v1.some(event => event.type === 'turn-end'));
            },
          });
          expect(observation.failure).toBeUndefined();
          const urls = readMockRecords<{ url?: string }>(argsFile).map(row => row.url);
          expect(urls).not.toContain('/permission/per_mock_classify/reply');
          expect(urls).toContain('/permission/per_mock_marker/reply');
        });
      // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
      }, 45_000);
    }
  });

  describeRunners('late-permission', `P8 ${PERMISSION_CRITERIA.find(c => c.id === 'P8')!.name} (hearsay-tools/cezarion#1266)`, () => {
    for (const backend of runners) {
      if (permissionExemption('P8', backend, 'permission-late')) continue;
      // A session's own close (autoEndAfterFirstTurn) lives at the seam.
      it(`${backend} P8 reopens the turn for the late card and ends the session after that turn`, async () => {
        const observation = await driveSeam(backend, 'permission-late', {
          sessionOptions: { autoEndAfterFirstTurn: true },
          whileOpen: async (session, observed) => {
            const turnEnds = () => observed.v1.filter(event => event.type === 'turn-end').length;
            await waitFor(() => observed.v2.some(event => event.type === 'permission.requested'));
            expect(turnEnds()).toBe(1);
            const started = observed.v2.flatMap((event, index) => event.type === 'turn.started' ? [index] : []);
            expect(started).toHaveLength(2);
            expect(observed.v2.findIndex(event => event.type === 'turn.completed')).toBeLessThan(started[1]!);
            expect(started[1]!).toBeLessThan(observed.v2.findIndex(event => event.type === 'permission.requested'));
            expect(session.open).toBe(true);
            const request = observed.v2.find((event): event is PermissionRequestedEvent => event.type === 'permission.requested')!;
            const allow = request.options.find(option => option.label.toLowerCase().includes('allow once'))!;
            expect(session.respondPermission!(request.requestId, allow.id)).toBe(true);
            await waitFor(() => !session.open);
            expect(turnEnds()).toBe(2);
          },
        });
        expect(observation.failure).toBeUndefined();
        expect(observation.v2.filter(event => event.type === 'permission.resolved'))
          .toEqual([expect.objectContaining({ optionId: expect.any(String) })]);
        expect(observation.v2.filter(event => event.type === 'turn.completed')).toHaveLength(2);
        expect(textEvents(observation.v1).join('\n')).toContain('Approval response: {"reply":"once"}');
      // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
      }, 45_000);

      // Through RunManager a step's done closes its session at once (hearsay-tools/cezarion#1620),
      // as a final step's done already did: the late card never pends and the next step runs.
      it(`${backend} P8 completes a non-final step on its done before a late card can pend`, async () => {
        const workflowDef: WorkflowDef = {
          name: 'permission-late', source: 'built-in',
          steps: [{ id: 'first', name: 'First', prompt: '{{task}}' }, { id: 'second', name: 'Second', prompt: promptFor(backend, 'cezar-done') }],
        };
        // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
        const observation = await driveRun(backend, 'permission-late', run => !!run && ['done', 'review', 'waiting'].includes(run.status), 30_000, undefined, { workflowDef });
        expect(observation.record?.status).toBe('done');
        expect(observation.record?.hasPendingPermission).toBeFalsy();
        expect(observation.record?.steps.map(step => [step.id, step.status])).toEqual([['first', 'done'], ['second', 'done']]);
      // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
      }, 45_000);
    }
  });

  // cezar's own tools are covered where they run: the Codex U1 row of workflows/waits-parity parks only
  // when the mock's MCP tool gate lets cezar_wait through unasked.
  describeRunners('mcp', 'MCP tool approval routing (hearsay-tools/cezarion#1294)', () => {
    for (const backend of runners) {
      const exemption = exemptionFor('P9', backend);
      if (exemption) {
        it(`${backend} P9 exemption — ${exemption.reason}`, () => {
          expect(exemption.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].scenarios['mcp-approval']).toBeUndefined();
        });
        continue;
      }
      for (const [label, action] of [['Allow once', 'accept'], ['Decline and continue', 'decline']] as const) {
        it(`${backend} P9 ${action} answers another server's MCP tool approval through the cockpit API`, async () => {
          let repoRoot = '';
          // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
          const observation = await driveRun(backend, 'mcp-approval', run => !!run && ['done', 'review'].includes(run.status), 30_000, undefined, {
            beforeStart: context => { repoRoot = context.repoRoot; },
            during: async ({ store, manager, runId }) => {
              await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
              expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
              const request = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
              expect(request.title).toBe('Codex requests an MCP tool call');
              const choice = (request.options as Array<{ id: string; label: string }>).find(option => option.label === label)!;
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
              const response = await answerThroughRoute(repoRoot, store, manager, runId, request, choice.id);
              expect(response.status).toBe(200);
              expect(await response.json()).toEqual({ delivered: true });
            },
          });
          expect(observation.events).toContainEqual(expect.objectContaining({ type: 'permission.resolved', optionId: expect.any(String) }));
          expect(observation.events.filter(event => event.type === 'text').map(event => event.text).join(''))
            .toContain(`Approval response: ${JSON.stringify({ action, content: null, _meta: null })}`);
          expect(observation.record?.hasPendingPermission).toBe(false);
        // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
        }, 45_000);
      }
    }
  });
}

/** Every group and once-only block, in the order the once file and the dry collections register them. */
const HARNESS_PARITY_ORDER: readonly HarnessGroup[] = [
  CONTRACT_GROUPS.contract, STARTUP_GROUPS.startup, SESSION_GROUPS.seam, SESSION_GROUPS['tool-grants'], SESSION_GROUPS.input,
  diagnosticsToStopGroups, SESSION_GROUPS.session, PROVIDER_GROUPS.provider, runToOwnedWorkflowsGroups, opencodeDurableInput,
  matrixGuards, SESSION_GROUPS.governed, opencodeRestrictedSessions, SESSION_GROUPS['native-message'], SESSION_GROUPS.spec,
  SESSION_GROUPS.tools, SESSION_GROUPS.cdp, cleanupToMcpGroups,
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
