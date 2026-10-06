import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { AUTONOMOUS_CRITERIA, driveRun, driveSeam, exemptionFor, promptFor, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';
import { handoffPath } from '../handoff.ts';
import { MAX_AUTO_CONTINUES } from '../workflows/run.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';

const nudges = (events: readonly Record<string, unknown>[]) => events.filter(e => e.type === 'note' && String(e.message).includes('continuing without pausing'));

describe('autonomous turn-end parity — #426', () => {
  for (const backend of RUNNER_IDS) {
    for (const row of AUTONOMOUS_CRITERIA) {
      const exemption = exemptionFor(row.id, backend);
      if (row.id === 'A13' || row.id === 'A14') {
        it(`${backend} ${row.id} ${row.name}${exemption ? ' — exemption: ordinary native idle control' : ''}`, async () => {
          const continuation = row.id === 'A14';
          const retainedAck = !exemption;
          await driveRun(backend, continuation || exemption ? 'autonomous' : row.scenario,
            run => run?.status === (retainedAck && !continuation ? 'running' : 'waiting'), 30_000,
            async ({ store, manager, runId }) => {
              expect(store.getRun(runId)?.delegation?.role).not.toBe('worker');
              if (continuation) {
                manager.finish(runId);
                await waitFor(() => !manager.isActive(runId));
                store.updateRun(runId, { autonomous: retainedAck });
                expect(manager.continueRun(runId, { text: promptFor(backend, exemption ? 'autonomous' : row.scenario) }).ok).toBe(true);
              }
              await waitFor(() => {
                const current = manager['active'].get(runId);
                return !!current?.idleTimer && (retainedAck ? !!current.autonomousNudgePending : store.getRun(runId)?.status === 'waiting');
              });
              const state = manager['active'].get(runId)!;
              const session = state.session!;
              const stepId = state.currentStepId!;
              const sent = vi.spyOn(session, 'sendAgentMessage');
              expect(!!state.autonomousNudgePending).toBe(retainedAck);
              if (retainedAck) {
                expect(store.getRun(runId)?.status).toBe('running');
                expect(manager['busySlots']()).toBe(1);
              }
              // Execute the real idle-expiry callback, with only its 15-minute
              // delay accelerated. No normalized event or session result injection.
              const timer = state.idleTimer! as NodeJS.Timeout & { _onTimeout: () => void };
              const expire = timer._onTimeout;
              clearTimeout(timer);
              expire();
              expect(state.idleClosed).toBe(true);
              if (retainedAck) {
                expect(manager.isActive(runId)).toBe(true);
                expect(manager['busySlots']()).toBe(1);
                expect(store.getRun(runId)?.status).toBe('running');
                // The mock delays SIGTERM exit: neither end() nor late readiness
                // may release the slot or resurrect the timed-out boundary.
                manager['handleAgentInputReady'](runId, state, session);
                await new Promise(resolve => setTimeout(resolve, 50));
                expect(manager.isActive(runId)).toBe(true);
                expect(manager['busySlots']()).toBe(1);
              }
              await waitFor(() => !manager.isActive(runId));
              expect(sent).not.toHaveBeenCalled();
              expect(manager['busySlots']()).toBe(0);
              expect(store.getRun(runId)?.status).toBe('waiting');
              expect(store.getRun(runId)?.steps.at(-1)?.status).toBe('waiting');
              if (retainedAck) {
                expect(readPersistedRuns(manager['dataDir'])).toEqual(expect.arrayContaining([
                  expect.objectContaining({ id: runId, status: 'waiting', steps: expect.arrayContaining([
                    expect.objectContaining({ id: stepId, status: 'waiting' }),
                  ]) }),
                ]));
                expect(readFileSync(handoffPath(manager['dataDir'], runId), 'utf8')).toContain('session idle-closed — status=waiting');
              }
              expect(store.readEvents(runId).some(e => e.type === 'lifecycle' && String(e.message).includes('of inactivity'))).toBe(true);
              expect(manager.continueRun(runId, { text: promptFor(backend, 'done') }).ok).toBe(true);
              await waitFor(() => !manager.isActive(runId) && store.getRun(runId)?.status === 'done');
              manager['handleAgentInputReady'](runId, state, session);
              expect(sent).not.toHaveBeenCalled();
              sent.mockRestore();
            }, { autonomous: retainedAck && !continuation });
        }, 30_000);
        continue;
      }
      if (exemption) {
        it(`${backend} ${row.id} exemption — ${exemption.reason}`, async () => {
          const observed = await driveSeam(backend, 'ask');
          expect(observed.v2.some(e => e.type === 'ask.requested')).toBe(false);
          expect(observed.v1.some(e => e.type === 'text' && e.text.includes('CEZ:ASK'))).toBe(true);
        });
        continue;
      }
      // Cap and non-autonomous controls exercise both constructors as well.
      const modes = row.id === 'A2' || row.id === 'A4' || row.id === 'A12' ? ['continuation'] : row.id === 'A5' || row.id === 'A6' ? ['fresh', 'continuation'] : ['fresh'];
      for (const mode of modes) it(`${backend} ${row.id} ${row.name} (${mode})`, async () => {
        await withOwnedInputRun(backend, mode === 'continuation' ? 'autonomous' : row.scenario, async ({ store, manager, runId, repoRoot }) => {
          const handoff = handoffPath(join(repoRoot, '.ai/cezar'), runId);
          if (mode === 'continuation') {
            manager.enqueueOwnedRun(runId);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            manager.finish(runId);
            await waitFor(() => !manager.isActive(runId));
            writeFileSync(handoff, '# Continuation evidence\n\n## Progress log\n\n## Resume notes\n');
          }
          store.updateRun(runId, { autonomous: row.id !== 'A6' });
          if (row.id === 'A10') store.appendEvent(runId, {
            type: 'ask.requested', requestId: randomUUID(),
            questions: [{ header: 'Prior', question: 'A prior unanswered question?', options: [{ label: 'Yes' }, { label: 'No' }] }],
          });
          const updates = vi.spyOn(store, 'updateRun');
          const startSeq = store.readEvents(runId).length;
          if (mode === 'continuation') expect(manager.continueRun(runId, { text: promptFor(backend, row.scenario) }).ok).toBe(true);
          else manager.enqueueOwnedRun(runId);
          // Assert on the first stable outcome, so a missing nudge fails directly as
          // waiting rather than burning the whole timeout waiting for completion.
          await waitFor(() => store.getRun(runId)?.status === 'waiting' || ['done', 'review', 'failed'].includes(store.getRun(runId)?.status ?? '') || store.getRun(runId)?.activity === 'monitoring');
          // A native ask parks mid-turn. Let that wire advance if it incorrectly
          // receives a synthetic answer; no manager-injected normalized event.
          if (row.id === 'A9') await new Promise(resolve => setTimeout(resolve, 150));
          const events = store.readEvents(runId).slice(startSeq);
          const notes = nudges(events);
          if (row.id === 'A5' || row.id === 'A11' || row.id === 'A12') {
            expect(store.getRun(runId)?.status).toBe('waiting');
            expect(notes).toHaveLength(MAX_AUTO_CONTINUES);
            expect(events.some(e => e.type === 'note' && String(e.message).includes(`autonomous — safety cap reached (${MAX_AUTO_CONTINUES})`))).toBe(true);
            expect(readFileSync(handoff, 'utf8').match(/status=waiting/g)).toHaveLength(1);
          } else if (row.id === 'A6' || row.id === 'A9' || row.id === 'A10') {
            expect(store.getRun(runId)?.status).toBe('waiting');
            expect(notes).toHaveLength(0);
            if (row.id !== 'A6') {
              expect(events.some(e => e.type === 'ask.requested')).toBe(true);
              expect(events.some(e => e.type === 'human-input-delivered')).toBe(false);
              expect(events.some(e => e.type === 'note' && String(e.message).includes('question overridden'))).toBe(false);
            }
          } else {
            expect(store.getRun(runId)?.status).toBe('done');
            expect(notes).toHaveLength(row.id === 'A8' ? 0 : 1);
            expect(updates.mock.calls.filter(([id]) => id === runId).map(([, patch]) => patch.status)).not.toContain('waiting');
            const heartbeat = readFileSync(handoff, 'utf8');
            expect(heartbeat).not.toContain('status=waiting');
            if (row.id !== 'A8') expect(heartbeat).toContain('status=running (autonomous nudge)');
            const stepId = store.getRun(runId)!.steps.at(-1)!.id;
            expect(notes.every(note => note.stepId === stepId)).toBe(true);
            if (row.id === 'A3' || row.id === 'A4') {
              expect(events.some(e => e.type === 'note' && e.stepId === stepId && String(e.message).includes('question overridden') && String(e.message).includes('Which test library?'))).toBe(true);
              expect(events.filter(e => e.type === 'ask.requested' || e.type === 'human-input-delivered')).toEqual([]);
              expect(events.filter(e => e.type === 'user-message' && String(e.text).startsWith('Continue working autonomously'))).toEqual([]);
            }
          }
          if (row.id === 'A11' || row.id === 'A12') {
            expect(events.filter(e => e.type === 'note' && String(e.message).includes('question overridden'))).toHaveLength(1);
            expect(events.filter(e => e.type === 'ask.requested' || e.type === 'human-input-delivered')).toEqual([]);
            expect(events.filter(e => e.type === 'user-message' && String(e.text).startsWith('Continue working autonomously'))).toEqual([]);
            // Prove the native SSE boundary actually beat the portable answer's
            // HTTP ACK, rather than passing through the already-ready path.
            if (backend === 'opencode') expect(readFileSync(handoff, 'utf8')).toContain('status=running (awaiting input readiness)');
            expect(updates.mock.calls.filter(([id, patch]) => id === runId && patch.status === 'waiting')).toHaveLength(1);
          }
          updates.mockRestore();
        });
      }, 30_000);
    }
  }
});
