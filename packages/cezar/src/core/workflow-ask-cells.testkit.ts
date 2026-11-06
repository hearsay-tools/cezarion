import { testHome } from '../home/test-home.testkit.ts';
import { autoEndObservationClock, observationClock } from './observation-clock.testkit.ts';
import { AUTO_END_DELAY_MS } from './runner-runtime.ts';
import { IDLE_TIMEOUT_MS } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { CEZAR_ASK_QUESTION, driveRun, promptFor, waitFor, WORKFLOW_ASK_CRITERIA } from './harness-parity.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { workflowDefSchema } from '../workflows/types.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../workflows/fixture-cleanup.testkit.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';

const STEP_TIMEOUT_MS = 2_000;

/** Keep the authored deadline independent of native-process startup and expire it after the ask. */
function holdStepDeadline() {
  const now = Date.now;
  // OMP computes its remaining delay from Date; fix the clock only until that timer is armed.
  const startupClock = vi.spyOn(Date, 'now').mockReturnValue(now());
  const schedule = globalThis.setTimeout;
  const deadlines: Array<() => void> = [];
  const clock = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    // bound: the test's 30 s guard owns a hang; this deadline is released explicitly below.
    const timer = schedule(callback, delay === STEP_TIMEOUT_MS ? 2_147_483_647 : delay, ...args);
    if (delay === STEP_TIMEOUT_MS) {
      startupClock.mockRestore();
      deadlines.push(() => { clearTimeout(timer); callback(...args); });
    }
    return timer;
  });
  return () => {
    expect(deadlines).toHaveLength(1);
    clock.mockRestore();
    // Keep elapsed-time guards advancing while the step settles past its deadline.
    vi.spyOn(Date, 'now').mockImplementation(() => now() + STEP_TIMEOUT_MS);
    deadlines[0]!();
  };
}


export const WORKFLOW_ASK_GROUPS = {'answer': ['Q1', 'Q3'], 'continue': ['Q4'], 'clean-close': ['Q10'], 'restart': ['Q5'], 'cancel': ['Q6'], 'finish': ['Q7'], 'timeout': ['Q8'], 'autonomous': ['Q9']} as const;

