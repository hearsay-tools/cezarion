import { z } from 'zod';
import type { ActivityProject, ActivitySnapshot } from '@open-mercato/cezar-contract';
import type { ActivityDemand } from '../activity/demand.ts';
import { createActivityPublisher, type ActivityPublisherDeps } from '../activity/publisher.ts';
import type { createActivitySources, LoadedProject } from './activity-sources.ts';
import type { TopicPublisher } from './ws.ts';

/** A change to a project: added to or removed from the registry, or its context built (ready). */
export type ProjectEvent = 'added' | 'removed' | 'ready';

const removedSchema = z.object({ id: z.string() });
const addedSchema = z.object({ project: z.object({ id: z.string() }) });
const readySchema = z.object({ project: z.string() });

/** The project a workspace bus event names (`project-added` carries the registry entry,
 *  `project-removed` its id, `project-ready` the built context's id); undefined for every other
 *  event. */
export function projectEventOf(event: string, data: unknown): { event: ProjectEvent; projectId: string } | undefined {
  if (event === 'project-removed') {
    const parsed = removedSchema.safeParse(data);
    return parsed.success ? { event: 'removed', projectId: parsed.data.id } : undefined;
  }
  if (event === 'project-added') {
    const parsed = addedSchema.safeParse(data);
    return parsed.success ? { event: 'added', projectId: parsed.data.project.id } : undefined;
  }
  if (event === 'project-ready') {
    const parsed = readySchema.safeParse(data);
    return parsed.success ? { event: 'ready', projectId: parsed.data.project } : undefined;
  }
  return undefined;
}

export interface ProjectTopicDeps {
  sources: ReturnType<typeof createActivitySources>;
  demand: ActivityDemand;
  publisher: ActivityPublisherDeps;
  /** The current context of a project id; rejects when the workspace cannot resolve it. */
  resolve(projectId: string): Promise<LoadedProject>;
  /** The failure the project routes answer for `error`: 404 for a removed project, 409 or 503
   *  for a context that cannot build now (`projectFailure`). */
  failure(error: unknown, projectId: string): Unavailable;
  /** The error a removal stands for. */
  removedError(projectId: string): unknown;
  onProjectEvent(listener: (event: ProjectEvent, projectId: string) => void): () => void;
}

type Unavailable = NonNullable<ActivityProject['unavailable']>;

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
 * While unbound it resolves the id again when the registry adds it, when its context gets built
 * (`project-ready`), and once for each new subscriber. A success binds a publisher to the new
 * context and sends its snapshot; a failure sends the project unavailable with the status the
 * project routes answer (`projectFailure`), once for each change of that status or error.
 */
export function createProjectTopicPublisher(initial: LoadedProject, deps: ProjectTopicDeps): TopicPublisher {
  const projectId = initial.id;
  let bound: TopicPublisher | undefined = bindTo(initial);
  let name = projectId;
  let session: Session | undefined;
  /** Why the project is unbound; undefined while bound. */
  let unavailable: Unavailable | undefined;

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
  const unavailableSnapshot = (reason: Unavailable): ActivitySnapshot => ({
    generatedAt: new Date((deps.publisher.now ?? Date.now)()).toISOString(),
    projects: [{ projectId, name, loaded: true, unavailable: reason, inReview: 0, tasks: [], requests: [], closed: [] }],
  });
  /** Unbind for `reason`, and tell subscribers when the reason changed. */
  const unbind = (current: Session, reason: Unavailable): void => {
    current.stopBound?.();
    current.stopBound = undefined;
    bound = undefined;
    const changed = unavailable?.status !== reason.status || unavailable.error !== reason.error;
    unavailable = reason;
    if (changed) current.publish(unavailableSnapshot(reason));
  };

  const onRemoved = (current: Session): void => {
    current.generation++;
    unbind(current, deps.failure(deps.removedError(projectId), projectId));
  };
  /** Resolve the id again; every await re-checks that no later event or binding superseded it. */
  const rebind = async (current: Session): Promise<void> => {
    const generation = ++current.generation;
    const live = () => session === current && current.generation === generation;
    let project: LoadedProject;
    try {
      project = await deps.resolve(projectId);
    } catch (error) {
      // A context that cannot build now: say why, and keep a working binding if one exists.
      if (live() && !bound) unbind(current, deps.failure(error, projectId));
      return;
    }
    if (!live()) return;
    current.stopBound?.();
    const next = bindTo(project);
    bound = next;
    unavailable = undefined;
    const stillBound = () => live() && bound === next;
    current.stopBound = next.start((data) => { if (stillBound()) current.publish(remember(data)); });
    const snapshot = await next.snapshot();
    // A removal while the first snapshot was read has sent its frame: this snapshot is stale.
    if (stillBound()) current.publish(remember(snapshot));
  };

  return {
    /** A new subscriber's frame. A removal or re-add while it is read makes it stale: read the
     *  binding that is current then instead. */
    async snapshot() {
      if (!bound && session) await rebind(session).catch(() => undefined);
      for (;;) {
        const binding = bound;
        if (!binding) return unavailableSnapshot(unavailable ?? deps.failure(deps.removedError(projectId), projectId));
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
        // `ready` builds a context for an id that may now resolve; a bound topic has its context.
        else if (event === 'added' || !bound) void rebind(current).catch(() => undefined);
      });
      return () => {
        if (session === current) session = undefined;
        current.offEvents();
        current.stopBound?.();
      };
    },
  };
}
