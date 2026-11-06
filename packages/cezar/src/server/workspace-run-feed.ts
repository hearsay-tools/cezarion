import { createHash } from 'node:crypto';
import { toRunSummary, type ProcessUsage, type RunSummary } from '@open-mercato/cezar-contract/runs';
import type { RunRecord } from '../runs/store.ts';
import type { ProjectContext } from './project-context.ts';

/**
 * The one run feed behind every `GET /api/v1/workspace/events` connection
 * (hearsay-tools/cezarion#2730).
 *
 * It subscribes once to each project store instead of once per connection, numbers every run
 * change and deletion with one process-wide `seq`, and builds each frame's text at most once per
 * mode: the legacy full record for connections without `?runs=summary`, the list row for the
 * others. Connections only write the cached text.
 *
 * Attachment follows the rules the stream had per connection: the boot store under the registry
 * id the connection resolved, every context already built, and each context built later. A
 * removed project is detached, so a project removed and re-added on the same slug attaches its
 * fresh context instead of the disposed one.
 */
export type WorkspaceRunFeedMode = 'full' | 'summary';

/** Writes one SSE frame. The caller owns the stream; the feed never awaits it. */
export type WorkspaceFrameWriter = (event: string, data: string) => void;

/** What the feed reads off a project store: its `run` and `deleted` events, and run ownership. */
export interface FeedStore {
  on(event: 'run', listener: (run: RunRecord) => void): unknown;
  on(event: 'deleted', listener: (id: string) => void): unknown;
  off(event: 'run', listener: (run: RunRecord) => void): unknown;
  off(event: 'deleted', listener: (id: string) => void): unknown;
  getRun(id: string): RunRecord | undefined;
}

export interface WorkspaceRunFeedDeps {
  bootStore: FeedStore;
  contexts: {
    ids(): string[];
    peek(projectId: string): { id: string; store: FeedStore } | undefined;
    onContextBuilt(listener: (ctx: Pick<ProjectContext, 'id' | 'store'>) => void): () => void;
  };
  /** Subscribes to workspace bus events; the feed only reads `project-removed`. */
  onWorkspaceEvent(listener: (event: string, data: unknown) => void): () => void;
  onUsage(listener: (usage: Record<string, ProcessUsage>) => void): () => void;
  /** The latest sample of every sampled run (`allUsage`). */
  allUsage(): Record<string, ProcessUsage>;
  /** A list row with its live usage sample, exactly as `/workspace/runs-index` returns it. */
  withLiveUsage(summary: RunSummary): RunSummary;
}

export interface WorkspaceRunFeed {
  /** The last `seq` assigned. `/workspace/runs-index` answers it as `eventSeq`. */
  seq(): number;
  /**
   * Attach one connection, synchronously, so the caller can write `ready` with `seq()` before any
   * later frame. `bootProject` is the boot project's registry id as this connection resolved it.
   * Returns the detach.
   */
  connect(bootProject: string, mode: WorkspaceRunFeedMode, write: WorkspaceFrameWriter): () => void;
}

/**
 * The fields the relationships route renders for a run and for its parent: status, current step,
 * delegation role, parent, worker workspace, destroy state and its retries, execution revision,
 * the root's receipt count (its capacity) and the run's wait phases. Equal digests mean that a
 * refetch of `/runs/:id/relationships` would answer the same.
 */
export function relationshipsDigest(run: RunRecord): string {
  const delegation = run.delegation;
  const shape = [
    run.status,
    run.currentStepId ?? null,
    delegation?.role ?? null,
    delegation?.role === 'worker' ? [
      delegation.parentRunId, delegation.workspace, delegation.destroy ?? null,
      delegation.executionRevision ?? null, run.destroyRetry ?? null,
    ] : null,
    delegation?.role === 'root' ? [delegation.receipts.length, delegation.wait?.phase ?? null] : null,
    (Array.isArray(run.waits) ? run.waits : []).map((wait) => [wait.id, wait.phase]),
  ];
  return createHash('sha1').update(JSON.stringify(shape)).digest('base64url').slice(0, 16);
}

