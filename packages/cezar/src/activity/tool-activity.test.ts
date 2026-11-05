import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { activityToolSchema } from '@open-mercato/cezar-contract/activity';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { UiEvent, UiToolItem } from '../core/ui-events.ts';
import type { RunRecord } from '../runs/store.ts';
import { ToolActivityTracker } from './tool-activity.ts';

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const RUN = 'run-1';
/** The contract's tool statuses, named through the schema. */
const TOOL_STATUS = activityToolSchema.shape.status.enum;

function tool(id: string, over: Partial<UiToolItem> = {}): UiToolItem {
  return { kind: 'tool', id, name: 'Bash', toolKind: 'execute', title: `Ran ${id}`, status: TOOL_STATUS.running, ...over };
}
const started = (item: UiToolItem): UiEvent => ({ type: 'item.started', item });
const updated = (item: UiToolItem): UiEvent => ({ type: 'item.updated', item });
const completed = (item: UiToolItem): UiEvent => ({ type: 'item.completed', item });

/** A tracker on a clock the test moves. */
function tracker() {
  const clock = { now: T0 };
  const tracked = new ToolActivityTracker({ now: () => clock.now });
  return { clock, tracked, read: (at = clock.now) => tracked.read(RUN, at) };
}
const zeros = () => Array.from({ length: 30 }, () => 0);
const rateWith = (counts: Record<number, number>) => zeros().map((zero, index) => counts[index] ?? zero);

