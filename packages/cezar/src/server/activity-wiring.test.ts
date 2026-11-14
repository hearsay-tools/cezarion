import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivitySnapshot } from '@open-mercato/cezar-contract';
import { ACTIVITY_RATE_SECONDS, activityToolSchema } from '@open-mercato/cezar-contract/activity';
import { makePrWait, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { fakeStore, makeRoot, NOW } from '../activity/activity.testkit.ts';
import { ActivityDemand } from '../activity/demand.ts';
import { ACTIVITY_COALESCE_MS } from '../activity/publisher.ts';
import { ToolActivityTracker } from '../activity/tool-activity.ts';
import { CiProgressRegistry } from '../ci-wait/progress.ts';
import type { UiToolItem } from '../core/ui-events.ts';
import type { RunRecord } from '../runs/store.ts';
import { createActivityRoutes } from './activity-routes.ts';
import type { LoadedProject } from './activity-sources.ts';
import { ACTIVITY_PROJECT_TOPIC_PREFIX } from './activity-topic.ts';
import { ProjectContextError } from './project-context.ts';
import type { SocketHub, TopicFamilyResolver, TopicPublisher } from './ws.ts';

/**
 * The activity route's wiring (spec 2026-11-05-live-activity-view, Live transport): one activity
 * demand for the process, the tool tracker's and the CI registries' changes as publisher triggers,
 * and the release of every CI registry plug on the server's close path.
 */

const TOOL_STATUS = activityToolSchema.shape.status.enum;
const tool = (id: string): UiToolItem => ({ kind: 'tool', id, name: 'Bash', toolKind: 'execute', title: `Ran ${id}`, status: TOOL_STATUS.running });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function project(id: string, runs: RunRecord[], ciProgress: CiProgressRegistry): LoadedProject {
  const store = Object.assign(new EventEmitter(), fakeStore(runs));
  return { id, root: `/repos/${id}`, store, manager: { isActive: () => false, ciProgress } } as unknown as LoadedProject;
}

function wire(options: { boot: RunRecord[]; docs?: RunRecord[] }) {
  const registries = { boot: new CiProgressRegistry(), docs: new CiProgressRegistry() };
  const boot = project('boot', options.boot, registries.boot);
  const docs = project('docs', options.docs ?? [], registries.docs);
  const toolActivity = new ToolActivityTracker({ now: () => Date.now() });
  const topics = new Map<string, TopicPublisher>();
  const families = new Map<string, TopicFamilyResolver>();
  const closeListeners = new Set<() => void>();
  // While held, every source read waits: a test can close the server in the middle of one.
  let gate: Promise<void> | undefined;
  const hold = () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    return () => { gate = undefined; release(); };
  };
  const demand = new ActivityDemand();
  const hub: SocketHub = {
    registerTopic: (name, publisher) => { topics.set(name, publisher); },
    registerTopicFamily: (prefix, resolve) => { families.set(prefix, resolve); },
    handleUpgrade: () => undefined,
    close: () => { for (const listener of closeListeners) listener(); },
    onClose: (listener) => { closeListeners.add(listener); return () => closeListeners.delete(listener); },
  };
  const app = createActivityRoutes({
    demand,
    bootContext: boot,
    contexts: { peek: (id) => (id === 'docs' ? docs : undefined) },
    workspaceProjects: {
      listProjects: async () => { await gate; return [{ id: 'boot', name: 'Boot' }, { id: 'docs', name: 'Docs' }] as never; },
      resolveBootProject: async () => 'boot',
      projectFailure: () => ({ error: 'unavailable', status: 503 }),
      resolveLiveProject: async (id: string) => {
        if (id === 'boot' || id === 'default') return boot;
        if (id === 'docs') return docs;
        throw new ProjectContextError('unknown-project', id);
      },
    } as never,
    toolActivity,
    socketHub: hub,
  });
  /** Subscribe as the hub does: start, then the subscriber's own snapshot. */
  const subscribe = async (projectId: string) => {
    const publisher = (await families.get(ACTIVITY_PROJECT_TOPIC_PREFIX)!(projectId))!;
    const frames: ActivitySnapshot[] = [];
    const stop = publisher.start((data) => frames.push(data as ActivitySnapshot));
    await publisher.snapshot();
    return { frames, stop };
  };
  return { registries, toolActivity, hub, subscribe, families, hold, demand, app };
}

