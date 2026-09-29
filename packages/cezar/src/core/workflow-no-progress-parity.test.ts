import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { NO_PROGRESS_CRITERIA, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';
import { workflowDefSchema } from '../workflows/types.ts';

vi.mock('./runner-runtime.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./runner-runtime.ts')>(),
  DEFAULT_NO_PROGRESS_TIMEOUT_MS: 800,
  KILL_GRACE_MS: 150,
}));

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe('managed open-turn inactivity — #470', () => {
  for (const backend of RUNNER_IDS) {
    for (const row of NO_PROGRESS_CRITERIA) {
      it(`${backend} ${row.id} ${row.name}`, async () => {
        const workflowDef = row.id === 'N1' || row.id === 'N2' || row.id === 'N5' || row.id === 'N7'
          ? workflowDefSchema.parse({ name: 'inactivity', source: 'file', steps: [
            { id: 'work', prompt: '{{task}}' }, { id: 'check', command: 'true' },
          ] }) : undefined;
        await withOwnedInputRun(backend, row.scenario, async ({ store, manager, runId, parentRunId }) => {
          manager.enqueueOwnedRun(runId);
          if (row.id === 'N3' || row.id === 'N4' || row.id === 'N6' || row.id === 'N8') {
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            await sleep(1_600);
            expect(store.getRun(runId)?.status).toBe('waiting');
            expect(manager.isActive(runId)).toBe(true);
            if (row.id === 'N6') {
              expect(store.readEvents(runId).some(e => e.type === 'ask.requested')).toBe(true);
              const turns = store.readEvents(runId).filter(e => e.type === 'turn.completed').length;
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'Vitest' }])).toBe(true);
              await waitFor(() => store.readEvents(runId).filter(e => e.type === 'turn.completed').length > turns && store.getRun(runId)?.status === 'waiting');
              manager.finish(runId);
              await waitFor(() => !manager.isActive(runId));
              expect(store.getRun(runId)?.error).toBeUndefined();
              return;
            }
            if (row.id === 'N8') {
              expect(manager.steerWorker(runId, { id: randomUUID(), source: 'agent', parentRunId, text: 'mock:no-progress-ack-only', createdAt: new Date().toISOString() })).toBe('queued');
              await waitFor(() => store.getRun(runId)?.agentInputs?.[0]?.deliveredAt !== undefined);
            } else if (row.id === 'N4') {
              manager.finish(runId);
              await waitFor(() => !manager.isActive(runId));
              expect(manager.continueRun(runId, { text: 'mock:no-progress' }).ok).toBe(true);
            } else {
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:no-progress' }])).toBe(true);
            }
          }
          // Let the real native wire and process exit settle; no synthetic turn events.
          if (row.id === 'N5' || row.id === 'N7') {
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'error' && typeof e.message === 'string' && e.message.includes('no progress')));
            const pid = Number(readFileSync(join(store.getRun(runId)!.worktreePath!, 'watchdog.pid'), 'utf8'));
            if (row.id === 'N5') {
              expect(() => process.kill(pid, 0)).not.toThrow();
              expect(manager.isActive(runId)).toBe(true);
            }
            await waitFor(() => !manager.isActive(runId), row.id === 'N7' ? 2_500 : 8_000);
            expect(() => process.kill(pid, 0)).toThrow();
          } else await waitFor(() => !manager.isActive(runId));
          expect(manager.isActive(runId)).toBe(false);
          const run = store.getRun(runId)!;
          if (row.id === 'N2') {
            expect(run.error).toBeUndefined();
            expect(run.steps.map(s => s.status)).toEqual(['done', 'done']);
          } else {
            expect(run.status).toBe('failed');
            expect(run.error).toContain('no progress');
            expect(store.readEvents(runId).some(e => e.type === 'check-output')).toBe(false);
          }
        }, { workflowDef });
      }, 30_000);
    }
  }
});
