import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { FINAL_MESSAGE_CRITERIA, HARNESS_ADAPTERS, driveSeam, exemptionFor, promptFor, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';
import { NO_WAIT_NO_REPLY_NOTE, NO_WAIT_NUDGE_NOTE } from '../workflows/run.ts';
import { watchTurnOutcomes } from '../workflows/turn-outcomes.testkit.ts';

// Poll native process/store signals while the product's reply clock is frozen.
async function waitForNativeContent(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Native reply signal missing: ${ready.toString()}`);
    // bound: real I/O poll; fake time must not advance until native content arrives.
    await realDelay(10);
  }
}

// The no-wait nudge absorbed the final-message nudge (hearsay-tools/cezarion#1234): these rows pin
// its reply bound, #544's liveness. A worker's fallback stays the plain park.
const nudgeNotes = (events: readonly Record<string, unknown>[]) =>
  events.filter(e => e.type === 'note' && String(e.message).startsWith(NO_WAIT_NUDGE_NOTE));
const noReplyNotes = (events: readonly Record<string, unknown>[]) =>
  events.filter(e => e.type === 'note' && e.message === NO_WAIT_NO_REPLY_NOTE);
const autonomousNotes = (events: readonly Record<string, unknown>[]) =>
  events.filter(e => e.type === 'note' && String(e.message).includes('continuing without pausing'));
const shortenNudgeBound = (manager: { noWaitNudgeReplyMs?: number }) => {
  // bound: exercise expiry without the production five-minute wait; late replies are gated.
  manager.noWaitNudgeReplyMs = 300;
};
const lateDoneContent = (events: readonly Record<string, unknown>[]) =>
  events.some(e => {
    if (e.type === 'text') return String(e.text).includes('Filed #543');
    if (e.type !== 'item.completed') return false;
    const item = e.item as { kind?: string; text?: string } | undefined;
    return item?.kind === 'message' && (item.text ?? '').includes('Filed #543');
  });

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

describe('no-wait nudge parity — #544, hearsay-tools/cezarion#1234', () => {
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
          await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
            manager.enqueueOwnedRun(runId);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            const startSeq = store.readEvents(runId).length;
            const turns = watchTurnOutcomes();
            expect(manager.steerWorker(runId, {
              id: randomUUID(), source: 'agent', parentRunId,
              text: promptFor(backend, 'silent-tail-ack-delay'), createdAt: new Date().toISOString(),
            })).toBe('queued');
            await waitFor(() => store.readEvents(runId).slice(startSeq).some(e => e.type === 'turn-end'));
            expect(manager['active'].get(runId)?.agentInputFlight).toBeDefined();
            expect(nudgeNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(0);
            await waitFor(() => nudgeNotes(store.readEvents(runId).slice(startSeq)).length === 1);
            expect(nudgeNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(1);
            expect(turns.words(runId)).toContain('running (no-wait nudge)');
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
          await withOwnedInputRun(backend, 'silent-tail-no-reply', async ({ store, manager, runId }) => {
            shortenNudgeBound(manager as unknown as { noWaitNudgeReplyMs?: number });
            const turns = watchTurnOutcomes();
            const startSeq = store.readEvents(runId).length;
            manager.enqueueOwnedRun(runId);
            await waitFor(() => nudgeNotes(store.readEvents(runId).slice(startSeq)).length === 1);
            expect(store.getRun(runId)?.status).toBe('running');
            expect(manager['busySlots']()).toBe(1);
            // bound: observe the real silent-tail-no-reply child for 150 ms before the 300 ms reply deadline; no early park may release its slot.
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(store.getRun(runId)?.status).toBe('running');
            expect(manager['busySlots']()).toBe(1);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            expect(manager['busySlots']()).toBe(0);
            expect(nudgeNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(1);
            expect(noReplyNotes(store.readEvents(runId))).toHaveLength(1);
            expect(turns.words(runId)).toContain('waiting');
          });
        }, 30_000);
        continue;
      }
      if (row.id === 'F9') {
        const exemption = exemptionFor('F9', backend);
        if (exemption) {
          it(`${backend} F9 exemption — ${exemption.reason}`, async () => {
            expect(HARNESS_ADAPTERS[backend].scenarios['silent-tail-late-reply']).toBeUndefined();
            const observed = await driveSeam(backend, 'silent-tail');
            expect(observed.v2.some(event => event.type === 'turn.started')).toBe(true);
            expect(observed.v1.some(event => event.type === 'turn-end')).toBe(true);
          });
          continue;
        }
        it(`${backend} ${row.id} ${row.name}`, async () => {
          const gateRoot = mkdtempSync(join(tmpdir(), 'cez-late-reply-'));
          const release = join(gateRoot, 'release');
          try {
            await withOwnedInputRun(backend, 'silent-tail-late-reply', async ({ store, manager, runId }) => {
              shortenNudgeBound(manager as unknown as { noWaitNudgeReplyMs?: number });
              const startSeq = store.readEvents(runId).length;
              manager.enqueueOwnedRun(runId);
              await waitFor(() => noReplyNotes(store.readEvents(runId).slice(startSeq)).length === 1);
              expect(store.getRun(runId)?.status).toBe('waiting');
              expect(manager['busySlots']()).toBe(0);
              // The native reply stays blocked until parking and slot release are observed.
              // Capture the resumed slot in the store callback: DONE can follow in the same tick.
              let resumedSlots: number | undefined;
              const onRun = (run: { id: string; status: string }) => {
                if (run.id === runId && run.status === 'running') resumedSlots ??= manager['busySlots']();
              };
              store.on('run', onRun);
              try {
                writeFileSync(release, 'go');
                await waitFor(() => resumedSlots !== undefined);
                expect(resumedSlots).toBe(1);
                await waitFor(() => store.getRun(runId)?.status === 'done');
              } finally { store.off('run', onRun); }
              expect(nudgeNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(1);
              expect(noReplyNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(1);
            }, { env: { CEZ_MOCK_RELEASE_FILE: release } });
          } finally { rmSync(gateRoot, { recursive: true, force: true }); }
        }, 30_000);
        continue;
      }
      if (row.id === 'F11') {
        const exemption = exemptionFor('F11', backend);
        if (exemption) {
          it(`${backend} F11 exemption — ${exemption.reason}`, async () => {
            expect(HARNESS_ADAPTERS[backend].scenarios['silent-tail-late-turn-start']).toBeUndefined();
          });
          continue;
        }
        it(`${backend} ${row.id} ${row.name}`, async () => {
          const gateRoot = mkdtempSync(join(tmpdir(), 'cez-late-turn-'));
          const release = join(gateRoot, 'release');
          try {
            await withOwnedInputRun(backend, 'silent-tail-late-turn-start', async ({ store, manager, runId }) => {
              shortenNudgeBound(manager as unknown as { noWaitNudgeReplyMs?: number });
              const startSeq = store.readEvents(runId).length;
              manager.enqueueOwnedRun(runId);
              await waitFor(() => noReplyNotes(store.readEvents(runId).slice(startSeq)).length === 1);
              expect(store.getRun(runId)?.status).toBe('waiting');
              expect(manager['busySlots']()).toBe(0);
              const parkedSeq = store.readEvents(runId).length;
              // The mock waits for observed parking instead of racing a 200 ms window.
              writeFileSync(release, 'go');
              // Content has its own gate, so only native turn-start can resume the run here.
              await waitFor(() => store.getRun(runId)?.status === 'running');
              expect(manager['busySlots']()).toBe(1);
              expect(lateDoneContent(store.readEvents(runId).slice(parkedSeq))).toBe(false);
              writeFileSync(`${release}.content`, 'go');
              await waitFor(() => store.getRun(runId)?.status === 'done');
              expect(nudgeNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(1);
              expect(noReplyNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(1);
            }, { env: { CEZ_MOCK_RELEASE_FILE: release } });
          } finally { rmSync(gateRoot, { recursive: true, force: true }); }
        }, 30_000);
        continue;
      }
      if (row.id === 'F10') {
        it(`${backend} ${row.id} ${row.name}`, async () => {
          const gateRoot = backend === 'cursor' ? mkdtempSync(join(tmpdir(), 'cez-nudge-content-')) : undefined;
          try { await withOwnedInputRun(backend, 'silent-tail-slow-done', async ({ store, manager, runId }) => {
            shortenNudgeBound(manager as unknown as { noWaitNudgeReplyMs?: number });
            const turns = watchTurnOutcomes();
            const startSeq = store.readEvents(runId).length;
            if (gateRoot) {
              // Cursor starts a new print process for the nudge. Its startup must not
              // consume F10's 300 ms content budget (hearsay-tools/cezarion#1511).
              // Freeze only that budget: process-drain and other timers keep real time.
              const realSetTimeout = globalThis.setTimeout;
              vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
              const fakeSetTimeout = globalThis.setTimeout;
              let armingReply = false;
              let replyTimers = 0;
              const timerOwner = manager as unknown as { armNoWaitNudgeReplyTimer: typeof manager['armNoWaitNudgeReplyTimer'] };
              const armReply = timerOwner.armNoWaitNudgeReplyTimer.bind(manager);
              const armClock = vi.spyOn(timerOwner, 'armNoWaitNudgeReplyTimer').mockImplementation((...args) => {
                armingReply = true;
                try { armReply(...args); } finally { armingReply = false; }
              });
              const replyClock = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
                if (!armingReply) return realSetTimeout(...args);
                replyTimers++;
                return fakeSetTimeout(...args);
              }) as typeof setTimeout);
              try {
                manager.enqueueOwnedRun(runId);
                await waitForNativeContent(() => store.readEvents(runId).slice(startSeq).some(e =>
                  e.type === 'text' && String(e.text).includes('Working on the wrap-up.')));
                expect(replyTimers).toBe(1);
                expect(manager['active'].get(runId)?.noWaitNudgeReplyTimer).toBeUndefined();
                // The native mock holds DONE until this test crosses the reply bound.
                await vi.advanceTimersByTimeAsync(300);
                expect(store.getRun(runId)?.status).toBe('running');
                expect(manager['busySlots']()).toBe(1);
                expect(noReplyNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(0);
              } finally { armClock.mockRestore(); replyClock.mockRestore(); vi.useRealTimers(); }
              writeFileSync(join(gateRoot, 'done'), 'go');
            } else manager.enqueueOwnedRun(runId);
            await waitFor(() => store.getRun(runId)?.status === 'done' || store.getRun(runId)?.status === 'waiting');
            expect(store.getRun(runId)?.status).toBe('done');
            expect(nudgeNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(1);
            expect(noReplyNotes(store.readEvents(runId).slice(startSeq))).toHaveLength(0);
            expect(turns.words(runId)).toContain('running (no-wait nudge)');
          }, gateRoot ? { env: { CEZ_MOCK_RELEASE_FILE: join(gateRoot, 'done') } } : {});
          } finally { if (gateRoot) rmSync(gateRoot, { recursive: true, force: true }); }
        }, 30_000);
        continue;
      }
      for (const mode of ['fresh', 'continuation'] as const) {
        it(`${backend} ${row.id} ${row.name} (${mode})`, async () => {
          await withOwnedInputRun(backend, mode === 'continuation' ? 'baseline' : row.scenario, async ({ store, manager, runId }) => {
            const turns = watchTurnOutcomes();
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
            await waitFor(() => store.getRun(runId)?.status === 'waiting' || ['done', 'review', 'failed'].includes(store.getRun(runId)?.status ?? ''));
            const events = store.readEvents(runId).slice(startSeq);
            const notes = nudgeNotes(events);
            const status = store.getRun(runId)?.status;
            if (row.id === 'F1') {
              expect(status).toBe('done');
              expect(notes).toHaveLength(1);
              expect(autonomousNotes(events)).toHaveLength(0);
              expect(turns.words(runId)).toContain('running (no-wait nudge)');
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
                const item = e.item as { kind?: string; text?: string; output?: string } | undefined;
                // Cursor print suppresses reasoning natively. Its tool output
                // carries the marker control without turning it into v1 text.
                return backend === 'cursor'
                  ? item?.kind === 'tool' && (item.output ?? '').includes('CEZ:DONE')
                  : item?.kind === 'reasoning' && (item.text ?? '').includes('CEZ:DONE');
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
