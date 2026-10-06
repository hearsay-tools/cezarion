import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { FINAL_MESSAGE_CRITERIA, driveSeam, promptFor, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';
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
            const startSeq = store.readEvents(runId).length;
            if (mode === 'continuation') expect(manager.continueRun(runId, { text: promptFor(backend, row.scenario) }).ok).toBe(true);
            else manager.enqueueOwnedRun(runId);
            await waitFor(() => store.getRun(runId)?.status === 'waiting' || ['done', 'review', 'failed'].includes(store.getRun(runId)?.status ?? '') || store.getRun(runId)?.activity === 'monitoring');
            const events = store.readEvents(runId).slice(startSeq);
            const notes = nudgeNotes(events);
            const status = store.getRun(runId)?.status;
            if (row.id === 'F1') {
              expect(status).toBe('done');
              expect(notes).toHaveLength(1);
              expect(autonomousNotes(events)).toHaveLength(0);
              expect(readFileSync(handoff, 'utf8')).toContain('status=running (final message nudge)');
            } else if (row.id === 'F2' || row.id === 'F3') {
              expect(status).toBe('waiting');
              expect(status).not.toBe('done');
              expect(notes).toHaveLength(1);
              expect(autonomousNotes(events)).toHaveLength(0);
            } else if (row.id === 'F4') {
              expect(status).toBe('waiting');
              expect(notes).toHaveLength(0);
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
