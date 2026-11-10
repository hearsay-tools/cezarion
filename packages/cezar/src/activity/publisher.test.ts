import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivitySnapshot } from '@open-mercato/cezar-contract';
import { ACTIVITY_RATE_SECONDS } from '@open-mercato/cezar-contract/activity';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../runs/store.ts';
import { addOutcome, addRequest, fakeStore, makeRoot, NOW } from './activity.testkit.ts';
import { ActivityDemand } from './demand.ts';
import {
  ACTIVITY_COALESCE_MS, ACTIVITY_DRAIN_TICK_MS, ACTIVITY_FOREIGN_CHECK_MS, createActivityPublisher,
  type ActivityChangeSource, type ActivityPublisherDeps, type LiveActivityStore,
} from './publisher.ts';
import type { ToolActivitySource } from './read-model.ts';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CockpitOwnership } from '../server/cockpit-ownership.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** A project store over mutable records: `held` and `foreign` change between reads. */
function liveStore(runs: RunRecord[], options: { held?: string[]; foreign?: string[] } = {}) {
  const foreign = options.foreign ?? [];
  const store = Object.assign(new EventEmitter(), fakeStore(runs, { ...options, foreign })) as unknown as LiveActivityStore & EventEmitter;
  return { store, foreign, changed: (run: RunRecord) => store.emit('run', run) };
}

/** One tool call per run at a fixed second: its bucket ages out 30 s later, as the tracker's ring does. */
function toolCalls() {
  const calls = new Map<string, number>();
  const tools: ToolActivitySource = {
    read: (runId, now) => {
      const at = calls.get(runId);
      const rate = Array.from({ length: ACTIVITY_RATE_SECONDS }, () => 0);
      if (at === undefined) return { rate };
      const age = Math.floor((now - at) / 1_000);
      if (age < ACTIVITY_RATE_SECONDS) rate[ACTIVITY_RATE_SECONDS - 1 - age] = 1;
      return { rate };
    },
  };
  return { tools, call: (runId: string) => calls.set(runId, Date.now()) };
}

function publisherFor(store: LiveActivityStore, deps: ActivityPublisherDeps = {}, demand = new ActivityDemand()) {
  const publisher = createActivityPublisher({
    sources: async () => [{ projectId: 'shop', name: 'Shop', loaded: { store, isActive: () => false } }],
    watch: () => demand.watch('shop'),
  }, deps);
  return { publisher, demand };
}

/** Subscribe as the hub does: start, then the subscriber's snapshot. */
async function subscribe(publisher: ReturnType<typeof createActivityPublisher>) {
  const frames: ActivitySnapshot[] = [];
  const stop = publisher.start((data) => frames.push(data as ActivitySnapshot));
  const first = await publisher.snapshot() as ActivitySnapshot;
  return { frames, stop, first };
}

/** One foreign check, then at most one coalescing window before its rebuild runs: less than two checks. */
const ONE_CHECK_MS = ACTIVITY_FOREIGN_CHECK_MS + ACTIVITY_COALESCE_MS;

const titles = (snapshot: ActivitySnapshot | undefined) => snapshot?.projects[0]?.tasks.map((task) => task.title);