describe('ToolActivityTracker', () => {
  it('knows nothing about a run that ran no tool, and ignores events that are not tool items', () => {
    const { tracked, read } = tracker();
    tracked.observe(RUN, { type: 'item.started', item: { kind: 'message', id: 'm', role: 'assistant', text: 'hi' } } as UiEvent);
    tracked.observe(RUN, { type: 'item.completed', item: { kind: 'hook', id: 'h', event: 'Stop', status: TOOL_STATUS.completed, entries: [] } });
    tracked.observe(RUN, { type: 'item.delta', itemId: 'x', field: 'output', delta: 'out' });
    expect(read()).toBeUndefined();
  });

  it('records a started tool and counts it once in the current second', () => {
    const { tracked, read } = tracker();
    tracked.observe(RUN, started(tool('a')));
    tracked.observe(RUN, { type: 'item.delta', itemId: 'a', field: 'output', delta: 'x' });
    expect(read()).toEqual({ tool: { title: 'Ran a', toolKind: 'execute', status: TOOL_STATUS.running, startedAt: iso(T0) }, rate: rateWith({ 29: 1 }) });
  });

  it.each([TOOL_STATUS.completed, TOOL_STATUS.failed, TOOL_STATUS.declined])('ends the latest tool when it is %s, without counting it again', (status) => {
    const { clock, tracked, read } = tracker();
    tracked.observe(RUN, started(tool('a')));
    clock.now += 2_500;
    tracked.observe(RUN, completed(tool('a', { status })));
    expect(read()).toEqual({
      tool: { title: 'Ran a', toolKind: 'execute', status, startedAt: iso(T0), endedAt: iso(T0 + 2_500) },
      rate: rateWith({ 27: 1 }),
    });
  });

  it('ends the latest tool on an update to a terminal status, and ignores its later completion', () => {
    const { clock, tracked, read } = tracker();
    tracked.observe(RUN, started(tool('a')));
    clock.now += 1_000;
    tracked.observe(RUN, updated(tool('a', { status: TOOL_STATUS.failed })));
    clock.now += 1_000;
    tracked.observe(RUN, completed(tool('a', { status: TOOL_STATUS.failed })));
    expect(read()?.tool).toMatchObject({ status: TOOL_STATUS.failed, endedAt: iso(T0 + 1_000) });
    expect(read()?.rate.reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it('counts a tool first seen at its completion once, with startedAt and endedAt at that event', () => {
    const { clock, tracked, read } = tracker();
    clock.now += 400;
    tracked.observe(RUN, completed(tool('a', { status: TOOL_STATUS.completed, toolKind: 'edit', title: 'Edited a.ts' })));
    expect(read()).toEqual({
      tool: { title: 'Edited a.ts', toolKind: 'edit', status: TOOL_STATUS.completed, startedAt: iso(T0 + 400), endedAt: iso(T0 + 400) },
      rate: rateWith({ 29: 1 }),
    });
  });

  it('takes a non-terminal update’s title and status, and does not count it again', () => {
    const { tracked, read } = tracker();
    tracked.observe(RUN, started(tool('a', { status: TOOL_STATUS.pending, title: 'Bash' })));
    tracked.observe(RUN, updated(tool('a', { status: TOOL_STATUS.running, title: 'Ran npm test' })));
    expect(read()).toEqual({ tool: { title: 'Ran npm test', toolKind: 'execute', status: TOOL_STATUS.running, startedAt: iso(T0) }, rate: rateWith({ 29: 1 }) });
  });

  it('takes a title that arrives only with the completion, and keeps the last one when the completion carries none', () => {
    const { tracked, read } = tracker();
    tracked.observe(RUN, started(tool('a', { toolKind: 'edit', title: 'Edit' })));
    tracked.observe(RUN, completed(tool('a', { toolKind: 'edit', status: TOOL_STATUS.completed, title: 'Edited src/a.ts' })));
    expect(read()?.tool?.title).toBe('Edited src/a.ts');

    tracked.observe(RUN, started(tool('b', { title: 'Ran ls' })));
    tracked.observe(RUN, completed(tool('b', { status: TOOL_STATUS.completed, title: '' })));
    expect(read()?.tool).toMatchObject({ title: 'Ran ls', status: TOOL_STATUS.completed });
  });

  it('shows a second tool that starts before the first ends; the first one’s events change nothing', () => {
    const { clock, tracked, read } = tracker();
    tracked.observe(RUN, started(tool('a')));
    clock.now += 300;
    tracked.observe(RUN, started(tool('b', { toolKind: 'read', title: 'Read b.ts' })));
    clock.now += 300;
    tracked.observe(RUN, updated(tool('a', { title: 'Ran something else' })));
    tracked.observe(RUN, completed(tool('a', { status: TOOL_STATUS.failed })));
    expect(read()).toEqual({ tool: { title: 'Read b.ts', toolKind: 'read', status: TOOL_STATUS.running, startedAt: iso(T0 + 300) }, rate: rateWith({ 29: 2 }) });
  });

  it('shifts the ring across idle seconds, oldest first', () => {
    const { clock, tracked, read } = tracker();
    tracked.observe(RUN, started(tool('a')));
    tracked.observe(RUN, started(tool('b')));
    clock.now += 3_000;
    tracked.observe(RUN, started(tool('c')));
    clock.now += 5_000;
    expect(read()?.rate).toEqual(rateWith({ 21: 2, 24: 1 }));
    // A read at the same second shifts nothing more.
    expect(read()?.rate).toEqual(rateWith({ 21: 2, 24: 1 }));
    expect(read(T0 + 29_999)?.rate).toEqual(rateWith({ 0: 2, 3: 1 }));
  });

  it('empties the ring after more than 30 idle seconds, and keeps the latest tool', () => {
    const { clock, tracked, read } = tracker();
    tracked.observe(RUN, started(tool('a')));
    expect(read(T0 + 30_000)?.rate).toEqual(zeros());
    clock.now += 95_000;
    tracked.observe(RUN, started(tool('b')));
    expect(read()).toMatchObject({ tool: { title: 'Ran b', startedAt: iso(T0 + 95_000) }, rate: rateWith({ 29: 1 }) });
  });

  it('never counts a background subagent; a spawn call that turns background has ended', () => {
    const { clock, tracked, read } = tracker();
    tracked.observe(RUN, started(tool('agent', { name: 'Agent', toolKind: 'task', title: 'Agent: research' })));
    clock.now += 1_000;
    tracked.observe(RUN, updated(tool('agent', { name: 'Agent', toolKind: 'task', title: 'Agent: research', background: true })));
    tracked.observe(RUN, started(tool('spawn', { toolKind: 'task', title: 'Task: child', background: true })));
    clock.now += 1_000;
    tracked.observe(RUN, completed(tool('agent', { name: 'Agent', toolKind: 'task', title: 'Agent: research', status: TOOL_STATUS.completed, background: true })));
    expect(read()).toEqual({
      tool: { title: 'Agent: research', toolKind: 'task', status: TOOL_STATUS.completed, startedAt: iso(T0), endedAt: iso(T0 + 1_000) },
      rate: rateWith({ 27: 1 }),
    });
  });

  it('clamps the title to 160 characters, never inside a surrogate pair', () => {
    const { tracked, read } = tracker();
    tracked.observe(RUN, started(tool('a', { title: `${'x'.repeat(159)}😀 and more` })));
    const shown = read()!.tool!;
    expect(shown.title).toBe('x'.repeat(159));
    expect(activityToolSchema.parse(shown)).toEqual(shown);
    tracked.observe(RUN, started(tool('b', { title: 'y'.repeat(400) })));
    expect(read()!.tool!.title).toBe('y'.repeat(160));
  });

  it('keeps runs apart', () => {
    const { tracked, read } = tracker();
    tracked.observe('other', started(tool('a', { title: 'Ran elsewhere' })));
    expect(read()).toBeUndefined();
    expect(tracked.read('other', T0)?.tool?.title).toBe('Ran elsewhere');
  });

  it('drops a run when it settles or is deleted, on the run change itself; a live change keeps it', () => {
    const { tracked } = tracker();
    const store = new EventEmitter();
    const unwatch = tracked.watch(store as never);
    const run = (id: string, status: RunRecord['status']) => makeRunRecord({ id, status });
    for (const id of ['settles', 'waits', 'deleted']) tracked.observe(id, started(tool('a')));

    store.emit('run', run('waits', RUN_STATUS.waiting));
    store.emit('run', run('settles', RUN_STATUS.review));
    store.emit('deleted', 'deleted');
    expect(['settles', 'waits', 'deleted'].map((id) => tracked.read(id, T0) !== undefined)).toEqual([false, true, false]);

    unwatch();
    store.emit('run', run('waits', RUN_STATUS.done));
    expect(tracked.read('waits', T0)).toBeDefined();
    expect(store.listenerCount('run') + store.listenerCount('deleted')).toBe(0);
  });

  it('starts a settled run afresh when it runs again', () => {
    const { clock, tracked, read } = tracker();
    tracked.observe(RUN, started(tool('a')));
    tracked.drop(RUN);
    clock.now += 2_000;
    tracked.observe(RUN, updated(tool('a', { title: 'Ran a again' })));
    expect(read()).toEqual({ tool: { title: 'Ran a again', toolKind: 'execute', status: TOOL_STATUS.running, startedAt: iso(T0 + 2_000) }, rate: rateWith({ 29: 1 }) });
  });
});
