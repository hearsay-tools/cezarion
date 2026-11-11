import { STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { workerWorkflowHash, type WorkerAccountBinding, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import { plannedWorkflow, skillTaskSteps, type WorkflowDef } from '../workflows/types.ts';
import { supportsProfiles } from './agent-profiles.ts';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { promptFor, waitFor } from './harness-parity-core.testkit.ts';
import type { HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessPart, probeEnv, readRecording, type HarnessGroup, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { withOwnedInputRun, withSkillParentRun } from './workflow-parity-core.testkit.ts';

export const OWNED_WORKFLOWS_GROUPS = {
  'owned-workflows'(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
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
  },
} satisfies Readonly<Record<string, HarnessGroup>>;

/** Register the owned-workflows part's cells for one runner: `harness-<runner>-owned-workflows-parity.test.ts`. */
export function describeHarnessParity(scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration): void {
  describeHarnessPart('owned-workflows', OWNED_WORKFLOWS_GROUPS, scope, registration);
}
