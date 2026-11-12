import { WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { partitionParity, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { randomUUID } from 'node:crypto';
import { readPid, requirePid } from '../pid-file.testkit.ts';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import * as sessionProcess from './session-process.ts';
import { NO_PROGRESS_CRITERIA, driveSeam, exemptionFor, waitFor } from './harness-parity.testkit.ts';
import { withOwnedInputRun } from './workflow-parity.testkit.ts';
import { workflowDefSchema } from '../workflows/types.ts';


// Keep native startup, IPC, polling and process exit on real time. Only the
// inactivity deadline (and N5's kill escalation) uses the controlled clock.
// Advancing it after watchdog.pid exists cannot spend the fixture's startup
// budget before the mock has reached the stalled turn (hearsay-tools/cezarion#1319).
function controlDeadlines(killEscalation: boolean, onDeadlineArmed?: () => void) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fakeSetTimeout = globalThis.setTimeout;
  const fakeClearTimeout = globalThis.clearTimeout;
  const controlled = new Set<ReturnType<typeof setTimeout>>();
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...params: Parameters<typeof setTimeout>) => {
    const [callback, ms, ...args] = params;
    // Cursor and OpenCode keep their own 4 s kill grace; the other runners
    // use the injected 150 ms grace below.
    if (ms !== 800 && !(killEscalation && (ms === 150 || ms === 4_000))) {
      return realSetTimeout(callback, ms, ...args);
    }
    const timer = fakeSetTimeout(callback, ms, ...args);
    controlled.add(timer);
    if (ms === 800) onDeadlineArmed?.();
    return timer;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(timer => {
    if (controlled.delete(timer as ReturnType<typeof setTimeout>)) fakeClearTimeout(timer);
    else realClearTimeout(timer);
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const PARTS: Readonly<Record<string, readonly string[]>> = {
  "progress": [
    "claude N1",
    "claude N2",
    "codex N1",
    "codex N2",
    "cursor N1",
    "cursor N2",
    "omp N1",
    "omp N2",
    "opencode N1",
    "opencode N2",
    "pi N1",
    "pi N2"
  ],
  "parked-input": [
    "claude N3",
    "claude N6",
    "codex N3",
    "codex N6",
    "cursor N3",
    "cursor N6",
    "omp N3",
    "omp N6",
    "opencode N3",
    "opencode N6",
    "pi N3",
    "pi N6"
  ],
  "continue-steer": [
    "claude N4",
    "claude N8",
    "codex N4",
    "codex N8",
    "cursor N4",
    "cursor N8",
    "omp N4",
    "omp N8",
    "opencode N4",
    "opencode N8",
    "pi N4",
    "pi N8"
  ],
  "process-exit": [
    "claude N5",
    "claude N7",
    "codex N5",
    "codex N7",
    "cursor N5",
    "cursor N7",
    "omp N5",
    "omp N7",
    "opencode N5",
    "opencode N7",
    "pi N5",
    "pi N7"
  ]
};

export function describeWorkflowNoProgressParity(part: ParityPart, collect?: ParityCollector): void {
  const { describe, it } = partitionParity(part, PARTS, collect);
describe('managed open-turn inactivity — #470', () => {
  for (const backend of RUNNER_IDS) {
    for (const row of NO_PROGRESS_CRITERIA) {
      const exemption = exemptionFor(row.id, backend);
      if (exemption) {
        it(`${backend} ${row.id} exemption — ${exemption.reason}`, async () => {
          const observed = await driveSeam(backend, 'no-progress', { timeoutMs: 2_500, spec: { timings: { noProgressTimeoutMs: 800, killGraceMs: 150 } } });
          expect(observed.v2.some(event => event.type === 'turn.started')).toBe(true);
          expect(observed.v1.some(event => event.type === 'error' && /no progress/i.test(event.message))).toBe(true);
        });
        continue;
      }
      it(`${backend} ${row.id} ${row.name}`, async () => {
        const exits = new Map<number, NodeJS.Signals | null>();
        const spawn = sessionProcess.spawnSessionLeader;
        vi.spyOn(sessionProcess, 'spawnSessionLeader').mockImplementation((...args) => {
          const child = spawn(...args);
          child.once('exit', (_code, signal) => { if (child.pid) exits.set(child.pid, signal); });
          return child;
        });
        // N2: each native progress event re-arms the deadline, and only a re-arm moves the
        // controlled clock, 300 ms at a time. The turn outlives several deadlines through its
        // progress alone, while the silent cezar_done call that ends it (an MCP server start,
        // no native frame) spends no controlled time. The other rows exercise expiry only after
        // their native readiness signal.
        let advancing = false;
        let advanced = 0;
        const advanceAfterRearm = () => {
          if (advancing) return;
          advancing = true;
          setImmediate(() => void vi.advanceTimersByTimeAsync(300).then(() => { advanced += 300; advancing = false; }));
        };
        controlDeadlines(row.id === 'N5', row.id === 'N2' ? advanceAfterRearm : undefined);
        const workflowDef = row.id === 'N1' || row.id === 'N2' || row.id === 'N5' || row.id === 'N7'
          ? workflowDefSchema.parse({ name: 'inactivity', source: 'file', steps: [
            { id: 'work', prompt: '{{task}}' }, { id: 'check', command: 'true' },
          ] }) : undefined;
        await withOwnedInputRun(backend, row.scenario, async ({ store, manager, runId, parentRunId, answer }) => {
          manager.enqueueOwnedRun(runId);
          if (row.id === 'N3' || row.id === 'N4' || row.id === 'N6' || row.id === 'N8') {
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            await vi.advanceTimersByTimeAsync(1_600);
            expect(store.getRun(runId)?.status).toBe('waiting');
            expect(manager.isActive(runId)).toBe(true);
            if (row.id === 'N6') {
              expect(store.readEvents(runId).some(e => e.type === 'ask.requested')).toBe(true);
              const turns = store.readEvents(runId).filter(e => e.type === 'turn.completed').length;
              // The worker's own question is its parent's to answer (hearsay-tools/cezarion#2410).
              await answer('Vitest');
              await waitFor(() => store.readEvents(runId).filter(e => e.type === 'turn.completed').length > turns && store.getRun(runId)?.status === 'waiting');
              manager.finish(runId);
              await waitFor(() => !manager.isActive(runId));
              expect(store.getRun(runId)?.error).toBeUndefined();
              return;
            }
            if (row.id === 'N8') {
              expect(manager.steerWorker(runId, { id: randomUUID(), source: WAIT_SOURCE.agent, parentRunId, text: 'mock:no-progress-ack-only', createdAt: new Date().toISOString() })).toBe('queued');
              await waitFor(() => store.getRun(runId)?.agentInputs?.[0]?.deliveredAt !== undefined);
            } else if (row.id === 'N4') {
              manager.finish(runId);
              await waitFor(() => !manager.isActive(runId));
              expect(manager.continueRun(runId, { text: 'mock:no-progress' }).ok).toBe(true);
            } else {
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:no-progress' }])).toBe(true);
            }
          }
          if (row.id !== 'N2') {
            // bound: native mock startup includes Node imports and runner IPC;
            // give PID publication its own guard, independent of inactivity.
            await waitFor(() => {
              const cwd = store.getRun(runId)?.worktreePath;
              return cwd !== undefined && readPid(join(cwd, 'watchdog.pid')) !== undefined;
            }, 15_000);
            await vi.advanceTimersByTimeAsync(800);
          }
          // Let the real native wire and process exit settle; no synthetic turn events.
          if (row.id === 'N5' || row.id === 'N7') {
            await waitFor(() => store.readEvents(runId).some(e => e.type === 'error' && typeof e.message === 'string' && e.message.includes('no progress')));
            const pid = requirePid(join(store.getRun(runId)!.worktreePath!, 'watchdog.pid'));
            if (row.id === 'N5') {
              expect(() => process.kill(pid, 0)).not.toThrow();
              expect(manager.isActive(runId)).toBe(true);
            }
            if (row.id === 'N5') await vi.advanceTimersByTimeAsync(4_000);
            // bound: native exit follows TERM/KILL delivery, independent of
            // output drain and store settlement. N5 must exit from SIGKILL;
            // its mock's 12 s natural-exit backstop cannot make this pass.
            await waitFor(() => exits.has(pid), 15_000);
            if (row.id === 'N5') expect(exits.get(pid)).toBe('SIGKILL');
            // bound: after confirmed process exit, allow the bounded output
            // drain (up to 2 s) and the manager's durable capacity release.
            await waitFor(() => !manager.isActive(runId), 15_000);
            expect(() => process.kill(pid, 0)).toThrow();
          } else {
            // bound: N4 starts a new native session and N8 admits another input;
            // expiry above starts this separate exit/drain/settlement phase.
            await waitFor(() => !manager.isActive(runId), 15_000);
          }
          expect(manager.isActive(runId)).toBe(false);
          const run = store.getRun(runId)!;
          if (row.id === 'N2') {
            expect(run.error).toBeUndefined();
            expect(advanced).toBeGreaterThan(3 * 800);
            expect(run.steps.map(s => s.status)).toEqual(['done', 'done']);
          } else {
            expect(run.status).toBe('failed');
            expect(run.error).toContain('no progress');
            expect(store.readEvents(runId).some(e => e.type === 'check-output')).toBe(false);
          }
        }, { workflowDef, timings: { noProgressTimeoutMs: 800, killGraceMs: 150 } });
      }, 30_000);
    }
  }
});

}
