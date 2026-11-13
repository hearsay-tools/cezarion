import { partitionParity, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { autoEndObservationClock, observationClock } from './observation-clock.testkit.ts';
import { AUTO_END_DELAY_MS } from './runner-runtime.ts';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { RunRecord } from '@open-mercato/cezar-contract';
import type { RunManager } from '../workflows/run.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { promptFor, STEP_COMPLETION_CRITERIA, waitFor } from './harness-parity.testkit.ts';
import { driveRun } from './workflow-parity.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { IDLE_TIMEOUT_MS, NO_WAIT_NOTE, NO_WAIT_NUDGE_NOTE } from '../workflows/run.ts';
import { AUTONOMOUS_NUDGE, NO_WAIT_NUDGE, STEP_NUDGE_SUFFIX } from '../workflows/turn-end.ts';
import { workflowDefSchema } from '../workflows/types.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../workflows/fixture-cleanup.testkit.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';

// hearsay-tools/cezarion#1620: an earlier workflow step completes only on an accepted completion
// signal, on every runner's native wire. Its last agent step signals done; a check step ends the chain.
const PARTS: Readonly<Record<string, readonly string[]>> = {
  "markers": [
    "claude C1",
    "cursor C1",
    "omp C1"
  ],
  "clean-close": [
    "claude C3",
    "cursor C3",
    "omp C3"
  ],
  "idle-close": [
    "claude C4",
    "cursor C4",
    "omp C4"
  ],
  "recovery": [
    "claude C5",
    "cursor C5",
    "omp C5"
  ],
  "autonomous": [
    "claude C6",
    "cursor C6",
    "omp C6"
  ]
};

export function describeWorkflowStepCompletionParity(part: ParityPart, collect?: ParityCollector): void {
  const { describe, it } = partitionParity(part, PARTS, collect, 'workflow-step-completion');
describe('explicit step completion parity — hearsay-tools/cezarion#1620', () => {
  for (const backend of RUNNER_IDS) for (const row of STEP_COMPLETION_CRITERIA) {
    it(`${backend} ${row.id} ${row.name}`, async () => {
      const workflowDef = workflowDefSchema.parse({ name: 'completion-chain', source: 'file', steps: [
        { id: 'implement', prompt: '{{task}}' },
        { id: 'review', prompt: promptFor(backend, 'cezar-done') },
        { id: 'verify', command: 'test -f a.txt' },
      ] });
      const parked = (run: RunRecord | undefined) => run?.status === 'waiting' &&
        (run.waits ?? []).some(wait => wait.kind === 'human' && wait.source === 'cezar');
      const finished = (run: RunRecord | undefined) => ['done', 'review', 'failed'].includes(run?.status ?? '');
      // The text Squawk submits to the session: an earlier step's nudge names the step.
      const submitted: string[] = [];
      let repoRoot = '';
      let idleClock: ReturnType<typeof observationClock>;
      let closeClock: ReturnType<typeof autoEndObservationClock>;
      const observe = ({ manager, repoRoot: root }: { manager: RunManager; repoRoot: string }) => {
        repoRoot = root;
        idleClock = observationClock(delay => delay === IDLE_TIMEOUT_MS && /armIdleTimer/.test(new Error().stack ?? ''));
        closeClock = autoEndObservationClock();
        const work = fixtureWork(manager);
        const trackSession = work.trackSession.bind(work);
        vi.spyOn(work, 'trackSession').mockImplementation((session, closed) => {
          const submit = session.sendAgentMessage.bind(session);
          vi.spyOn(session, 'sendAgentMessage').mockImplementation((content, ids) => {
            for (const block of content) if (block.type === 'text') submitted.push(block.text);
            return submit(content, ids);
          });
          return trackSession(session, closed);
        });
      };
      const nudged = (nudge: string) => {
        expect(submitted.length).toBeGreaterThan(0);
        return submitted.some(text => text.startsWith(nudge) && text.includes(STEP_NUDGE_SUFFIX));
      };
      await driveRun(backend, row.scenario, run => parked(run) || finished(run), 20_000, async (fixture) => {
        let { manager, store } = fixture;
        const { runId } = fixture;
        const run = () => store.getRun(runId)!;
        // The workflow's own steps; a Continue adds a synthetic step beside them.
        const statuses = () => run().steps.filter(step => workflowDef.steps.some(def => def.id === step.id)).map(step => [step.id, step.status]);
        const notes = (message: string) => store.readEvents(runId).filter(event => event.type === 'note' && String(event.message).startsWith(message));
        const complete = async () => {
          await waitFor(() => finished(run()) && !manager.isActive(runId), 15_000);
          expect(run().status).toBe('done');
          expect(statuses()).toEqual([['implement', 'done'], ['review', 'done'], ['verify', 'done']]);
          expect(store.readEvents(runId).filter(event => event.type === 'check-output')).toMatchObject([{ stepId: 'verify', exitCode: 0 }]);
        };
        // The session closed without done: the step stays resumable and the tail never starts.
        const incomplete = async () => {
          await waitFor(() => !manager.isActive(runId));
          expect(run().status).toBe('waiting');
          expect(statuses()).toEqual([['implement', 'waiting'], ['review', 'pending'], ['verify', 'pending']]);
        };
        if (row.id === 'C6') {
          await complete();
          expect(nudged(AUTONOMOUS_NUDGE)).toBe(true);
          return;
        }
        // A quiet earlier turn end takes the final step's path: one nudge, then Squawk's human wait.
        expect(parked(run())).toBe(true);
        expect(notes(NO_WAIT_NUDGE_NOTE)).toHaveLength(1);
        expect(notes(NO_WAIT_NOTE)).toHaveLength(1);
        expect(nudged(NO_WAIT_NUDGE)).toBe(true);
        expect(statuses()).toEqual([['implement', 'waiting'], ['review', 'pending'], ['verify', 'pending']]);
        const session = [...fixtureWork(manager).liveSessions][0]!;
        // The session stays open for the user past the runners' one-shot-close window.
        await closeClock.advance(AUTO_END_DELAY_MS + 100);
        expect(session.open).toBe(true);
        if (row.id === 'C1') {
          expect(manager.sendMessage(runId, [{ type: 'text', text: 'Carry on. mock:cezar-done' }])).toBe(true);
          await complete();
          return;
        }
        if (row.id === 'C3') {
          session.end();
          await incomplete();
          expect(manager.continueRun(runId, { text: 'Carry on. mock:cezar-done' }).ok).toBe(true);
          await complete();
          return;
        }
        if (row.id === 'C4') {
          await idleClock.advance(IDLE_TIMEOUT_MS);
          await incomplete();
          // A Continue whose turn signals nothing parks on the same step; only done advances it.
          expect(manager.continueRun(runId, { text: 'Carry on.' }).ok).toBe(true);
          await waitFor(() => manager.isActive(runId) && parked(run()), 15_000);
          expect(run().steps.find(step => step.id === 'review')?.status).toBe('pending');
          expect(manager.sendMessage(runId, [{ type: 'text', text: 'Carry on. mock:cezar-done' }])).toBe(true);
          await complete();
          return;
        }
        // C5: a restart keeps the parked earlier step, and a Continue with done runs the tail.
        store.flush();
        const dataDir = join(repoRoot, '.ai/cezar');
        const checkpoint = readPersistedRuns(dataDir);
        await drainFixtureManagers(repoRoot);
        store.close();
        seedRuns(dataDir, checkpoint);
        store = RunStore.open(dataDir, { keepLive: true });
        manager = createFixtureManager(store, repoRoot);
        await manager.recover();
        expect(run().status).toBe('waiting');
        expect(statuses()).toEqual([['implement', 'waiting'], ['review', 'pending'], ['verify', 'pending']]);
        expect(manager.isActive(runId)).toBe(false);
        expect(manager.continueRun(runId, { text: 'Carry on. mock:cezar-done' }).ok).toBe(true);
        await complete();
      }, { workflowDef, autonomous: row.id === 'C6', beforeStart: observe, beforeCleanup: () => { idleClock?.restore(); closeClock?.restore(); vi.restoreAllMocks(); } });
    }, 60_000);
  }
});

}
