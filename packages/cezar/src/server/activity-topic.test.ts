import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ActivitySnapshot } from '@open-mercato/cezar-contract';
import { fakeStore, makeRoot } from '../activity/activity.testkit.ts';
import { ActivityDemand } from '../activity/demand.ts';
import { createActivitySources, type LoadedProject } from './activity-sources.ts';
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
  const registry = [{ id: 'boot', name: 'Boot' }, { id: 'docs', name: 'Docs' }];
  const workspaceProjects = {
    listVisibleProjects: async () => registry as never,
    resolveBootProject: async () => 'boot',
    projectFailure: () => ({ error: 'unavailable', status: 503 as const }),
    resolveLiveProject: async (id: string): Promise<LoadedProject> => {
      if (id === 'default' || id === 'boot') return boot;
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
  };
  const scopeListeners = new Set<() => void>();
  const demand = new ActivityDemand();
  registerActivityTopics(hub, {
    sources: createActivitySources({ bootContext: boot, contexts: { peek: (id) => loaded.get(id) }, workspaceProjects }),
    workspaceProjects,
    demand,
    publisher: {},
    onProjectsChange: (listener) => { scopeListeners.add(listener); return () => scopeListeners.delete(listener); },
  });
  return { topics, families, demand, loaded, scopeListeners };
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
});
