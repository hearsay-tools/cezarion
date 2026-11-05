import type { ActivityProject, ActivityRun, ActivitySnapshot, ActivityTool, ActivityWorker, ConversationState } from '@open-mercato/cezar-contract';
import { ACTIVITY_ERROR_MAX, ACTIVITY_RATE_SECONDS } from '@open-mercato/cezar-contract/activity';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { isLiveStatus } from '@open-mercato/cezar-contract/run-predicates';
import { workerRevision } from '../delegation/results.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { readActivityRequests, type ActivityRequestStore } from './requests.ts';
import { firstLine } from './text.ts';
import { activityWait, type CiProgressSource } from './wait.ts';

export type { CiProgressSource } from './wait.ts';

/** A run's latest tool call and its tool-call rate. The tool activity tracker implements it. */
export interface ToolActivitySource {
  read(runId: string, now: number): { tool?: ActivityTool | undefined; rate: readonly number[] } | undefined;
}

/** What the read model needs from a project's run store. It reads; it never writes a run. */
export type ActivityStore = ActivityRequestStore & Pick<RunStore, 'listRunSummaries' | 'listOwnedWorkers' | 'withReadCache'>;

/** One project to read: its store and run manager when this process has loaded it. */
export interface ActivityProjectSource {
  projectId: string;
  name: string;
  loaded?: { store: ActivityStore; isActive: (runId: string) => boolean } | undefined;
  /** A loaded project whose run store cannot open. */
  unavailable?: ActivityProject['unavailable'];
}

export interface ActivityDeps {
  now?: () => number;
  tools?: ToolActivitySource;
  ci?: CiProgressSource;
  /** A run whose record could not be read, left out of the snapshot. */
  onUnreadable?: (projectId: string, runId: string) => void;
}

const noTools: ToolActivitySource = { read: () => undefined };
const noProgress: CiProgressSource = { read: () => undefined };

/** Log each unreadable run once per process, not on every read. */
export function unreadableLogger(log: (message: string) => void = console.warn): (projectId: string, runId: string) => void {
  const logged = new Set<string>();
  return (projectId, runId) => {
    const key = `${projectId}/${runId}`;
    if (logged.has(key)) return;
    logged.add(key);
    log(`[cez] run ${runId} of project ${projectId} could not be read; the activity view leaves it out`);
  };
}

export function buildActivitySnapshot(sources: readonly ActivityProjectSource[], deps: ActivityDeps = {}): ActivitySnapshot {
  const now = (deps.now ?? Date.now)();
  return { generatedAt: new Date(now).toISOString(), projects: sources.map((source) => buildActivityProject(source, deps, { now }).project) };
}

/**
 * One project's activity (spec 2026-11-05-live-activity-view, Read model). The cards are the
 * active roots (D8): root tasks that are queued, running or waiting, and any root with a live
 * worker, from the store's summaries. `carryOver` and `openLedgers` are the publisher's
 * carry-over of ledgers that held an open request.
 */
export function buildActivityProject(source: ActivityProjectSource, deps: ActivityDeps, options: { now: number; carryOver?: Iterable<string> }):
  { project: ActivityProject; openLedgers: Set<string> } {
  const empty = { projectId: source.projectId, name: source.name, inReview: 0, tasks: [], requests: [], closed: [] };
  if (source.unavailable) return { project: { ...empty, loaded: true, unavailable: source.unavailable }, openLedgers: new Set() };
  if (!source.loaded) return { project: { ...empty, loaded: false }, openLedgers: new Set() };
  const loaded = source.loaded;
  // One snapshot decodes each cold record once: claims, cards, workers, reconcile lookups and
  // request titles all read the same runs (hearsay-tools/cezarion#2378).
  return loaded.store.withReadCache(() => loadedProject(source.projectId, loaded, deps, options, empty));
}

function loadedProject(projectId: string, { store, isActive }: NonNullable<ActivityProjectSource['loaded']>, deps: ActivityDeps,
  options: { now: number; carryOver?: Iterable<string> }, empty: Omit<ActivityProject, 'loaded'>): { project: ActivityProject; openLedgers: Set<string> } {
  const { active, inReview } = activeRoots(store);
  const context: RunContext = { now: options.now, tools: deps.tools ?? noTools, ci: deps.ci ?? noProgress };
  const roots: RunRecord[] = [];
  for (const id of active) {
    const root = store.getRun(id);
    if (root && root.delegation?.role !== 'worker') roots.push(root);
    else if (!root && store.isUnreadable(id)) deps.onUnreadable?.(projectId, id);
  }
  const tasks = roots.sort(byCreation).map((root) => activityRoot(store, root, context));
  const read = readActivityRequests(store, { now: options.now, isActive, roots: active, ...(options.carryOver ? { carryOver: options.carryOver } : {}) });
  return { project: { ...empty, loaded: true, inReview, tasks, requests: read.requests, closed: read.closed }, openLedgers: read.openLedgers };
}

/** D8 from the store's summaries: live roots, and the parents of live workers. */
function activeRoots(store: ActivityStore): { active: Set<string>; inReview: number } {
  const active = new Set<string>();
  const parents = new Set<string>();
  let inReview = 0;
  for (const summary of store.listRunSummaries({ archivedWindow: 0 }).runs) {
    if (summary.delegation?.role === 'worker') {
      if (isLiveStatus(summary.status)) parents.add(summary.delegation.parentRunId);
      continue;
    }
    if (isLiveStatus(summary.status)) active.add(summary.id);
    if (summary.status === 'review') inReview++;
  }
  for (const id of parents) active.add(id);
  return { active, inReview };
}

const byCreation = (a: RunRecord, b: RunRecord) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

type RunContext = { now: number; tools: ToolActivitySource; ci: CiProgressSource };

function activityRoot(store: ActivityStore, root: RunRecord, context: RunContext): ActivityRun {
  const ledger = root.delegation?.role === 'root' ? root.delegation.conversation : undefined;
  const results = root.delegation?.role === 'root' ? root.delegation.results ?? [] : [];
  const workers = store.listOwnedWorkers(root.id).sort(byCreation)
    .map((worker): ActivityWorker => {
      const revision = workerRevision(worker);
      return { ...activityRunBase(worker, ledger, context), revision, collected: results.some((result) => result.workerId === worker.id && result.revision === revision) };
    });
  return { ...activityRunBase(root, ledger, context), workers };
}

function activityRunBase(run: RunRecord, ledger: ConversationState | undefined, context: RunContext): Omit<ActivityRun, 'workers'> {
  const activity = context.tools.read(run.id, context.now);
  const wait = activityWait(run, ledger, context.ci);
  const error = firstLine(run.error, ACTIVITY_ERROR_MAX);
  return {
    runId: run.id,
    title: run.titleSummary ?? run.title,
    status: run.status,
    rung: deriveAttention(run).rung,
    ...(run.runner === undefined ? {} : { runner: run.runner }),
    ...(run.model === undefined ? {} : { model: run.model }),
    ...(run.currentStepId === undefined ? {} : { currentStepId: run.currentStepId }),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(wait === undefined ? {} : { wait }),
    ...(activity?.tool === undefined ? {} : { tool: activity.tool }),
    rate: activity?.rate.length === ACTIVITY_RATE_SECONDS ? [...activity.rate] : Array.from({ length: ACTIVITY_RATE_SECONDS }, () => 0),
    ...(error === undefined ? {} : { error }),
  };
}