describe('activity route wiring', () => {
  it('sends a tool event to topic subscribers as one coalesced frame', async () => {
    const root = makeRoot({ status: RUN_STATUS.running });
    const { toolActivity, subscribe } = wire({ boot: [root] });
    const { frames, stop } = await subscribe('boot');

    for (const id of ['one', 'two', 'three']) toolActivity.observe(root.id, { type: 'item.started', item: tool(id) }, (text) => text);
    await vi.advanceTimersByTimeAsync(ACTIVITY_COALESCE_MS);
    expect(frames).toHaveLength(1);
    const card = frames[0]!.projects[0]!.tasks[0]!;
    expect(card.tool?.title).toBe('Ran three');
    expect(card.rate.at(-1)).toBe(3);
    stop();
  });

  /** A started tool, then the ring drains to flat and the frames stop: no later tick rebuilds. */
  async function drained(root: RunRecord) {
    const wired = wire({ boot: [root] });
    const subscribed = await wired.subscribe('boot');
    wired.toolActivity.observe(root.id, { type: 'item.started', item: tool('spawn') }, (text) => text);
    await vi.advanceTimersByTimeAsync((ACTIVITY_RATE_SECONDS + 2) * 1_000);
    expect(subscribed.frames.at(-1)!.projects[0]!.tasks[0]!.rate.every((count) => count === 0)).toBe(true);
    const settled = subscribed.frames.length;
    await vi.advanceTimersByTimeAsync(5 * 1_000);
    expect(subscribed.frames).toHaveLength(settled);
    return { ...wired, ...subscribed, settled };
  }

  it('sends a background transition of the latest tool after the ring drained', async () => {
    const root = makeRoot({ status: RUN_STATUS.running });
    const { toolActivity, frames, settled, stop } = await drained(root);

    toolActivity.observe(root.id, { type: 'item.updated', item: { ...tool('spawn'), background: true } }, (text) => text);
    await vi.advanceTimersByTimeAsync(ACTIVITY_COALESCE_MS);
    expect(frames).toHaveLength(settled + 1);
    expect(frames.at(-1)!.projects[0]!.tasks[0]!.tool).toMatchObject({ status: TOOL_STATUS.completed, endedAt: expect.any(String) });
    stop();
  });

  it('sends a new title on a repeated completion after the ring drained', async () => {
    const root = makeRoot({ status: RUN_STATUS.running });
    const { toolActivity, frames, stop } = await drained(root);
    toolActivity.observe(root.id, { type: 'item.completed', item: { ...tool('spawn'), status: TOOL_STATUS.completed } }, (text) => text);
    await vi.advanceTimersByTimeAsync(ACTIVITY_COALESCE_MS);
    const ended = frames.length;

    toolActivity.observe(root.id, { type: 'item.completed', item: { ...tool('spawn'), status: TOOL_STATUS.completed, title: 'Edited notes.md' } }, (text) => text);
    await vi.advanceTimersByTimeAsync(ACTIVITY_COALESCE_MS);
    expect(frames).toHaveLength(ended + 1);
    expect(frames.at(-1)!.projects[0]!.tasks[0]!.tool?.title).toBe('Edited notes.md');
    stop();
  });

  it('sends a CI progress update to topic subscribers', async () => {
    const wait = makePrWait();
    const root = makeRoot({ status: RUN_STATUS.waiting, waits: [wait] });
    const { registries, subscribe } = wire({ boot: [root] });
    const { frames, stop } = await subscribe('boot');

    registries.boot.publish(wait.id, [{ name: 'build', state: 'PENDING', link: '', bucket: 'pending' }, { name: 'lint', state: 'SUCCESS', link: '', bucket: 'pass' }]);
    await vi.advanceTimersByTimeAsync(ACTIVITY_COALESCE_MS);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.projects[0]!.tasks[0]!.wait).toMatchObject({ detail: { counts: { pass: 1, pending: 1 } } });
    stop();
  });

  it("lets a topic subscriber's demand reach a secondary project's CI registry", async () => {
    const wait = makePrWait();
    const root = makeRoot({ status: RUN_STATUS.waiting, waits: [wait] });
    const { registries, subscribe } = wire({ boot: [], docs: [root] });
    registries.docs.publish(wait.id, [{ name: 'build', state: 'PENDING', link: '', bucket: 'pending' }]);

    const { stop } = await subscribe('docs');
    expect(registries.docs.wanted(wait.id)).toBe(true);
    stop();
    expect(registries.docs.wanted(wait.id)).toBe(false);
  });

  it('releases every CI registry plug when the server closes', async () => {
    const bootWait = makePrWait();
    const docsWait = makePrWait();
    const { registries, hub, subscribe } = wire({
      boot: [makeRoot({ status: RUN_STATUS.waiting, waits: [bootWait] })],
      docs: [makeRoot({ status: RUN_STATUS.waiting, waits: [docsWait] })],
    });
    registries.boot.publish(bootWait.id, [{ name: 'build', state: 'PENDING', link: '', bucket: 'pending' }]);
    registries.docs.publish(docsWait.id, [{ name: 'build', state: 'PENDING', link: '', bucket: 'pending' }]);
    const boot = await subscribe('boot');
    const docs = await subscribe('docs');
    expect([registries.boot.wanted(bootWait.id), registries.docs.wanted(docsWait.id)]).toEqual([true, true]);

    hub.close();
    // The subscribers still hold their demand, but no registry reads it any more.
    expect([registries.boot.wanted(bootWait.id), registries.docs.wanted(docsWait.id)]).toEqual([false, false]);
    registries.boot.publish(bootWait.id, [{ name: 'build', state: 'SUCCESS', link: '', bucket: 'pass' }]);
    await vi.advanceTimersByTimeAsync(ACTIVITY_COALESCE_MS);
    expect(boot.frames).toEqual([]); // nor wakes a publisher
    boot.stop();
    docs.stop();
  });

  it('plugs nothing for a first read that finishes after the server closed', async () => {
    const wait = makePrWait();
    const { registries, hub, families, hold } = wire({ boot: [makeRoot({ status: RUN_STATUS.waiting, waits: [wait] })] });
    registries.boot.publish(wait.id, [{ name: 'build', state: 'PENDING', link: '', bucket: 'pending' }]);
    const publisher = (await families.get(ACTIVITY_PROJECT_TOPIC_PREFIX)!('boot'))!;
    const frames: ActivitySnapshot[] = [];
    const stop = publisher.start((data) => frames.push(data as ActivitySnapshot));

    const release = hold();
    const reading = publisher.snapshot();
    hub.close();
    release();
    await reading;
    // The subscriber holds demand for the project, but the registry never got it.
    expect(registries.boot.wanted(wait.id)).toBe(false);
    registries.boot.publish(wait.id, [{ name: 'build', state: 'SUCCESS', link: '', bucket: 'pass' }]);
    await vi.advanceTimersByTimeAsync(ACTIVITY_COALESCE_MS);
    expect(frames).toEqual([]);
    stop();
  });

  it('marks no demand for an HTTP read that answers after the server closed', async () => {
    const { hub, hold, demand, app } = wire({ boot: [makeRoot({ status: RUN_STATUS.running })] });
    const release = hold();
    const answer = app.request('/workspace/activity?project=boot');
    await vi.advanceTimersByTimeAsync(0);
    hub.close();
    release();
    expect((await answer).status).toBe(200);
    expect(demand.has('boot')).toBe(false);
  });
});
