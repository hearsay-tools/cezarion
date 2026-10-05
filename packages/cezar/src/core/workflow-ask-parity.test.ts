import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { driveRun, promptFor, waitFor, WORKFLOW_ASK_CRITERIA } from './harness-parity.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { workflowDefSchema } from '../workflows/types.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-cleanup.testkit.ts';
import { readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';

describe('intermediate workflow ASK parity — #427', () => {
  for (const backend of RUNNER_IDS) for (const row of WORKFLOW_ASK_CRITERIA) {
    const modes = row.id === 'Q7' ? ['fresh', 'continuation'] : ['fresh'];
    for (const mode of modes) it(`${backend} ${row.id} ${row.name} (${mode})`, async () => {
      const workflowDef = workflowDefSchema.parse({ name: 'question-chain', source: 'file', steps: [
        { id: 'implement', prompt: '{{task}}', ...(row.id === 'Q8' ? { timeoutMs: 2_000 } : {}) },
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
          if (row.id === 'Q2' || row.id === 'Q9') {
            await complete();
            expect(events().filter(e => e.type === 'ask.requested')).toHaveLength(0);
            expect(events().some(e => e.type === 'note' && (row.id === 'Q2'
              ? e.stepId === 'implement' && e.tone === 'danger' && /CEZ:ASK.*JSON/.test(String(e.message))
              : String(e.message).includes('question overridden')))).toBe(true);
            return;
          }
          expect(run().status).toBe('waiting');
          expect(run().steps.map(s => s.status)).toEqual(row.id === 'Q3' ? ['waiting'] : ['waiting', 'pending']);
          expect(events().filter(e => e.type === 'ask.requested')).toMatchObject([
            { stepId: 'implement', questions: [{ question: 'Which test library?' }] },
          ]);
          expect(checks()).toEqual([]);
          const session = manager['active'].get(runId)!.session!;
          // Cross the runners' 250ms one-shot-close window before answering.
          await new Promise(resolve => setTimeout(resolve, 350));
          if (row.id !== 'Q8') expect(session.open).toBe(true);
          expect(manager['busySlots']()).toBe(0);

          if (row.id === 'Q5') {
            const repoRoot = manager['repoRoot'];
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
            expect(manager.continueRun(runId, { text: 'Vitest. mock:done' }).ok).toBe(true);
            await complete();
            return;
          }
          if (row.id === 'Q6') {
            manager.cancel(runId);
            await waitFor(() => !manager.isActive(runId));
            expect(run().status).toBe('cancelled');
          } else if (row.id === 'Q8') {
            await waitFor(() => !manager.isActive(runId));
            expect(run().status).toBe('failed');
            expect(run().error).toContain('timed out');
            expect(run().steps[0]?.status).toBe('failed');
          } else {
            if (row.id === 'Q4' || row.id === 'Q10' || mode === 'continuation') {
              if (row.id === 'Q10') session.end();
              else {
                const timer = manager['active'].get(runId)!.idleTimer! as NodeJS.Timeout & { _onTimeout: () => void };
                const expire = timer._onTimeout;
                clearTimeout(timer);
                expire();
              }
              await waitFor(() => !manager.isActive(runId));
              expect(run().status).toBe('waiting');
              expect(run().steps.map(s => s.status)).toEqual(['waiting', 'pending']);
              expect(manager.continueRun(runId, { text: promptFor(backend, 'ask-snapshot') }).ok).toBe(true);
              await waitFor(() => run().status === 'waiting');
              expect(events().filter(e => e.type === 'ask.requested')).toHaveLength(2);
              if (row.id === 'Q10') {
                // The continuation turn-end path must preserve a second ask
                // if that reopened process also closes before its answer.
                manager['active'].get(runId)!.session!.end();
                await waitFor(() => !manager.isActive(runId));
                expect(run().status).toBe('waiting');
                expect(run().steps.map(s => s.status)).toEqual(['waiting', 'pending', 'waiting']);
                expect(manager.continueRun(runId, { text: 'Vitest. mock:done' }).ok).toBe(true);
                await complete();
                return;
              }
            }
            if (row.id === 'Q7') {
              expect(manager.finish(runId)).toBe(true);
              await waitFor(() => !manager.isActive(runId));
              expect(run().status).toBe('done');
            } else {
              if (row.id === 'Q1') expect(manager['active'].get(runId)?.session).toBe(session);
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'Vitest. mock:done' }])).toBe(true);
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
          expect(manager['busySlots']()).toBe(0);
        }, { workflowDef, autonomous: row.id === 'Q9' });
    }, 30_000);
  }
});
