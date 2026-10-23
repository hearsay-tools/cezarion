import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { RunEvent } from '../runs/store.ts';
import { formatTimeline, until } from './worker-wait.testkit.ts';

const ts = '2026-10-20T10:00:00.000Z';
const events: RunEvent[] = [
  { seq: 1, ts, type: 'step-start', stepId: 'task', name: 'Task' },
  { seq: 2, ts, type: 'turn.started', stepId: 'task', turnId: 'turn_1' },
  { seq: 3, ts, type: 'tool-call', stepId: 'task', tool: 'Bash' },
  { seq: 4, ts, type: 'conversation-message', message: { kind: 'progress', text: 'API correction: use v2' }, delivery: 'delivered' },
  { seq: 5, ts, type: 'text', stepId: 'task', text: 'Read the\n  "correction"' },
  { seq: 6, ts, type: 'turn.completed', stepId: 'task', turnId: 'turn_1' },
  { seq: 7, ts, type: 'turn-end', stepId: 'task' },
  { seq: 8, ts, type: 'note', message: `nudge ${'x'.repeat(100)}` },
  { seq: 9, ts, type: 'turn.started', stepId: 'task', turnId: 'turn_2' },
  { seq: 10, ts, type: 'turn-end', stepId: 'task' },
];

describe('the event timeline in assertion messages (hearsay-tools/cezarion#1292)', () => {
  it('lists each event after the seq with its type, turn, step and the start of its text or message', () => {
    expect(formatTimeline('run-1', events, 2)).toBe([
      'events of run run-1 after seq 2:',
      '  3 tool-call turn=turn_1 step=task',
      '  4 conversation-message turn=turn_1 step=- "API correction: use v2"',
      '  5 text turn=turn_1 step=task "Read the \\"correction\\""',
      '  6 turn.completed turn=turn_1 step=task',
      '  7 turn-end turn=turn_1 step=task',
      `  8 note turn=- step=- "nudge ${'x'.repeat(74)}…"`,
      '  9 turn.started turn=turn_2 step=task',
      '  10 turn-end turn=turn_2 step=task',
      'assertion',
    ].join('\n'));
  });

  it('says when no event follows the seq', () => {
    expect(formatTimeline('run-1', events, 10)).toBe('events of run run-1 after seq 10:\n  (none)\nassertion');
  });

  it("reads as the prefix of a failing assertion's own message", () => {
    const timeline = formatTimeline('run-1', events, 9);
    expect(() => expect(2, timeline).toBe(1)).toThrow(`${timeline}: expected 2 to be 1`);
  });

  it('builds the message of a wait only when the wait fails', async () => {
    const explain = vi.fn(() => formatTimeline('run-1', events, 9));
    await until(() => true, explain);
    expect(explain).not.toHaveBeenCalled();
    // The 15 s budget is the testkit's own; the failure it ends in is all this checks.
    const waitFor = vi.spyOn(vi, 'waitFor').mockRejectedValueOnce(new Error('expected false to be true'));
    onTestFinished(() => waitFor.mockRestore());
    await expect(until(() => false, explain)).rejects.toThrow(`${explain()}: expected false to be true`);
    expect(explain).toHaveBeenCalledTimes(2);
  });

  it('names the predicate when a wait times out without an explanation', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const parentWaitIsParked = () => false;
    const failed = expect(until(parentWaitIsParked)).rejects.toThrow(`Waiting for ${parentWaitIsParked.toString()}`);
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
  });
});
