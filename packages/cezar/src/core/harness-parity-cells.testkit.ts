import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeImports } from './module-imports.testkit.ts';
import { readMockRecords } from '../mock-records.testkit.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';
import { MONITORING_TURN_CRITERIA, MONITORING_ACK_CRITERIA, MONITORING_ORDER_CRITERIA } from '../workflows/monitoring-turn.testkit.ts';
import { monitoringTurnFiles } from '../workflows/monitoring-turn-partitions.testkit.ts';
import { WAIT_CRITERIA } from '../workflows/waits-parity.testkit.ts';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { exemptionReasonProblem } from './exemption-reason.testkit.ts';
import { driveSeam, exemptionFor, promptFor, HARNESS_ADAPTERS, SHUTDOWN_CRITERIA, MODEL_REFUSAL_CRITERIA, PERMISSION_CRITERIA, WORKFLOW_TIMEOUT_CRITERIA, NO_PROGRESS_CRITERIA, AUTONOMOUS_CRITERIA, FINAL_MESSAGE_CRITERIA, WORKER_PROGRESS_WAIT_CRITERIA, WORKFLOW_ASK_CRITERIA, STEP_COMPLETION_CRITERIA, FOLLOWUP_CRITERIA, ANSWER_DELIVERY_CRITERIA, SKILL_RESUME_CRITERIA, SKILL_PROVISION_CRITERIA, WORKTREE_SETUP_CRITERIA, PARITY_EXEMPTIONS, PINNED_SESSION_ID, seedOpencodeMockSession, type ScenarioName, waitFor } from './harness-parity-core.testkit.ts';
import { HARNESS_PARITY_GROUPS, harnessParityCellsFile, harnessParityFile, type HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessGroups, vitestRegistration, type HarnessGroup, type HarnessParityScope, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { CONTROL_CRITERIA } from './harness-parity-rows.testkit.ts';
import { RUN_CRITERIA } from './harness-parity-run-tier.testkit.ts';
import { SEAM_CRITERIA } from './harness-parity-seam-tier.testkit.ts';
import { parityRowId } from './parity-classes.testkit.ts';
import { SEAM_CONTRACT_ROWS } from './seam-contract.testkit.ts';
import { TOOL_GRANT_CASES } from './tool-grant-parity-cells.testkit.ts';
import { withOwnedInputRun, withoutTaskScenario } from './workflow-parity-core.testkit.ts';
import { CONTRACT_GROUPS, describeHarnessParity as describeContractParity } from './harness-parity-contract.cells.testkit.ts';
import { describeHarnessParity as describeOwnedInputParity, OWNED_INPUT_GROUPS, agentInput } from './harness-parity-owned-input.cells.testkit.ts';
import { describeHarnessParity as describeOwnedWorkflowsParity, OWNED_WORKFLOWS_GROUPS } from './harness-parity-owned-workflows.cells.testkit.ts';
import { describeHarnessParity as describeOwnershipParity, OWNERSHIP_GROUPS } from './harness-parity-ownership.cells.testkit.ts';
import { describeHarnessParity as describeProviderParity, PROVIDER_GROUPS } from './harness-parity-provider.cells.testkit.ts';
import { describeHarnessParity as describeRunParity, RUN_GROUPS } from './harness-parity-run.cells.testkit.ts';
import { describeHarnessParity as describeSessionParity, FOLLOW_ON_CRITERION, INPUT_CRITERIA, SESSION_GROUPS } from './harness-parity-session.cells.testkit.ts';
import { describeHarnessParity as describeSettlementParity, SETTLEMENT_GROUPS } from './harness-parity-settlement.cells.testkit.ts';
import { describeHarnessParity as describeStartupParity, STARTUP_GROUPS } from './harness-parity-startup.cells.testkit.ts';
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
 * Each part's cells live in `harness-parity-<part>.cells.testkit.ts`; the seam and run tier
 * tables they share live in `harness-parity-seam-tier.testkit.ts` and
 * `harness-parity-run-tier.testkit.ts`, and `harness-parity-registrar.testkit.ts` registers them.
 * Each `harness-<runner>-<part>-parity.test.ts` imports only its part's module, so an edit behind
 * one part reruns only that part's files (hearsay-tools/cezarion#1288, hearsay-tools/cezarion#3242).
 * This module joins every part: `harness-parity.test.ts` runs the matrix guard and the
 * single-runner cells through it, and the guards read every part's registrations.
 */

/** One request the OpenCode serve mock recorded in `CEZ_MOCK_ARGS_FILE`. */
type OpencodeRequestRow = { method?: string; url?: string; body?: { permission?: unknown } };

export { HARNESS_PARITY_GROUPS, harnessParityFile, type HarnessParityPart };

/** Every module that defines harness parity cells, for the prose and skipped-cell guards. */
const HARNESS_PARITY_KITS = ['harness-parity-cells.testkit.ts', 'harness-parity-registrar.testkit.ts', 'harness-parity-parts.testkit.ts',
  'harness-parity-seam-tier.testkit.ts', 'harness-parity-run-tier.testkit.ts',
  ...(Object.keys(HARNESS_PARITY_GROUPS) as HarnessParityPart[]).map(harnessParityCellsFile)];

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

function opencodeDurableInput(r: HarnessRegistrar): void {
  const { it, describe, scope } = r;
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
  const { it, describe, scope, registeredGroups } = r;
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
          'packages/cezar/src/core/harness-parity.test.ts', ...HARNESS_PARITY_KITS.map(kit => `packages/cezar/src/core/${kit}`),
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
          // Each part file loads only its own part's cells (hearsay-tools/cezarion#3242).
          expect(source, file).toContain(`import { describeHarnessParity } from './${harnessParityCellsFile(part)}';`);
          expect(runtimeImports(source, file).filter(specifier => /^\.\/harness-parity-(?:[a-z-]+\.)?cells\.testkit\.ts$/.test(specifier)), file)
            .toEqual([`./${harnessParityCellsFile(part)}`]);
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
        for (const url of [...HARNESS_PARITY_KITS.map(kit => new URL(`./${kit}`, import.meta.url)), new URL('../workflows/worker-parent-attention.testkit.ts', import.meta.url), ...['monitoring-turn-rows.testkit.ts', 'monitoring-turn-partitions.testkit.ts', 'monitoring-turn-coverage.test.ts', ...monitoringTurnFiles].map(file => new URL(`../workflows/${file}`, import.meta.url)), new URL('./skill-resume-parity.testkit.ts', import.meta.url)]) {
          const source = readFileSync(url, 'utf8');
          expect(source).not.toMatch(/\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(/);
        }
      });
    });
  }
}

