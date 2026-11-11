import type { RunnerId } from './agent-runner.ts';
import type { HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessPart, type HarnessGroup, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { crashStore, readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../workflows/fixture-manager.testkit.ts';
import { promptFor, waitFor } from './harness-parity-core.testkit.ts';
import { driveObservedRun, TERMINAL } from './harness-parity-run-tier.testkit.ts';
import { driveRun, type RunObservation } from './workflow-parity-core.testkit.ts';

/** Flush until `runId` has left the store's memory; false if it never does. */
async function leavesMemory(store: RunStore, runId: string): Promise<boolean> {
  try {
    await waitFor(() => { store.flush(); return !store.heldIds().includes(runId); }, 10_000);
    return true;
  } catch {
    return false;
  }
}

export const OWNERSHIP_GROUPS = {
  // #779: only the live set is in memory. A finished run is read back from runs.db; Continue loads
  // it into the held set (the `continue` pin), `runContinuation` pins it through the same `activate`
  // helper `execute` uses, and it leaves memory again once the continuation settles.
  continue(r: HarnessRegistrar) {
    const { describeRunners, runners, parityRow } = r;
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
  },

  // #779: older controllers could cancel a root and leave its Finish intent on the record. Restart
  // repairs that in the delegation sweep, which since #779 reaches only what `open` loads; a finished
  // root the sweep missed would be refused by every Continue ("parent finish is pending") for good.
  restart(r: HarnessRegistrar) {
    const { describeRunners, runners, parityRow } = r;
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
  },

  // #779 plan step 3: `serve` and a headless `cez run` open one runs.db. A headless open (no
  // keepLive) settled every live row as interrupted and saved it, so the owner's parked run — whose
  // row only the owner's whole-file saves used to put back — loaded `failed` at the next restart and
  // its question could no longer be answered there. A run another live process claims is left alone.
  owner(r: HarnessRegistrar) {
    const { describeRunners, runners, parityRow } = r;
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
  },

  // #779 plan step 3: a control (archive, Stop, Continue…) on a run whose owning process died adopts
  // it first. Adopting settles it — nothing is resumed behind the user's back, whichever runner it
  // used — and Continue is the one control that starts its agent again, on its own session.
  adopt(r: HarnessRegistrar) {
    const { describeRunners, runners, parityRow } = r;
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
  },

  // #779: Stop is the control an adoption carries out itself. The run it stops ends cancelled, as an
  // accepted Stop always reads, rather than interrupted, whichever runner it used; nothing starts.
  stop(r: HarnessRegistrar) {
    const { describeRunners, runners, parityRow } = r;
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
  },
} satisfies Readonly<Record<string, HarnessGroup>>;

/** Register the ownership part's cells for one runner: `harness-<runner>-ownership-parity.test.ts`. */
export function describeHarnessParity(scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration): void {
  describeHarnessPart('ownership', OWNERSHIP_GROUPS, scope, registration);
}
