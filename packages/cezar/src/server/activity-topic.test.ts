import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ActivitySnapshot } from '@open-mercato/cezar-contract';
import { fakeStore, makeRoot } from '../activity/activity.testkit.ts';
import { ActivityDemand } from '../activity/demand.ts';
import { createActivitySources, type LoadedProject } from './activity-sources.ts';
import { projectEventOf, type ProjectEvent } from './activity-project-topic.ts';
import { ACTIVITY_PROJECT_TOPIC_PREFIX, ACTIVITY_WORKSPACE_TOPIC, registerActivityTopics } from './activity-topic.ts';
import { ProjectContextError } from './project-context.ts';
import type { SocketHub, TopicFamilyResolver, TopicOptions, TopicPublisher } from './ws.ts';

function project(id: string, title: string): LoadedProject {
  const store = Object.assign(new EventEmitter(), fakeStore([makeRoot({ title })]));
  return { id, root: `/repos/${id}`, store, manager: { isActive: () => false } } as unknown as LoadedProject;
}

function wire() {
  const boot = project('boot', 'Boot task');
  const loaded = new Map<string, LoadedProject>();
  /** Ids whose context cannot build now: a store that cannot open (503). */
  const failing = new Set<string>();
  const registry = [{ id: 'boot', name: 'Boot' }, { id: 'docs', name: 'Docs' }];
  // While held, every source read waits: a test can land a registry event in the middle of one.
  let gate: Promise<void> | undefined;
  const hold = () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    return () => { gate = undefined; release(); };
  };
  const workspaceProjects = {
    listProjects: async () => { await gate; return registry as never; },
    resolveBootProject: async () => 'boot',
    projectFailure: (error: unknown) => error instanceof ProjectContextError && error.reason === 'unknown-project'
      ? { error: error.message, status: 404 as const }
      : { error: 'unavailable', status: 503 as const },
    resolveLiveProject: async (id: string): Promise<LoadedProject> => {
      if (id === 'default' || id === 'boot') return boot;
      if (failing.has(id)) throw new Error(`store of ${id} cannot open`);
      const found = loaded.get(id);
      if (!found) throw new ProjectContextError('unknown-project', id);
      return found;
    },
  };
  const topics = new Map<string, { publisher: TopicPublisher; options?: TopicOptions | undefined }>();
  const families = new Map<string, { resolve: TopicFamilyResolver; options?: TopicOptions | undefined }>();
  const hub: SocketHub = {
    registerTopic: (name, publisher, options) => { topics.set(name, { publisher, options }); },
    registerTopicFamily: (prefix, resolve, options) => { families.set(prefix, { resolve, options }); },
    handleUpgrade: () => undefined,
    close: () => undefined,
    onClose: () => () => undefined,
  };
  const scopeListeners = new Set<() => void>();
  const projectListeners = new Set<(event: ProjectEvent, projectId: string) => void>();
  const demand = new ActivityDemand();
  registerActivityTopics(hub, {
    sources: createActivitySources({ bootContext: boot, contexts: { peek: (id) => loaded.get(id) }, workspaceProjects }),
    workspaceProjects,
    demand,
    publisher: {},
    onProjectsChange: (listener) => { scopeListeners.add(listener); return () => scopeListeners.delete(listener); },
    onProjectEvent: (listener) => { projectListeners.add(listener); return () => projectListeners.delete(listener); },
  });
  const emit = (event: ProjectEvent, projectId: string) => { for (const listener of [...projectListeners]) listener(event, projectId); };
  return { topics, families, demand, loaded, failing, scopeListeners, projectListeners, emit, hold };
}