function opencodeRestrictedSessions(r: HarnessRegistrar): void {
  const { it, describe, scope } = r;
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
  RUN_GROUPS.answer, OWNED_INPUT_GROUPS.owned, OWNED_WORKFLOWS_GROUPS['owned-workflows'], opencodeDurableInput, matrixGuards,
  SESSION_GROUPS.governed, opencodeRestrictedSessions, SESSION_GROUPS['native-message'], SESSION_GROUPS.spec, SESSION_GROUPS.tools,
  SESSION_GROUPS.cdp, SETTLEMENT_GROUPS.cleanup, SETTLEMENT_GROUPS['multi-continue'], SETTLEMENT_GROUPS.superseded,
  SETTLEMENT_GROUPS.disposal, SETTLEMENT_GROUPS.scratch, RUN_GROUPS.monitoring, RUN_GROUPS.prs, SETTLEMENT_GROUPS.permission,
  SETTLEMENT_GROUPS['default-permission'], SETTLEMENT_GROUPS.retirements, SETTLEMENT_GROUPS['permission-failure'],
  SETTLEMENT_GROUPS.malformed, SETTLEMENT_GROUPS['early-permission'], SETTLEMENT_GROUPS['late-permission'], SETTLEMENT_GROUPS.mcp,
];

/** Each part's own `describeHarnessParity`, the one its runner files call. */
const HARNESS_PARITY_PARTS: Readonly<Record<HarnessParityPart, (scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration) => void>> = {
  contract: describeContractParity, startup: describeStartupParity, session: describeSessionParity, provider: describeProviderParity,
  run: describeRunParity, ownership: describeOwnershipParity, 'owned-input': describeOwnedInputParity,
  'owned-workflows': describeOwnedWorkflowsParity, settlement: describeSettlementParity,
};

/** Every part at once: the once file's guards and single-runner cells, or a dry collection. */
export function describeHarnessParity(scope: HarnessParityScope, registration: HarnessRegistration = vitestRegistration()): void {
  describeHarnessGroups(scope, registration, HARNESS_PARITY_ORDER, TOOL_GRANT_CASES.length);
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

/** Collect the real row registrations without starting their hooks or test bodies. */
export function harnessParityRegistrations(runner: RunnerId, part?: HarnessParityPart): string[] {
  const names: string[] = [];
  const registration: HarnessRegistration = {
    describe: ((_name: string, body: () => void) => body()) as typeof describe,
    it: ((name: string) => { names.push(name); }) as typeof it,
    beforeAll: (() => undefined) as typeof beforeAll,
    afterAll: (() => undefined) as typeof afterAll,
    toolGrants: () => { for (const entry of TOOL_GRANT_CASES) names.push(`${runner} tool grant ${entry.id}`); },
    allGroups: part === undefined,
  };
  // A part goes through its own module, so a group that module lacks is missing from its routes.
  if (part) HARNESS_PARITY_PARTS[part]({ runner, part }, registration);
  else describeHarnessParity({ runner, part: 'session' }, registration);
  return names;
}