export function createWorkspaceRunFeed(deps: WorkspaceRunFeedDeps): WorkspaceRunFeed {
  const attached = new Map<string, { store: FeedStore; detach: () => void }>();
  const connections = new Set<{ mode: WorkspaceRunFeedMode; write: WorkspaceFrameWriter }>();
  /** Projects whose last usage frame carried rows. Summary mode clears each one once. */
  let liveProjects = new Set<string>();
  let bootAttachedAs: string | undefined;
  let started = false;
  /** The sampler is module-global: hold its subscription only while a connection reads it. */
  let offUsage: (() => void) | undefined;
  let seq = 0;

  const ownedUsage = (store: FeedStore, usage: Record<string, ProcessUsage>): Record<string, ProcessUsage> => {
    const owned: Record<string, ProcessUsage> = {};
    for (const [runId, sample] of Object.entries(usage)) {
      if (store.getRun(runId)) owned[runId] = sample;
    }
    return owned;
  };

  const broadcast = (frames: Record<WorkspaceRunFeedMode, () => [string, string] | undefined>): void => {
    const text: Partial<Record<WorkspaceRunFeedMode, [string, string] | undefined>> = {};
    for (const connection of connections) {
      if (!(connection.mode in text)) text[connection.mode] = frames[connection.mode]();
      const frame = text[connection.mode];
      if (frame) connection.write(frame[0], frame[1]);
    }
  };

  /** Summary mode: a project whose last sampled run just stopped gets one empty `usage`. */
  const clearStoppedUsage = (project: string, store: FeedStore): void => {
    if (!liveProjects.has(project)) return;
    if (Object.keys(ownedUsage(store, deps.allUsage())).length > 0) return;
    liveProjects.delete(project);
    const data = JSON.stringify({ project, usage: {} });
    broadcast({ full: () => undefined, summary: () => ['usage', data] });
  };

  const attach = (project: string, store: FeedStore): void => {
    if (attached.has(project)) return;
    const onRun = (run: RunRecord): void => {
      seq += 1;
      const current = seq;
      broadcast({
        full: () => ['run', JSON.stringify({ ...run, project })],
        summary: () => ['run-summary', JSON.stringify({
          project, seq: current, run: deps.withLiveUsage(toRunSummary(run)), relationships: relationshipsDigest(run),
        })],
      });
      clearStoppedUsage(project, store);
    };
    const onDeleted = (id: string): void => {
      seq += 1;
      const current = seq;
      broadcast({
        full: () => ['run-deleted', JSON.stringify({ id, project })],
        summary: () => ['run-deleted', JSON.stringify({ project, seq: current, id })],
      });
    };
    store.on('run', onRun);
    store.on('deleted', onDeleted);
    attached.set(project, {
      store,
      detach: () => {
        store.off('run', onRun);
        store.off('deleted', onDeleted);
      },
    });
  };

  const detach = (project: string): void => {
    attached.get(project)?.detach();
    attached.delete(project);
    liveProjects.delete(project);
  };

  // `usage` is split per attached project, never a stamped whole. The legacy mode sends one frame
  // per project with live rows and nothing for the others; the summary mode also sends one empty
  // frame when a project's rows stop.
  const onUsageTick = (usage: Record<string, ProcessUsage>): void => {
    const next = new Set<string>();
    for (const [project, { store }] of attached) {
      const owned = ownedUsage(store, usage);
      const live = Object.keys(owned).length > 0;
      if (live) next.add(project);
      else if (!liveProjects.has(project)) continue;
      const data = JSON.stringify({ project, usage: owned });
      broadcast({ full: () => (live ? ['usage', data] : undefined), summary: () => ['usage', data] });
    }
    liveProjects = next;
  };

  const start = (): void => {
    started = true;
    for (const id of deps.contexts.ids()) {
      const ctx = deps.contexts.peek(id);
      if (ctx) attach(ctx.id, ctx.store);
    }
    deps.contexts.onContextBuilt((ctx) => attach(ctx.id, ctx.store));
    deps.onWorkspaceEvent((event, data) => {
      if (event !== 'project-removed') return;
      const removed = (data as { id?: unknown } | null)?.id;
      if (typeof removed === 'string') detach(removed);
    });
  };

  /** The boot store lives under the registry id its connection resolved, and under one id only. */
  const attachBoot = (bootProject: string): void => {
    if (bootAttachedAs !== undefined && bootAttachedAs !== bootProject && attached.get(bootAttachedAs)?.store === deps.bootStore) {
      detach(bootAttachedAs);
    }
    bootAttachedAs = bootProject;
    attach(bootProject, deps.bootStore);
  };

  return {
    seq: () => seq,
    connect(bootProject, mode, write) {
      // Boot first, as the stream always attached it, then every context already built.
      attachBoot(bootProject);
      if (!started) start();
      const connection = { mode, write };
      connections.add(connection);
      offUsage ??= deps.onUsage(onUsageTick);
      return () => {
        connections.delete(connection);
        if (connections.size > 0) return;
        offUsage?.();
        offUsage = undefined;
      };
    },
  };
}