describe('the activity topics', () => {
  it('register for trusted connections only', () => {
    const { topics, families } = wire();
    expect(topics.get(ACTIVITY_WORKSPACE_TOPIC)?.options?.loopbackReadable).toBeUndefined();
    expect(families.get(ACTIVITY_PROJECT_TOPIC_PREFIX)?.options?.loopbackReadable).toBeUndefined();
  });

  it('resolve a project id the workspace knows, alias included, and nothing else', async () => {
    const { families, demand } = wire();
    const resolve = families.get(ACTIVITY_PROJECT_TOPIC_PREFIX)!.resolve;
    expect(await resolve('nope')).toBeUndefined();

    const publisher = (await resolve('default'))!;
    const stop = publisher.start(() => undefined);
    const snapshot = await publisher.snapshot() as ActivitySnapshot;
    expect(snapshot.projects.map((entry) => [entry.projectId, entry.name, entry.tasks.map((task) => task.title)])).toEqual([['boot', 'Boot', ['Boot task']]]);
    expect(demand.has('boot')).toBe(true); // demand under the canonical id, for the CI progress registry
    stop();
    expect(demand.has('boot')).toBe(false);
  });

  it('cover every visible project in the workspace topic and follow the projects that load', async () => {
    const { topics, demand, loaded, scopeListeners } = wire();
    const publisher = topics.get(ACTIVITY_WORKSPACE_TOPIC)!.publisher;
    let published!: (snapshot: ActivitySnapshot) => void;
    const frame = new Promise<ActivitySnapshot>((resolve) => { published = resolve; });
    const stop = publisher.start((data) => published(data as ActivitySnapshot));
    const first = await publisher.snapshot() as ActivitySnapshot;
    expect(first.projects.map((entry) => [entry.projectId, entry.loaded])).toEqual([['boot', true], ['docs', false]]);
    expect(demand.has('docs')).toBe(true);

    loaded.set('docs', project('docs', 'Docs task'));
    for (const listener of scopeListeners) listener();
    expect((await frame).projects[1]?.tasks.map((task) => task.title)).toEqual(['Docs task']);
    stop();
    expect(scopeListeners.size).toBe(0);
  });

  it('stop the work of a removed project, say so once, and follow its re-added context', async () => {
    const { families, demand, loaded, emit, projectListeners } = wire();
    const before = project('docs', 'Old task');
    loaded.set('docs', before);
    const publisher = (await families.get(ACTIVITY_PROJECT_TOPIC_PREFIX)!.resolve('docs'))!;
    const frames: ActivitySnapshot[] = [];
    let next!: () => void;
    const stop = publisher.start((data) => { frames.push(data as ActivitySnapshot); next?.(); });
    await publisher.snapshot();
    const store = (context: LoadedProject) => context.store as unknown as EventEmitter;
    expect(store(before).listenerCount('run')).toBe(1);
    expect(demand.has('docs')).toBe(true);

    loaded.delete('docs');
    emit('removed', 'docs');
    expect(frames.map((frame) => frame.projects[0]!.unavailable)).toEqual([{ status: 404, error: expect.stringContaining('docs') }]);
    expect(frames[0]!.projects[0]!.name).toBe('Docs');
    expect(store(before).listenerCount('run')).toBe(0);
    expect(demand.has('docs')).toBe(false);
    emit('removed', 'docs');
    expect(frames).toHaveLength(1);
    expect(await publisher.snapshot()).toMatchObject({ projects: [{ unavailable: { status: 404 } }] });

    const after = project('docs', 'New task');
    loaded.set('docs', after);
    const rebound = new Promise<void>((resolve) => { next = resolve; });
    emit('added', 'docs');
    await rebound;
    expect(frames.at(-1)!.projects[0]!.tasks.map((task) => task.title)).toEqual(['New task']);
    expect(store(after).listenerCount('run')).toBe(1);
    expect(demand.has('docs')).toBe(true);

    stop();
    expect(store(after).listenerCount('run')).toBe(0);
    expect(demand.has('docs')).toBe(false);
    expect(projectListeners.size).toBe(0);
  });

  it('reads the registry events off the workspace bus', () => {
    expect(projectEventOf('project-removed', { id: 'docs' })).toEqual({ event: 'removed', projectId: 'docs' });
    expect(projectEventOf('project-added', { project: { id: 'docs', name: 'Docs' } })).toEqual({ event: 'added', projectId: 'docs' });
    expect(projectEventOf('project-ready', { project: 'docs' })).toEqual({ event: 'ready', projectId: 'docs' });
    expect(projectEventOf('checkout-progress', { project: 'docs' })).toBeUndefined();
    expect(projectEventOf('project-removed', {})).toBeUndefined();
  });

  it('never lets a snapshot read before a removal answer after it', async () => {
    const { families, loaded, emit, hold } = wire();
    loaded.set('docs', project('docs', 'Old task'));
    const publisher = (await families.get(ACTIVITY_PROJECT_TOPIC_PREFIX)!.resolve('docs'))!;
    const frames: ActivitySnapshot[] = [];
    const stop = publisher.start((data) => frames.push(data as ActivitySnapshot));
    await publisher.snapshot();

    // A second subscriber's snapshot is still reading when the registry removes the project.
    const release = hold();
    const reading = publisher.snapshot() as Promise<ActivitySnapshot>;
    loaded.delete('docs');
    emit('removed', 'docs');
    release();
    expect((await reading).projects[0]).toMatchObject({ unavailable: { status: 404 }, tasks: [] });
    expect(frames.map((frame) => frame.projects[0]!.unavailable?.status)).toEqual([404]);
    stop();
  });

  it('drops a re-add whose first snapshot is still reading when the project is removed again', async () => {
    const { families, demand, loaded, emit, hold } = wire();
    loaded.set('docs', project('docs', 'Old task'));
    const publisher = (await families.get(ACTIVITY_PROJECT_TOPIC_PREFIX)!.resolve('docs'))!;
    const frames: ActivitySnapshot[] = [];
    const stop = publisher.start((data) => frames.push(data as ActivitySnapshot));
    await publisher.snapshot();
    loaded.delete('docs');
    emit('removed', 'docs');

    const again = project('docs', 'New task');
    loaded.set('docs', again);
    const release = hold();
    emit('added', 'docs');
    await new Promise<void>((resolve) => setImmediate(resolve)); // the re-add resolves and starts its first read
    loaded.delete('docs');
    emit('removed', 'docs');
    release();
    await new Promise<void>((resolve) => setImmediate(resolve)); // the stale read finishes
    expect(frames.map((frame) => frame.projects[0]!.unavailable?.status)).toEqual([404, 404]);
    expect(await publisher.snapshot()).toMatchObject({ projects: [{ unavailable: { status: 404 } }] });
    expect((again.store as unknown as EventEmitter).listenerCount('run')).toBe(0);
    expect(demand.has('docs')).toBe(false);
    stop();
  });

  it('says why a re-add cannot resolve, and binds when the project gets ready', async () => {
    const { families, demand, loaded, failing, emit } = wire();
    loaded.set('docs', project('docs', 'Old task'));
    const publisher = (await families.get(ACTIVITY_PROJECT_TOPIC_PREFIX)!.resolve('docs'))!;
    const frames: ActivitySnapshot[] = [];
    let next: (() => void) | undefined;
    const stop = publisher.start((data) => { frames.push(data as ActivitySnapshot); next?.(); });
    await publisher.snapshot();
    loaded.delete('docs');
    emit('removed', 'docs');

    // Re-added, but its store cannot open yet: the frame says 503, not 404.
    const again = project('docs', 'New task');
    loaded.set('docs', again);
    failing.add('docs');
    let failed = new Promise<void>((resolve) => { next = resolve; });
    emit('added', 'docs');
    await failed;
    expect(frames.map((frame) => frame.projects[0]!.unavailable?.status)).toEqual([404, 503]);

    // The context builds later: the topic binds without any subscriber leaving.
    failing.delete('docs');
    failed = new Promise<void>((resolve) => { next = resolve; });
    emit('ready', 'docs');
    await failed;
    expect(frames.at(-1)!.projects[0]).toMatchObject({ loaded: true, tasks: [{ title: 'New task' }] });
    expect(frames.at(-1)!.projects[0]!.unavailable).toBeUndefined();
    expect(demand.has('docs')).toBe(true);
    stop();
  });

  it('retries a failed resolution once for a new subscriber', async () => {
    const { families, loaded, failing, emit } = wire();
    loaded.set('docs', project('docs', 'Old task'));
    const publisher = (await families.get(ACTIVITY_PROJECT_TOPIC_PREFIX)!.resolve('docs'))!;
    const frames: ActivitySnapshot[] = [];
    let next: (() => void) | undefined;
    const stop = publisher.start((data) => { frames.push(data as ActivitySnapshot); next?.(); });
    await publisher.snapshot();
    loaded.delete('docs');
    emit('removed', 'docs');
    loaded.set('docs', project('docs', 'New task'));
    failing.add('docs');
    const failed = new Promise<void>((resolve) => { next = resolve; });
    emit('added', 'docs');
    await failed;

    failing.delete('docs');
    const second = await publisher.snapshot() as ActivitySnapshot;
    expect(second.projects[0]).toMatchObject({ loaded: true, tasks: [{ title: 'New task' }] });
    expect(frames.at(-1)!.projects[0]).toMatchObject({ tasks: [{ title: 'New task' }] });
    stop();
  });

  it('follows a known project whose store fails at the first subscribe until it gets ready', async () => {
    const { families, demand, loaded, failing, emit } = wire();
    loaded.set('docs', project('docs', 'Docs task'));
    failing.add('docs');
    const publisher = await families.get(ACTIVITY_PROJECT_TOPIC_PREFIX)!.resolve('docs');
    expect(publisher).toBeDefined(); // a known project names a topic even while it cannot resolve
    const frames: ActivitySnapshot[] = [];
    let next: (() => void) | undefined;
    const stop = publisher!.start((data) => { frames.push(data as ActivitySnapshot); next?.(); });
    const first = await publisher!.snapshot() as ActivitySnapshot;
    expect(first.projects[0]).toMatchObject({ projectId: 'docs', loaded: true, unavailable: { status: 503 }, tasks: [] });
    expect(demand.has('docs')).toBe(false);

    failing.delete('docs');
    const ready = new Promise<void>((resolve) => { next = resolve; });
    emit('ready', 'docs');
    await ready;
    expect(frames.at(-1)!.projects[0]).toMatchObject({ loaded: true, tasks: [{ title: 'Docs task' }] });
    expect(frames.at(-1)!.projects[0]!.unavailable).toBeUndefined();
    expect(demand.has('docs')).toBe(true);
    stop();
  });
});