export function describeWorkflowAsk(group: keyof typeof WORKFLOW_ASK_GROUPS, registration = { describe, it, afterEach }) {
  const { describe, it, afterEach } = registration;
describe('intermediate workflow ASK parity — #427', () => {
  afterEach(() => vi.restoreAllMocks());
  for (const backend of RUNNER_IDS) for (const row of WORKFLOW_ASK_CRITERIA.filter(row => { return (WORKFLOW_ASK_GROUPS[group] as readonly string[]).includes(row.id); })) {
    const modes = row.id === 'Q7' ? ['fresh', 'continuation'] : ['fresh'];
    for (const mode of modes) it(`${backend} ${row.id} ${row.name} (${mode})`, async () => {
      let clock: ReturnType<typeof autoEndObservationClock> | undefined;
      const semaphore = new WorkspaceSemaphore({ home: testHome() });
      let repoRoot = '';
      let idleClock: ReturnType<typeof observationClock> | undefined;
      let expireDeadline: (() => void) | undefined;
      const workflowDef = workflowDefSchema.parse({ name: 'question-chain', source: 'file', steps: [
        { id: 'implement', prompt: '{{task}}', ...(row.id === 'Q8' ? { timeoutMs: STEP_TIMEOUT_MS } : {}) },
        ...(row.id === 'Q3' ? [] : [{ id: 'verify', command: 'test -f a.txt' }]),
      ] });
      await driveRun(backend, row.scenario,
        run => run?.status === 'waiting' || ['done', 'review', 'failed'].includes(run?.status ?? ''),
        15_000, async (fixture) => {
          let { manager, store } = fixture;
          const { runId } = fixture;
          const events = () => store.readEvents(runId);
          const run = () => store.getRun(runId)!;
          const checks = () => events().filter(e => e.type === 'check-output');
          const complete = async () => {
            await waitFor(() => !manager.isActive(runId));
            expect(run().status).toBe('done');
            expect(run().steps.find(s => s.id === 'implement')?.status).toBe('done');
            expect(checks()).toMatchObject([{ stepId: 'verify', exitCode: 0 }]);
          };
          if (row.id === 'Q9') {
            // An autonomous run refuses cezar_ask (`autonomous_run`): the agent is told to assume
            // and continue, no question parks the step, and the tail runs.
            await complete();
            expect(events().filter(e => e.type === 'ask.requested')).toHaveLength(0);
            expect((run().waits ?? []).filter(wait => wait.kind === 'human')).toEqual([]);
            expect(events().some(e => e.type === 'text' && String(e.text).includes('This is an autonomous run: do not wait for the user.'))).toBe(true);
            return;
          }
          expect(run().status).toBe('waiting');
          expect(run().steps.map(s => s.status)).toEqual(row.id === 'Q3' ? ['waiting'] : ['waiting', 'pending']);
          expect(events().filter(e => e.type === 'ask.requested')).toMatchObject([
            { stepId: 'implement', questions: [{ question: CEZAR_ASK_QUESTION }] },
          ]);
          expect(checks()).toEqual([]);
          const session = [...fixtureWork(manager).liveSessions][0]!;
          // The ask is durable before the native turn ends. Reach that boundary first.
          await waitFor(() => events().some(event => event.type === 'turn-end'));
          await Promise.all([...fixtureWork(manager).pending].filter(([, label]) => label === 'recordTurnEnd').map(([work]) => work));
          expect(clock!.captured).toBe(0);
          await clock!.advance(AUTO_END_DELAY_MS + 100);
          expect(clock!.captured).toBe(0);
          if (row.id !== 'Q8') expect(session.open).toBe(true);
          expect(semaphore.busy()).toBe(0);

          if (row.id === 'Q5') {
            store.flush();
            const dataDir = join(repoRoot, '.ai/cezar');
            const checkpoint = readPersistedRuns(dataDir);
            // Preserve the exact disk boundary while stopping test-owned processes.
            await drainFixtureManagers(repoRoot);
            store.close();
            seedRuns(dataDir, checkpoint);
            store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
            manager = createFixtureManager(store, repoRoot);
            await manager.recover();
            expect(run().status).toBe('waiting');
            expect(run().steps.map(s => s.status)).toEqual(['waiting', 'pending']);
            expect(manager.isActive(runId)).toBe(false);
            expect(manager.continueRun(runId, { text: 'Vitest. mock:cezar-done' }).ok).toBe(true);
            await complete();
            return;
          }
          if (row.id === 'Q6') {
            manager.cancel(runId);
            await waitFor(() => !manager.isActive(runId));
            expect(run().status).toBe('cancelled');
          } else if (row.id === 'Q8') {
            expireDeadline!();
            await waitFor(() => !manager.isActive(runId));
            expect(run().status).toBe('failed');
            expect(run().error).toContain('timed out');
            expect(run().steps[0]?.status).toBe('failed');
          } else {
            if (row.id === 'Q4' || row.id === 'Q10' || mode === 'continuation') {
              if (row.id === 'Q10') session.end();
              else {
                await idleClock!.advance(IDLE_TIMEOUT_MS);
              }
              await waitFor(() => !manager.isActive(runId));
              expect(run().status).toBe('waiting');
              expect(run().steps.map(s => s.status)).toEqual(['waiting', 'pending']);
              expect(manager.continueRun(runId, { text: promptFor(backend, 'cezar-ask') }).ok).toBe(true);
              await waitFor(() => run().status === 'waiting');
              expect(events().filter(e => e.type === 'ask.requested')).toHaveLength(2);
              if (row.id === 'Q10') {
                // The continuation turn-end path must preserve a second ask
                // if that reopened process also closes before its answer.
                [...fixtureWork(manager).liveSessions][0]!.end();
                await waitFor(() => !manager.isActive(runId));
                expect(run().status).toBe('waiting');
                expect(run().steps.map(s => s.status)).toEqual(['waiting', 'pending', 'waiting']);
                expect(manager.continueRun(runId, { text: 'Vitest. mock:cezar-done' }).ok).toBe(true);
                await complete();
                return;
              }
            }
            if (row.id === 'Q7') {
              expect(manager.finish(runId)).toBe(true);
              await waitFor(() => !manager.isActive(runId));
              expect(run().status).toBe('done');
            } else {
              if (row.id === 'Q1') expect(fixtureWork(manager).liveSessions.has(session)).toBe(true);
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'Vitest. mock:cezar-done' }])).toBe(true);
              if (row.id === 'Q3') {
                await waitFor(() => !manager.isActive(runId));
                expect(run().status).toBe('done');
                return;
              }
              await complete();
              return;
            }
          }
          expect(run().steps.find(s => s.id === 'verify')?.status).toBe('pending');
          expect(checks()).toEqual([]);
          expect(semaphore.busy()).toBe(0);
        }, { workflowDef, semaphore, autonomous: row.id === 'Q9', beforeCleanup: () => { idleClock?.restore(); clock?.restore(); vi.restoreAllMocks(); }, beforeStart: context => {
          repoRoot = context.repoRoot;
          idleClock = observationClock(delay => delay === IDLE_TIMEOUT_MS && /armIdleTimer/.test(new Error().stack ?? ''));
          if (row.id !== 'Q9') clock = autoEndObservationClock();
          if (row.id === 'Q8') expireDeadline = holdStepDeadline();
        } });
    }, 30_000);
  }
});
}
