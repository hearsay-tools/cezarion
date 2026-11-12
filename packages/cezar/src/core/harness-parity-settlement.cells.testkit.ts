import type { RunnerId } from './agent-runner.ts';
import type { HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessPart, type HarnessGroup, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import * as gitWorktree from '../git-worktree.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { readMockRecords } from '../mock-records.testkit.ts';
import { agentTmpDir, resolveAgentTmpDir } from '../runs/agent-tmpdir.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createApp } from '../server/server.ts';
import { cleanupCheckpoint, seedSettledFamily } from '../workflows/delegation-reconcile.testkit.ts';
import { fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { IDLE_TIMEOUT_MS, type RunManager } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { driveSeam, exemptionFor, HARNESS_ADAPTERS, PERMISSION_CRITERIA, promptFor, textEvents, waitFor } from './harness-parity-core.testkit.ts';
import { driveObservedRun } from './harness-parity-run-tier.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';
import type { UiEvent } from './ui-events.ts';
import { driveRun, withOwnedInputRun, type RunObservation } from './workflow-parity-core.testkit.ts';

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

export const SETTLEMENT_GROUPS = {
  // #661: native runner completion precedes the real durable cleanup checkpoint.
  // Every adapter supplies baseline; there is no wire exemption for this path.
  cleanup(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
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
  },

  // #473: successful settlement closes intermediate Continues left by idle close.
  'multi-continue'(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
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
  },

  superseded(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
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
  },

  disposal(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
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
  },

  // #515: task scratch outlives a process, on both workflow and Continue paths.
  scratch(r: HarnessRegistrar) {
    const { describeRunners, runners, it, parityRow } = r;
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
  },

  permission(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
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
  },

  'default-permission'(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
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
  },

  retirements(r: HarnessRegistrar) {
    const { describeRunners, runners, it, permissionExemption } = r;
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
  },

  'permission-failure'(r: HarnessRegistrar) {
    const { describeRunners, runners, it, permissionExemption } = r;
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
  },

  malformed(r: HarnessRegistrar) {
    const { describeRunners, runners, it, permissionExemption } = r;
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
  },

  'early-permission'(r: HarnessRegistrar) {
    const { describeRunners, runners, it, permissionExemption } = r;
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
  },

  'late-permission'(r: HarnessRegistrar) {
    const { describeRunners, runners, it, permissionExemption } = r;
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
  },

  // Squawk's own tools are covered where they run: the Codex U1 row of workflows/waits-parity parks only
  // when the mock's MCP tool gate lets cezar_wait through unasked.
  mcp(r: HarnessRegistrar) {
    const { describeRunners, runners, it } = r;
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
  },
} satisfies Readonly<Record<string, HarnessGroup>>;

/** Register the settlement part's cells for one runner: `harness-<runner>-settlement-parity.test.ts`. */
export function describeHarnessParity(scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration): void {
  describeHarnessPart('settlement', SETTLEMENT_GROUPS, scope, registration);
}
