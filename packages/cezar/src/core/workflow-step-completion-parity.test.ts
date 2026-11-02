import { runInternals } from '../workflows/run-internals.testkit.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@open-mercato/cezar-contract';
import type { RunManager } from '../workflows/run.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { driveRun, promptFor, STEP_COMPLETION_CRITERIA, waitFor } from './harness-parity.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { NO_WAIT_NOTE, NO_WAIT_NUDGE_NOTE } from '../workflows/run.ts';
import { AUTONOMOUS_NUDGE, NO_WAIT_NUDGE, STEP_NUDGE_SUFFIX } from '../workflows/turn-end.ts';
import { workflowDefSchema } from '../workflows/types.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-cleanup.testkit.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';

// hearsay-tools/cezarion#1620: an earlier workflow step completes only on an accepted completion
// signal, on every runner's native wire. Its last agent step signals done; a check step ends the chain.
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
      // The text Cezar submits to the session: an earlier step's nudge names the step.
      const submitted: string[] = [];
      let intercepted: ReturnType<typeof vi.fn>;
      const observe = ({ manager }: { manager: RunManager }) => {
        const engine = runInternals(manager).inputDelivery;
        const submit = engine.submitAgentInput.bind(engine);
        engine.submitAgentInput = intercepted = vi.fn((runId, state, content) => {
          for (const block of content) if (block.type === 'text') submitted.push(block.text);
          return submit(runId, state, content);
        });
      };
      const nudged = (nudge: string) => {
        expect(intercepted).toHaveBeenCalled();
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
        if (row.id === 'C2' || row.id === 'C6') {
          await complete();
          if (row.id === 'C2') expect(notes(NO_WAIT_NUDGE_NOTE)).toEqual([]);
          else expect(nudged(AUTONOMOUS_NUDGE)).toBe(true);
          return;
        }
        // A quiet earlier turn end takes the final step's path: one nudge, then Cezar's human wait.
        expect(parked(run())).toBe(true);
        expect(notes(NO_WAIT_NUDGE_NOTE)).toHaveLength(1);
        expect(notes(NO_WAIT_NOTE)).toHaveLength(1);
        expect(nudged(NO_WAIT_NUDGE)).toBe(true);
        expect(statuses()).toEqual([['implement', 'waiting'], ['review', 'pending'], ['verify', 'pending']]);
        const session = manager['active'].get(runId)!.session!;
        // The session stays open for the user past the runners' one-shot-close window.
        await new Promise(resolve => setTimeout(resolve, 350)); // bound: observe past the 250 ms runner auto-end timer
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
          const timer = manager['active'].get(runId)!.idleTimer! as NodeJS.Timeout & { _onTimeout: () => void };
          const expire = timer._onTimeout;
          clearTimeout(timer);
          expire();
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
        const repoRoot = manager['repoRoot'];
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
      }, { workflowDef, autonomous: row.id === 'C6', beforeStart: observe });
    }, 60_000);
  }
});