describe('the activity publisher', () => {
  it('sends nothing when a change leaves the snapshot as it was', async () => {
    const root = makeRoot({ title: 'Build' });
    const { store, changed } = liveStore([root]);
    const { publisher } = publisherFor(store);
    const { frames, first, stop } = await subscribe(publisher);
    expect(titles(first)).toEqual(['Build']);

    changed(root);
    changed(root);
    await vi.advanceTimersByTimeAsync(5 * ACTIVITY_COALESCE_MS);
    expect(frames).toEqual([]);
    stop();
  });

  it('coalesces changes to at most one snapshot every 500 ms', async () => {
    const root = makeRoot({ title: 'one' });
    const { store, changed } = liveStore([root]);
    const { publisher } = publisherFor(store);
    const { frames, stop } = await subscribe(publisher);

    for (const title of ['two', 'three', 'four']) {
      root.title = title;
      changed(root);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.map(titles)).toEqual([['four']]);

    root.title = 'five';
    changed(root);
    await vi.advanceTimersByTimeAsync(ACTIVITY_COALESCE_MS - 1);
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames.map(titles)).toEqual([['four'], ['five']]);
    stop();
  });

  it('wakes on a tracker change', async () => {
    const root = makeRoot();
    const { store } = liveStore([root]);
    const { tools, call } = toolCalls();
    const listeners = new Set<() => void>();
    const tracker: ActivityChangeSource = { onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
    const { publisher } = publisherFor(store, { tools, changes: [tracker] });
    const { frames, stop } = await subscribe(publisher);

    call(root.id);
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.at(-1)?.projects[0]?.tasks[0]?.rate.at(-1)).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
  });

  it('drains the heartbeat of a task that parks with nonzero buckets, then stops', async () => {
    const root = makeRoot();
    const { store, changed } = liveStore([root]);
    const { tools, call } = toolCalls();
    const { publisher } = publisherFor(store, { tools });
    const { frames, stop } = await subscribe(publisher);

    call(root.id);
    root.status = RUN_STATUS.waiting; // the last running task parks: no later event
    changed(root);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(1);

    // One frame a second while a bucket is nonzero, until the call ages out of the ring. The
    // extra tick covers the rebuild that a tick schedules just after it.
    await vi.advanceTimersByTimeAsync((ACTIVITY_RATE_SECONDS + 1) * ACTIVITY_DRAIN_TICK_MS);
    const last = frames.at(-1)!.projects[0]!.tasks[0]!;
    expect(last.rate.every((count) => count === 0)).toBe(true);
    expect(frames.length).toBeGreaterThanOrEqual(ACTIVITY_RATE_SECONDS);
    const drained = frames.length;
    await vi.advanceTimersByTimeAsync(10 * ACTIVITY_DRAIN_TICK_MS);
    expect(frames).toHaveLength(drained);
    stop();
  });

  it('shows a foreign write that raises no local event within one check', async () => {
    const root = makeRoot({ title: 'before' });
    const { store, foreign } = liveStore([root], { held: [] });
    foreign.push(root.id); // another cockpit process owns the family
    const { publisher } = publisherFor(store);
    const { frames, stop } = await subscribe(publisher);

    root.title = 'after'; // written by the other process: this store emits nothing
    await vi.advanceTimersByTimeAsync(ONE_CHECK_MS);
    expect(frames.map(titles)).toEqual([['after']]);
    stop();
  });

  it('reads no claims of a project while a migration fence holds it', async () => {
    const project = mkdtempSync(join(realpathSync(tmpdir()), 'cez-activity-fence-'));
    const dataDir = join(project, '.ai', 'cezar');
    const migrator = new CockpitOwnership();
    try {
      const { store } = liveStore([makeRoot({ title: 'task' })], { held: [] });
      const reads = vi.spyOn(store, 'listForeignClaimedRunIds');
      const publisher = createActivityPublisher({
        sources: async () => [{ projectId: 'shop', name: 'Shop', loaded: { store, isActive: () => false, dataDir } }],
        watch: () => new ActivityDemand().watch('shop'),
      });
      const { stop } = await subscribe(publisher);
      const fence = await migrator.fenceProject(dataDir, { liveTasks: () => [], inFlight: () => 0 });
      reads.mockClear();
      await vi.advanceTimersByTimeAsync(2 * ONE_CHECK_MS);
      expect(reads).not.toHaveBeenCalled();
      fence.release();
      await vi.advanceTimersByTimeAsync(ONE_CHECK_MS);
      expect(reads).toHaveBeenCalled();
      stop();
    } finally {
      migrator.releaseAll();
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('shows a foreign run created after subscribe within one check', async () => {
    const runs: RunRecord[] = [];
    const { store, foreign } = liveStore(runs, { held: [] });
    const { publisher } = publisherFor(store);
    const { frames, first, stop } = await subscribe(publisher);
    expect(titles(first)).toEqual([]);

    const created = makeRoot({ title: 'elsewhere' });
    runs.push(created);
    foreign.push(created.id);
    await vi.advanceTimersByTimeAsync(ONE_CHECK_MS);
    expect(frames.map(titles)).toEqual([['elsewhere']]);
    stop();
  });

  it('shows a foreign owner that settles and exits before the first check', async () => {
    const root = makeRoot({ title: 'elsewhere' });
    const { store, foreign } = liveStore([root], { held: [], foreign: [root.id] });
    const { publisher } = publisherFor(store);
    const { frames, first, stop } = await subscribe(publisher);
    expect(titles(first)).toEqual(['elsewhere']);

    // The other process finishes the task and exits: its claim is gone at the first check.
    root.status = RUN_STATUS.done;
    foreign.splice(0);
    await vi.advanceTimersByTimeAsync(ONE_CHECK_MS);
    expect(frames.map(titles)).toEqual([[]]);
    stop();
  });

  it('tells existing subscribers about a change a new subscriber saw through the 500 ms gate', async () => {
    const root = makeRoot({ title: 'one' });
    const { store, changed } = liveStore([root]);
    const { publisher } = publisherFor(store);
    const { frames, stop } = await subscribe(publisher);
    root.title = 'two';
    changed(root);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.map(titles)).toEqual([['two']]);

    // A write this store never announced, seen first by a second subscriber 100 ms later.
    root.title = 'three';
    await vi.advanceTimersByTimeAsync(100);
    const second = await publisher.snapshot() as ActivitySnapshot;
    expect(titles(second)).toEqual(['three']); // the new subscriber's own frame is immediate
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ACTIVITY_COALESCE_MS - 101);
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames.map(titles)).toEqual([['two'], ['three']]);
    stop();
  });

  it('keeps a reply whose sender settles before the next build: the carry-over', async () => {
    const sender = makeRoot();
    const recipient = makeRoot();
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    const held = [sender.id, recipient.id];
    const { store, changed } = liveStore([sender, recipient], { held });
    const { publisher } = publisherFor(store);
    const { frames, first, stop } = await subscribe(publisher);
    expect(first.projects[0]!.requests.map((open) => open.requestId)).toEqual([request.id]);

    // The reply lands and the sender ends at once: it leaves the held set and the cards.
    addOutcome(sender, { requestId: request.id, status: 'replied', observedAt: new Date(Date.now()).toISOString() });
    sender.status = RUN_STATUS.done;
    held.splice(0, 1);
    changed(sender);
    await vi.advanceTimersByTimeAsync(0);
    const project = frames.at(-1)!.projects[0]!;
    expect(project.requests).toEqual([]);
    expect(project.closed.map((closed) => [closed.requestId, closed.status])).toEqual([[request.id, 'replied']]);
    stop();
  });

  it('keeps the carry-over when a new subscriber reads between the reply and the next broadcast', async () => {
    const sender = makeRoot();
    const recipient = makeRoot();
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    const held = [sender.id, recipient.id];
    const { store } = liveStore([sender, recipient], { held });
    const { publisher } = publisherFor(store);
    const { frames, stop } = await subscribe(publisher);

    // The reply lands and the sender leaves the held set; no store event reaches this process.
    addOutcome(sender, { requestId: request.id, status: 'replied', observedAt: new Date(Date.now()).toISOString() });
    sender.status = RUN_STATUS.done;
    held.splice(0, 1);
    // A second subscriber reads first: its own frame shows the reply.
    const second = await publisher.snapshot() as ActivitySnapshot;
    expect(second.projects[0]!.closed.map((closed) => closed.requestId)).toEqual([request.id]);

    // The change reaches the first subscriber through the gate, with the reply still in it.
    await vi.advanceTimersByTimeAsync(ACTIVITY_COALESCE_MS);
    const project = frames.at(-1)!.projects[0]!;
    expect(project.requests).toEqual([]);
    expect(project.closed.map((closed) => [closed.requestId, closed.status])).toEqual([[request.id, 'replied']]);
    stop();
  });

  it('runs nothing without a subscriber and releases everything at the last one', async () => {
    const root = makeRoot();
    const { store } = liveStore([root], { foreign: [root.id] });
    const { publisher, demand } = publisherFor(store);
    expect(vi.getTimerCount()).toBe(0);

    const { stop } = await subscribe(publisher);
    expect(demand.has('shop')).toBe(true);
    expect(store.listenerCount('run')).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.listenerCount('run') + store.listenerCount('deleted')).toBe(0);
    expect(demand.has('shop')).toBe(false);
    await vi.advanceTimersByTimeAsync(3 * ACTIVITY_FOREIGN_CHECK_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
