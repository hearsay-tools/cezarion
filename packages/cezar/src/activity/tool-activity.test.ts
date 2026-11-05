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
/** Feed one event with no secret to redact. */
const see = (tracked: ToolActivityTracker, runId: string, event: UiEvent) => tracked.observe(runId, event, (text) => text);

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
    see(tracked, RUN, { type: 'item.started', item: { kind: 'message', id: 'm', role: 'assistant', text: 'hi' } } as UiEvent);
    see(tracked, RUN, { type: 'item.completed', item: { kind: 'hook', id: 'h', event: 'Stop', status: TOOL_STATUS.completed, entries: [] } });
    see(tracked, RUN, { type: 'item.delta', itemId: 'x', field: 'output', delta: 'out' });
    expect(read()).toBeUndefined();
  });

  it('records a started tool and counts it once in the current second', () => {
    const { tracked, read } = tracker();
    see(tracked, RUN, started(tool('a')));
    see(tracked, RUN, { type: 'item.delta', itemId: 'a', field: 'output', delta: 'x' });
    expect(read()).toEqual({ tool: { title: 'Ran a', toolKind: 'execute', status: TOOL_STATUS.running, startedAt: iso(T0) }, rate: rateWith({ 29: 1 }) });
  });

  it.each([TOOL_STATUS.completed, TOOL_STATUS.failed, TOOL_STATUS.declined])('ends the latest tool when it is %s, without counting it again', (status) => {
    const { clock, tracked, read } = tracker();
    see(tracked, RUN, started(tool('a')));
    clock.now += 2_500;
    see(tracked, RUN, completed(tool('a', { status })));
    expect(read()).toEqual({
      tool: { title: 'Ran a', toolKind: 'execute', status, startedAt: iso(T0), endedAt: iso(T0 + 2_500) },
      rate: rateWith({ 27: 1 }),
    });
  });

  it('ends the latest tool on an update to a terminal status, and ignores its later completion', () => {
    const { clock, tracked, read } = tracker();
    see(tracked, RUN, started(tool('a')));
    clock.now += 1_000;
    see(tracked, RUN, updated(tool('a', { status: TOOL_STATUS.failed })));
    clock.now += 1_000;
    see(tracked, RUN, completed(tool('a', { status: TOOL_STATUS.failed })));
    expect(read()?.tool).toMatchObject({ status: TOOL_STATUS.failed, endedAt: iso(T0 + 1_000) });
    expect(read()?.rate.reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it('counts a tool first seen at its completion once, with startedAt and endedAt at that event', () => {
    const { clock, tracked, read } = tracker();
    clock.now += 400;
    see(tracked, RUN, completed(tool('a', { status: TOOL_STATUS.completed, toolKind: 'edit', title: 'Edited a.ts' })));
    expect(read()).toEqual({
      tool: { title: 'Edited a.ts', toolKind: 'edit', status: TOOL_STATUS.completed, startedAt: iso(T0 + 400), endedAt: iso(T0 + 400) },
      rate: rateWith({ 29: 1 }),
    });
  });

  it('takes a non-terminal update’s title and status, and does not count it again', () => {
    const { tracked, read } = tracker();
    see(tracked, RUN, started(tool('a', { status: TOOL_STATUS.pending, title: 'Bash' })));
    see(tracked, RUN, updated(tool('a', { status: TOOL_STATUS.running, title: 'Ran npm test' })));
    expect(read()).toEqual({ tool: { title: 'Ran npm test', toolKind: 'execute', status: TOOL_STATUS.running, startedAt: iso(T0) }, rate: rateWith({ 29: 1 }) });
  });

  it('takes a title that arrives only with the completion, and keeps the last one when the completion carries none', () => {
    const { tracked, read } = tracker();
    see(tracked, RUN, started(tool('a', { toolKind: 'edit', title: 'Edit' })));
    see(tracked, RUN, completed(tool('a', { toolKind: 'edit', status: TOOL_STATUS.completed, title: 'Edited src/a.ts' })));
    expect(read()?.tool?.title).toBe('Edited src/a.ts');

    see(tracked, RUN, started(tool('b', { title: 'Ran ls' })));
    see(tracked, RUN, completed(tool('b', { status: TOOL_STATUS.completed, title: '' })));
    expect(read()?.tool).toMatchObject({ title: 'Ran ls', status: TOOL_STATUS.completed });
  });

  it('shows a second tool that starts before the first ends; the first one’s events change nothing', () => {
    const { clock, tracked, read } = tracker();
    see(tracked, RUN, started(tool('a')));
    clock.now += 300;
    see(tracked, RUN, started(tool('b', { toolKind: 'read', title: 'Read b.ts' })));
    clock.now += 300;
    see(tracked, RUN, updated(tool('a', { title: 'Ran something else' })));
    see(tracked, RUN, completed(tool('a', { status: TOOL_STATUS.failed })));
    expect(read()).toEqual({ tool: { title: 'Read b.ts', toolKind: 'read', status: TOOL_STATUS.running, startedAt: iso(T0 + 300) }, rate: rateWith({ 29: 2 }) });
  });

  it('shifts the ring across idle seconds, oldest first', () => {
    const { clock, tracked, read } = tracker();
    see(tracked, RUN, started(tool('a')));
    see(tracked, RUN, started(tool('b')));
    clock.now += 3_000;
    see(tracked, RUN, started(tool('c')));
    clock.now += 5_000;
    expect(read()?.rate).toEqual(rateWith({ 21: 2, 24: 1 }));
    // A read at the same second shifts nothing more.
    expect(read()?.rate).toEqual(rateWith({ 21: 2, 24: 1 }));
    expect(read(T0 + 29_999)?.rate).toEqual(rateWith({ 0: 2, 3: 1 }));
  });

  it('empties the ring after more than 30 idle seconds, and keeps the latest tool', () => {
    const { clock, tracked, read } = tracker();
    see(tracked, RUN, started(tool('a')));
    expect(read(T0 + 30_000)?.rate).toEqual(zeros());
    clock.now += 95_000;
    see(tracked, RUN, started(tool('b')));
    expect(read()).toMatchObject({ tool: { title: 'Ran b', startedAt: iso(T0 + 95_000) }, rate: rateWith({ 29: 1 }) });
  });

  it('never counts a background subagent; a spawn call that turns background has ended', () => {
    const { clock, tracked, read } = tracker();
    see(tracked, RUN, started(tool('agent', { name: 'Agent', toolKind: 'task', title: 'Agent: research' })));
    clock.now += 1_000;
    see(tracked, RUN, updated(tool('agent', { name: 'Agent', toolKind: 'task', title: 'Agent: research', background: true })));
    see(tracked, RUN, started(tool('spawn', { toolKind: 'task', title: 'Task: child', background: true })));
    clock.now += 1_000;
    see(tracked, RUN, completed(tool('agent', { name: 'Agent', toolKind: 'task', title: 'Agent: research', status: TOOL_STATUS.completed, background: true })));
    expect(read()).toEqual({
      tool: { title: 'Agent: research', toolKind: 'task', status: TOOL_STATUS.completed, startedAt: iso(T0), endedAt: iso(T0 + 1_000) },
      rate: rateWith({ 27: 1 }),
    });
  });

  it('ignores a later event of a completed tool, but takes a new title of the latest one', () => {
    const { clock, tracked, read } = tracker();
    see(tracked, RUN, started(tool('a')));
    clock.now += 1_000;
    see(tracked, RUN, completed(tool('a', { status: TOOL_STATUS.completed })));
    clock.now += 1_000;
    see(tracked, RUN, completed(tool('a', { status: TOOL_STATUS.failed, title: 'Ran a, final' })));
    see(tracked, RUN, started(tool('a', { title: 'Ran a, final' })));
    expect(read()).toEqual({
      tool: { title: 'Ran a, final', toolKind: 'execute', status: TOOL_STATUS.completed, startedAt: iso(T0), endedAt: iso(T0 + 1_000) },
      rate: rateWith({ 27: 1 }),
    });
  });

  it('remembers the last 64 completed tool ids, and forgets the oldest', () => {
    const { tracked, read } = tracker();
    const ids = Array.from({ length: 65 }, (_, index) => `t${index}`);
    for (const id of ids) see(tracked, RUN, completed(tool(id, { status: TOOL_STATUS.completed })));
    const calls = () => read()!.rate.reduce((sum, count) => sum + count, 0);
    expect(calls()).toBe(65);
    // t1 is still remembered: its repeat changes nothing.
    see(tracked, RUN, completed(tool('t1', { status: TOOL_STATUS.completed })));
    expect(calls()).toBe(65);
    expect(read()!.tool!.title).toBe('Ran t64');
    // t0 fell out of the memory: its repeat reads as a new call.
    see(tracked, RUN, completed(tool('t0', { status: TOOL_STATUS.completed })));
    expect(calls()).toBe(66);
  });

  it('clamps the title to 160 characters, never inside a surrogate pair', () => {
    const { tracked, read } = tracker();
    see(tracked, RUN, started(tool('a', { title: `${'x'.repeat(159)}😀 and more` })));
    const shown = read()!.tool!;
    expect(shown.title).toBe('x'.repeat(159));
    expect(activityToolSchema.parse(shown)).toEqual(shown);
    see(tracked, RUN, started(tool('b', { title: 'y'.repeat(400) })));
    expect(read()!.tool!.title).toBe('y'.repeat(160));
  });

  it('redacts a title before it clamps it, so no part of a secret at the clamp boundary stays', () => {
    const { tracked, read } = tracker();
    const secret = 'Zq7-secret-value-0123456789';
    const redact = (text: string) => text.split(secret).join('[REDACTED]');
    tracked.observe(RUN, started(tool('a', { title: `Ran curl -H ${secret}` })), redact);
    expect(read()!.tool!.title).toBe('Ran curl -H [REDACTED]');
    // Clamped first, the title would end in the secret's first ten characters, which no redactor matches.
    tracked.observe(RUN, started(tool('b', { title: `${'x'.repeat(150)}${secret} tail` })), redact);
    expect(read()!.tool!.title).toBe(`${'x'.repeat(150)}[REDACTED]`);
    tracked.observe(RUN, completed(tool('b', { status: TOOL_STATUS.completed, title: `Ran ${secret}` })), redact);
    expect(read()!.tool!.title).toBe('Ran [REDACTED]');
  });

  it('keeps runs apart', () => {
    const { tracked, read } = tracker();
    see(tracked, 'other', started(tool('a', { title: 'Ran elsewhere' })));
    expect(read()).toBeUndefined();
    expect(tracked.read('other', T0)?.tool?.title).toBe('Ran elsewhere');
  });

  /** A run store as a feed sees it: run changes and a redactor that hides `secret`. */
  function fakeStore() {
    return Object.assign(new EventEmitter(), { redactText: (text: string) => text.split('hunter2-secret').join('[REDACTED]') });
  }
  const runChange = (id: string, status: RunRecord['status']) => makeRunRecord({ id, status });

  it('drops a run when it settles or is deleted, on the run change itself; a live change keeps it', () => {
    const { tracked } = tracker();
    const store = fakeStore();
    const feed = tracked.attach(store);
    for (const id of ['settles', 'waits', 'deleted']) feed.observe(id, started(tool('a')));

    store.emit('run', runChange('waits', RUN_STATUS.waiting));
    store.emit('run', runChange('settles', RUN_STATUS.review));
    store.emit('deleted', 'deleted');
    expect(['settles', 'waits', 'deleted'].map((id) => tracked.read(id, T0) !== undefined)).toEqual([false, true, false]);
  });

  it('redacts each title with the store’s redactor', () => {
    const { tracked, read } = tracker();
    tracked.attach(fakeStore()).observe(RUN, started(tool('a', { title: 'Ran login hunter2-secret' })));
    expect(read()?.tool?.title).toBe('Ran login [REDACTED]');
  });

  it('prunes an entry after 60 s with no event once its latest tool has ended', () => {
    const { clock, tracked, read } = tracker();
    see(tracked, RUN, started(tool('a')));
    clock.now += 1_000;
    see(tracked, RUN, completed(tool('a', { status: TOOL_STATUS.completed })));
    expect(read(T0 + 1_000 + 59_999)?.tool).toMatchObject({ title: 'Ran a', status: TOOL_STATUS.completed });
    expect(read(T0 + 1_000 + 60_000)).toBeUndefined();
    // The prune is final: a later read finds nothing either.
    expect(read(T0 + 1_000)).toBeUndefined();
  });

  it('keeps a running tool older than 60 s', () => {
    const { tracked, read } = tracker();
    see(tracked, RUN, started(tool('a', { title: 'Ran the full test suite' })));
    expect(read(T0 + 10 * 60_000)).toEqual({
      tool: { title: 'Ran the full test suite', toolKind: 'execute', status: TOOL_STATUS.running, startedAt: iso(T0) }, rate: zeros(),
    });
  });

  it('prunes other runs’ idle entries when an event arrives, with no read of them', () => {
    const { clock, tracked } = tracker();
    see(tracked, 'idle', completed(tool('a', { status: TOOL_STATUS.completed })));
    see(tracked, 'busy', started(tool('a')));
    clock.now += 60_000;
    see(tracked, RUN, started(tool('b')));
    // A read at T0 would not prune on its own: only the sweep can have removed the idle entry.
    expect(tracked.read('idle', T0)).toBeUndefined();
    expect(tracked.read('busy', T0)).toBeDefined();
  });

  it('tracks a run afresh once the store reports it live again (a resume)', () => {
    const { clock, tracked, read } = tracker();
    const store = fakeStore();
    const feed = tracked.attach(store);
    feed.observe(RUN, started(tool('a')));
    store.emit('run', runChange(RUN, RUN_STATUS.review));
    store.emit('run', runChange(RUN, RUN_STATUS.running));
    clock.now += 2_000;
    feed.observe(RUN, started(tool('b', { title: 'Ran b after resume' })));
    expect(read()).toEqual({ tool: { title: 'Ran b after resume', toolKind: 'execute', status: TOOL_STATUS.running, startedAt: iso(T0 + 2_000) }, rate: rateWith({ 29: 1 }) });
  });

  it('shows no tool from before a resume: a late tool start after a stop is cleared when the run turns live', () => {
    const { clock, tracked, read } = tracker();
    const store = fakeStore();
    const feed = tracked.attach(store);
    // Stopped before its first tool; its session still reports a tool that never completes.
    store.emit('run', runChange(RUN, RUN_STATUS.cancelled));
    feed.observe(RUN, started(tool('late', { title: 'Ran late' })));
    expect(read()).toBeUndefined();
    // A running tool is never pruned: the marked entry outlives 60 s and another run's sweep.
    clock.now += 120_000;
    feed.observe('other', started(tool('a')));

    store.emit('run', runChange(RUN, RUN_STATUS.running));
    expect(read()).toBeUndefined();
    feed.observe(RUN, started(tool('new', { title: 'Ran after resume' })));
    expect(read()).toEqual({ tool: { title: 'Ran after resume', toolKind: 'execute', status: TOOL_STATUS.running, startedAt: iso(T0 + 120_000) }, rate: rateWith({ 29: 1 }) });
  });

  it('keeps a live run’s entry on a live run change, and holds a stop marker for 60 s only', () => {
    const { clock, tracked, read } = tracker();
    const store = fakeStore();
    const feed = tracked.attach(store);
    feed.observe(RUN, started(tool('a')));
    store.emit('run', runChange(RUN, RUN_STATUS.waiting));
    expect(read()?.tool?.title).toBe('Ran a');

    store.emit('run', runChange('stopped', RUN_STATUS.done));
    clock.now += 60_000;
    feed.observe(RUN, completed(tool('a', { status: TOOL_STATUS.completed })));
    // The sweep pruned the idle marker: a much later event is a plain entry again (still hidden by the
    // read model, which shows tool activity only for a live run).
    feed.observe('stopped', completed(tool('b', { status: TOOL_STATUS.completed, title: 'Ran b' })));
    expect(tracked.read('stopped', clock.now)?.tool?.title).toBe('Ran b');
  });

  it('drops the runs a feed fed when it detaches, stops listening, and ignores later events', () => {
    const { tracked } = tracker();
    const store = fakeStore();
    const other = tracked.attach(fakeStore());
    const feed = tracked.attach(store);
    feed.observe('mine', started(tool('a')));
    other.observe('theirs', started(tool('a')));

    feed.detach();
    feed.observe('mine', started(tool('b')));
    store.emit('run', runChange('theirs', RUN_STATUS.done));
    expect(tracked.read('mine', T0)).toBeUndefined();
    expect(tracked.read('theirs', T0)).toBeDefined();
    expect(store.listenerCount('run') + store.listenerCount('deleted')).toBe(0);
  });
});
