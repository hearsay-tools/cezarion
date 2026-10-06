import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { FINAL_MESSAGE_CRITERIA, HARNESS_ADAPTERS, driveSeam, exemptionFor, promptFor, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';
import { handoffPath } from '../handoff.ts';

const nudgeNotes = (events: readonly Record<string, unknown>[]) =>
  events.filter(e => e.type === 'note' && String(e.message).includes('no final message'));
const autonomousNotes = (events: readonly Record<string, unknown>[]) =>
  events.filter(e => e.type === 'note' && String(e.message).includes('continuing without pausing'));

function lastTopLevelTail(events: readonly UiEvent[]): Extract<UiEvent, { type: 'item.completed' }>['item'] | undefined {
  const completed = events.filter((e): e is Extract<UiEvent, { type: 'item.completed' }> =>
    e.type === 'item.completed' && e.item.parentItemId === undefined &&
    (e.item.kind === 'message' || e.item.kind === 'reasoning' || e.item.kind === 'tool'));
  return completed.at(-1)?.item;
}

describe('silent-tail seam — mapper emits reasoning/tool with no later message (#544)', () => {
  for (const backend of RUNNER_IDS) {
    it(`${backend} silent-tail ends on reasoning or tool, not a later assistant message`, async () => {
      const observed = await driveSeam(backend, 'silent-tail');
      const completed = observed.v2.filter((e): e is Extract<UiEvent, { type: 'item.completed' }> =>
        e.type === 'item.completed' && e.item.parentItemId === undefined);
      expect(completed.some(e => e.item.kind === 'message' && e.item.role === 'assistant' && e.item.text.includes('Filing the issue now.'))).toBe(true);
      expect(completed.some(e => e.item.kind === 'reasoning' || e.item.kind === 'tool')).toBe(true);
      const tail = lastTopLevelTail(observed.v2);
      expect(tail?.kind === 'reasoning' || tail?.kind === 'tool').toBe(true);
      if (tail?.kind === 'reasoning') expect(tail.text).toContain('CEZ:DONE');
    });
  }
});

describe('final-message nudge parity — #544', () => {
  for (const backend of RUNNER_IDS) {
    for (const row of FINAL_MESSAGE_CRITERIA) {
      if (row.id === 'F7') {
        const exemption = exemptionFor('F7', backend);
        if (exemption) {
          it(`${backend} F7 exemption — ${exemption.reason}`, async () => {
            expect(HARNESS_ADAPTERS[backend].scenarios['silent-tail-ack-delay']).toBeUndefined();
          });
          continue;
        }
        it(`${backend} ${row.id} ${row.name}`, async () => {
          await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId, repoRoot }) => {
            manager.enqueueOwnedRun(runId);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            const startSeq = store.readEvents(runId).length;
            const handoff = handoffPath(join(repoRoot, '.ai/cezar'), runId);
            expect(manager.steerWorker(runId, {
              id: randomUUID(), source: 'agent', parentRunId,
              text: promptFor(backend, 'silent-tail-ack-delay'), createdAt: new Date().toISOString(),
            })).toBe('queued');
            await waitFor(() => store.readEvents(runId).slice(startSeq).some(e => e.type === 'turn-end'));
            expect(manager['active'].get(runId)?.agentInputFlight).toBeDefined();
            expect(nudgeNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(0);
            await waitFor(() => nudgeNotes(store.readEvents(runId).slice(startSeq)).length === 1);
            expect(nudgeNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(1);
            expect(readFileSync(handoff, 'utf8')).toContain('status=running (final message nudge)');
          });
        }, 30_000);
        continue;
      }
      if (row.id === 'F8') {
        const exemption = exemptionFor('F8', backend);
        if (exemption) {
          it(`${backend} F8 exemption — ${exemption.reason}`, async () => {
            expect(HARNESS_ADAPTERS[backend].scenarios['silent-tail-no-reply']).toBeUndefined();
            await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId }) => {
              manager.enqueueOwnedRun(runId);
              await waitFor(() => store.getRun(runId)?.status === 'waiting');
              const started = store.readEvents(runId).filter(e => e.type === 'turn.started').length;
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:hold' }])).toBe(true);
              await waitFor(() => store.readEvents(runId).filter(e => e.type === 'turn.started').length > started);
            });
          }, 30_000);
          continue;
        }
        it(`${backend} ${row.id} ${row.name}`, async () => {
          await withOwnedInputRun(backend, 'silent-tail-no-reply', async ({ store, manager, runId, repoRoot }) => {
            (manager as unknown as { finalMessageNudgeReplyMs: number }).finalMessageNudgeReplyMs = 300;
            const handoff = handoffPath(join(repoRoot, '.ai/cezar'), runId);
            const startSeq = store.readEvents(runId).length;
            manager.enqueueOwnedRun(runId);
            await waitFor(() => nudgeNotes(store.readEvents(runId).slice(startSeq)).length === 1);
            expect(store.getRun(runId)?.status).toBe('running');
            expect(manager['busySlots']()).toBe(1);
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(store.getRun(runId)?.status).toBe('running');
            expect(manager['busySlots']()).toBe(1);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            expect(manager['busySlots']()).toBe(0);
            expect(nudgeNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(1);
            expect(store.readEvents(runId).some(e => e.type === 'note' && String(e.message).includes('no reply to the final-message nudge'))).toBe(true);
            expect(readFileSync(handoff, 'utf8')).toContain('status=waiting');
          });
        }, 30_000);
        continue;
      }
      for (const mode of ['fresh', 'continuation'] as const) {
        it(`${backend} ${row.id} ${row.name} (${mode})`, async () => {
          await withOwnedInputRun(backend, mode === 'continuation' ? 'baseline' : row.scenario, async ({ store, manager, runId, repoRoot }) => {
            const handoff = handoffPath(join(repoRoot, '.ai/cezar'), runId);
            if (mode === 'continuation') {
              manager.enqueueOwnedRun(runId);
              await waitFor(() => store.getRun(runId)?.status === 'waiting');
              manager.finish(runId);
              await waitFor(() => !manager.isActive(runId));
            }
            if (row.id === 'F6') store.updateRun(runId, { autonomous: true });
            const startSeq = store.readEvents(runId).length;
            if (mode === 'continuation') expect(manager.continueRun(runId, { text: promptFor(backend, row.scenario) }).ok).toBe(true);
            else manager.enqueueOwnedRun(runId);
            if (row.id === 'F6') {
              await waitFor(() => autonomousNotes(store.readEvents(runId).slice(startSeq)).length >= 1);
              expect(store.getRun(runId)?.status).toBe('running');
              expect(manager['busySlots']()).toBe(1);
              expect(manager['active'].get(runId)?.idleTimer).toBeUndefined();
              expect(nudgeNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(0);
              return;
            }
            await waitFor(() => store.getRun(runId)?.status === 'waiting' || ['done', 'review', 'failed'].includes(store.getRun(runId)?.status ?? '') || store.getRun(runId)?.activity === 'monitoring');
            const events = store.readEvents(runId).slice(startSeq);
            const notes = nudgeNotes(events);
            const status = store.getRun(runId)?.status;
            if (row.id === 'F1') {
              expect(status).toBe('done');
              expect(notes).toHaveLength(1);
              expect(autonomousNotes(events)).toHaveLength(0);
              expect(readFileSync(handoff, 'utf8')).toContain('status=running (final message nudge)');
            } else if (row.id === 'F2') {
              expect(status).toBe('waiting');
              expect(status).not.toBe('done');
              expect(notes).toHaveLength(1);
              expect(autonomousNotes(events)).toHaveLength(0);
            } else if (row.id === 'F3') {
              const all = store.readEvents(runId);
              expect(status).toBe('waiting');
              expect(status).not.toBe('done');
              expect(all.some(e => e.type === 'lifecycle' && String(e.message).includes('goal achieved'))).toBe(false);
              expect(notes).toHaveLength(1);
              expect(autonomousNotes(events)).toHaveLength(0);
              expect(all.some(e => {
                if (e.type !== 'item.completed') return false;
                const item = e.item as { kind?: string; text?: string } | undefined;
                return item?.kind === 'reasoning' && (item.text ?? '').includes('CEZ:DONE');
              })).toBe(true);
            } else if (row.id === 'F4') {
              expect(status).toBe('waiting');
              expect(notes).toHaveLength(1);
              expect(autonomousNotes(events)).toHaveLength(0);
            } else {
              expect(status).toBe('done');
              expect(notes).toHaveLength(0);
            }
          });
        }, 30_000);
      }
    }
  }
});
