import { z } from 'zod';
import type { ActivityProject, ActivitySnapshot } from '@open-mercato/cezar-contract';
import type { ActivityDemand } from '../activity/demand.ts';
import { createActivityPublisher, type ActivityPublisherDeps } from '../activity/publisher.ts';
import type { createActivitySources, LoadedProject } from './activity-sources.ts';
import type { TopicPublisher } from './ws.ts';

/** A change to the project registry: a project added or removed. */
export type ProjectEvent = 'added' | 'removed';

const removedSchema = z.object({ id: z.string() });
const addedSchema = z.object({ project: z.object({ id: z.string() }) });

/** The project a workspace bus event adds or removes (`project-added` carries the registry
 *  entry, `project-removed` its id); undefined for every other event. */
export function projectEventOf(event: string, data: unknown): { event: ProjectEvent; projectId: string } | undefined {
  if (event === 'project-removed') {
    const parsed = removedSchema.safeParse(data);
    return parsed.success ? { event: 'removed', projectId: parsed.data.id } : undefined;
  }
  if (event === 'project-added') {
    const parsed = addedSchema.safeParse(data);
    return parsed.success ? { event: 'added', projectId: parsed.data.project.id } : undefined;
  }
  return undefined;
}

export interface ProjectTopicDeps {
  sources: ReturnType<typeof createActivitySources>;
  demand: ActivityDemand;
  publisher: ActivityPublisherDeps;
  /** The current context of a project id; rejects when the workspace cannot resolve it. */
  resolve(projectId: string): Promise<LoadedProject>;
  /** The failure the project routes answer for a removed project (404). */
  removed(projectId: string): NonNullable<ActivityProject['unavailable']>;
  onProjectEvent(listener: (event: ProjectEvent, projectId: string) => void): () => void;
}

interface Session {
  publish: (data: unknown) => void;
  /** Stops the publisher bound to the current context; undefined while the project is removed. */
  stopBound: (() => void) | undefined;
  /** Bumped by every registry event, so a re-add that resolves late cannot undo a later removal. */
  generation: number;
  offEvents: () => void;
}

/**
 * The publisher of `activity:project:<id>`. It binds an activity publisher to the project's
 * current context. When the registry removes the project, it stops that publisher (its timers,
 * store listeners and demand) and sends subscribers one frame with the project unavailable (404).
 * When the registry adds the same id again, it binds a publisher to the new context and sends its
 * snapshot.
 */
export function createProjectTopicPublisher(initial: LoadedProject, deps: ProjectTopicDeps): TopicPublisher {
  const projectId = initial.id;
  let bound: TopicPublisher | undefined = bindTo(initial);
  let name = projectId;
  let session: Session | undefined;

  function bindTo(project: LoadedProject): TopicPublisher {
    return createActivityPublisher({
      sources: async () => [await deps.sources.project(project)],
      watch: () => deps.demand.watch(project.id),
    }, deps.publisher);
  }
  /** Keep the last known name for the removal frame: the registry no longer has it then. */
  const remember = (data: unknown): unknown => {
    name = (data as ActivitySnapshot).projects[0]?.name ?? name;
    return data;
  };
  const removedSnapshot = (): ActivitySnapshot => ({
    generatedAt: new Date((deps.publisher.now ?? Date.now)()).toISOString(),
    projects: [{ projectId, name, loaded: true, unavailable: deps.removed(projectId), inReview: 0, tasks: [], requests: [], closed: [] }],
  });

  const onRemoved = (current: Session): void => {
    current.generation++;
    if (!bound) return; // removed already: subscribers have its frame
    current.stopBound?.();
    current.stopBound = undefined;
    bound = undefined;
    current.publish(removedSnapshot());
  };
  const onAdded = (current: Session): void => {
    const generation = ++current.generation;
    const live = () => session === current && current.generation === generation;
    void deps.resolve(projectId).then(async (project) => {
      if (!live()) return;
      current.stopBound?.();
      const next = bindTo(project);
      bound = next;
      const stillBound = () => live() && bound === next;
      current.stopBound = next.start((data) => { if (stillBound()) current.publish(remember(data)); });
      const snapshot = await next.snapshot();
      // A removal while the first snapshot was read has sent its frame: this snapshot is stale.
      if (stillBound()) current.publish(remember(snapshot));
    }).catch(() => undefined); // still unknown: the removal frame stands
  };

  return {
    /** A new subscriber's frame. A removal or re-add while it is read makes it stale: read the
     *  binding that is current then instead. */
    async snapshot() {
      for (;;) {
        const binding = bound;
        if (!binding) return removedSnapshot();
        const snapshot = await binding.snapshot();
        if (bound === binding) return remember(snapshot);
      }
    },
    start(publish) {
      const first = bound;
      const current: Session = { publish, stopBound: undefined, generation: 0, offEvents: () => undefined };
      session = current;
      current.stopBound = first?.start((data) => { if (session === current && bound === first) publish(remember(data)); });
      current.offEvents = deps.onProjectEvent((event, id) => {
        if (session !== current || id !== projectId) return;
        if (event === 'removed') onRemoved(current);
        else onAdded(current);
      });
      return () => {
        if (session === current) session = undefined;
        current.offEvents();
        current.stopBound?.();
      };
    },
  };
}
