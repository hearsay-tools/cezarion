import type { AutomationCoordinator } from './coordinator.ts';
import type { GithubCandidate, GithubPoller, GithubPollResult } from './github-poller.ts';
import { ScheduleRunner, type ScheduleLauncher } from './schedule-runner.ts';
import type { AutomationLease, AutomationStore } from './store.ts';
import { isGithubAutomation, isScheduleAutomation, type GithubAutomationDefinition } from './types.ts';

export interface AutomationLaunchResult { runId: string }
export type AutomationLauncher = (
  definition: GithubAutomationDefinition,
  candidate: GithubCandidate,
  receiptId: string,
) => Promise<AutomationLaunchResult>;

/**
 * Everything one project needs on the workspace timer. Every registered project gets one; only a
 * project with a github.com remote carries `github`, so its polls can fire — a schedule needs no
 * remote (spec 2026-10-02-scheduled-automations § Architecture).
 */
export interface ProjectAutomationHandle {
  projectId: string;
  store: AutomationStore;
  /** The zone schedules are evaluated in — the server's own (`localTimeZone()`). */
  timeZone: string;
  github?: { owner: string; repo: string; poller: GithubPoller };
  launch?: AutomationLauncher;
  launchSchedule?: ScheduleLauncher;
  onChange?: (automationId: string, revision: number) => void;
  now?: () => number;
  /** See `ScheduleRunnerHandle.reconcile`. */
  reconcileReceipts?: () => Promise<void>;
}

/** One request chain process-wide. The promise tail also prevents a failed request from
 * poisoning later projects. */
class GithubRequestArbiter {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.tail.then(operation, operation);
    this.tail = current.catch(() => undefined);
    return current;
  }
}
const githubRequests = new GithubRequestArbiter();

/** A different process currently owns this project's poll lock. */
export class LeaseHeldError extends Error {
  constructor() { super('automation polling lease is held by another process'); }
}

export class ProjectAutomationScheduler {
  constructor(private readonly handle: ProjectAutomationHandle) {}

  async check(definition: GithubAutomationDefinition, mode: 'preview' | 'execute' = 'execute'): Promise<GithubPollResult> {
    const { github } = this.handle;
    if (!github) throw new Error('No GitHub remote is configured');
    const detectionOnly = mode === 'execute' && !this.handle.launch;
    if (detectionOnly) mode = 'preview';
    const { store } = this.handle;
    const started = Date.now();
    let completion: { result: 'preview' | 'no-match'; reason: string } | undefined;
    let lease: AutomationLease | undefined;
    try {
      lease = store.acquireLease();
      if (!lease) throw new LeaseHeldError();
      const state = store.state(definition.id) ?? {};
      if (state.backoffUntil && Date.parse(state.backoffUntil) > Date.now()) {
        throw new Error(`automation is backed off until ${state.backoffUntil}`);
      }
      const since = state.cursor?.timestamp ?? state.baselineAt;
      const overlapSince = since
        ? new Date(Date.parse(since) - 120_000).toISOString()
        : undefined;
      const result = await githubRequests.run(() => github.poller.poll(
        github.owner,
        github.repo,
        definition,
        { since: overlapSince },
      ));
      const eligible = result.candidates.filter((candidate) => {
        if (state.baselineAt && candidate.timestamp <= state.baselineAt) return false;
        if (!state.cursor) return true;
        const overlap = Date.parse(state.cursor.timestamp) - 120_000;
        return Date.parse(candidate.timestamp) >= overlap;
      });
      if (mode === 'execute' && this.handle.launch) {
        for (const candidate of eligible) await this.launch(definition, candidate);
      }
      if (mode === 'execute') {
        const now = new Date().toISOString();
        const cursor = laterCursor(state.cursor, result.cursor);
        store.setState(definition.id, (current) => ({
          ...current,
          revision: definition.revision,
          cursor,
          frozenHighWatermark: result.truncated && cursor?.tieBreaker
            ? { timestamp: cursor.timestamp, tieBreaker: cursor.tieBreaker }
            : undefined,
          lastSuccessAt: now,
          nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1_000).toISOString(),
          consecutiveFailures: 0,
          backoffUntil: undefined,
        }));
      } else if (detectionOnly) {
        store.setState(definition.id, (current) => ({
          ...current,
          revision: definition.revision,
          nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1_000).toISOString(),
        }));
      }
      this.handle.onChange?.(definition.id, definition.revision);
      completion = mode === 'preview'
        ? { result: 'preview', reason: `Bounded preview found ${eligible.length} match${eligible.length === 1 ? '' : 'es'}; no tasks were launched.` }
        : { result: 'no-match', reason: 'Scheduled check completed.' };
      return { ...result, candidates: eligible };
    } catch (error) {
      if (error instanceof LeaseHeldError) await this.recordSkip(definition, error);
      else if (mode === 'execute') await this.recordFailure(definition, error);
      else await store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'error', reason: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      try {
        if (completion) await store.appendLog({ automationId: definition.id, revision: definition.revision, ...completion, durationMs: Date.now() - started });
        if (lease) {
          try { await store.maybeCompact(); } catch { /* append-only state remains readable; next check retries */ }
        }
      } finally {
        lease?.release();
      }
    }
  }

  private async launch(definition: GithubAutomationDefinition, candidate: GithubCandidate): Promise<void> {
    const receipt = this.handle.store.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId: candidate.eventId, candidate });
    if (!receipt) {
      await this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event, result: 'duplicate', reason: 'A durable receipt already exists for this automation and event.', githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
      return;
    }
    try {
      const launched = await this.handle.launch!(definition, candidate, receipt.receiptId);
      this.handle.store.appendReceipt({ ...receipt, status: 'launched', runId: launched.runId, updatedAt: new Date().toISOString() });
      await this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event, result: 'launched', receiptId: receipt.receiptId, runId: launched.runId, githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
    } catch (error) {
      this.handle.store.appendReceipt({ ...receipt, status: 'launch-error', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
      throw error;
    }
  }

  private async recordSkip(definition: GithubAutomationDefinition, error: LeaseHeldError): Promise<void> {
    const { store } = this.handle;
    await store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'skipped', reason: error.message });
    // The lease owner may be writing state. The workspace retry floor handles our next attempt.
    this.handle.onChange?.(definition.id, definition.revision);
  }

  private async recordFailure(definition: GithubAutomationDefinition, error: unknown): Promise<void> {
    this.handle.store.setState(definition.id, (current) => {
      const failures = (current.consecutiveFailures ?? 0) + 1;
      const delay = Math.min(6 * 60 * 60_000, 60_000 * 2 ** (failures - 1));
      return {
        ...current,
        consecutiveFailures: failures,
        backoffUntil: new Date(Date.now() + delay).toISOString(),
        nextCheckAt: new Date(Date.now() + delay).toISOString(),
      };
    });
    await this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'error', reason: error instanceof Error ? error.message : String(error) });
    this.handle.onChange?.(definition.id, definition.revision);
  }
}

function laterCursor(
  current: { timestamp: string; tieBreaker?: string } | undefined,
  observed: { timestamp: string; tieBreaker: string } | undefined,
): { timestamp: string; tieBreaker?: string } | undefined {
  if (!observed) return current;
  if (!current) return observed;
  const order = observed.timestamp.localeCompare(current.timestamp)
    || observed.tieBreaker.localeCompare(current.tieBreaker ?? '');
  return order > 0 ? observed : current;
}

const MIN_RETRY_MS = 60_000;

/**
 * The longest the workspace timer sleeps before it looks at the wall clock again. Node timers
 * count on a monotonic clock that stops while the machine is suspended, so one timer armed for
 * the whole distance to a weekly occurrence would wake days late after a laptop slept. A capped
 * wake that is not yet due re-arms without firing; the cap also keeps every delay far below
 * `setTimeout`'s 2^31 ms overflow.
 */
export const WORKSPACE_TIMER_CAP_MS = 60_000;

export interface WorkspaceAutomationSchedulerOptions {
  coordinator: AutomationCoordinator;
  handle: (projectId: string, store: AutomationStore) => ProjectAutomationHandle | undefined;
  now?: () => number;
}

/**
 * One workspace timer, running only while the scheduler is started (automations are opt-in) and at
 * least one project is registered with the coordinator. With nothing enabled it is an idle wake
 * at the cap, even before any project has a definitions file: every wake goes through
 * `reschedule`, whose coordinator refresh re-reads a store another cockpit changed and opens a
 * project whose definitions file appeared, so their edits arm here within one cap. No registered
 * project: no timer.
 */
export class WorkspaceAutomationScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private scheduleGeneration = 0;
  private readonly retryAfter = new Map<string, number>();
  constructor(private readonly options: WorkspaceAutomationSchedulerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.reschedule();
  }

  async reschedule(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.scheduleGeneration;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.options.coordinator.refresh();
    if (this.stopped || generation !== this.scheduleGeneration) return;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.scheduleGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  hasTimer(): boolean { return this.timer !== undefined; }

  private schedule(): void {
    if (this.stopped) return;
    const due: Array<{ key: string; at: number; retryAfterMs: number; fire: () => Promise<unknown> }> = [];
    const live = new Set<string>();
    for (const projectId of this.options.coordinator.enabledProjectIds()) {
      const store = this.options.coordinator.store(projectId);
      if (!store) continue;
      const handle = this.options.handle(projectId, store);
      if (!handle) continue;
      const enabled = store.list().filter((item) => item.enabled);
      // A poll needs the project's GitHub remote; without one it is never armed, not armed to fail.
      if (handle.github) {
        const scheduler = new ProjectAutomationScheduler(handle);
        for (const definition of enabled.filter(isGithubAutomation)) {
          const key = `${projectId}:${definition.id}`;
          live.add(key);
          const at = Date.parse(store.state(definition.id)?.nextCheckAt ?? new Date().toISOString());
          due.push({ key, at: Math.max(at, this.retryAfter.get(key) ?? 0), retryAfterMs: Math.max(definition.intervalSeconds * 1_000, MIN_RETRY_MS), fire: () => scheduler.check(definition) });
        }
      }
      const runner = new ScheduleRunner({
        projectId,
        store,
        timeZone: handle.timeZone,
        ...(handle.launchSchedule ? { launch: handle.launchSchedule } : {}),
        ...(handle.onChange ? { onChange: handle.onChange } : {}),
        ...(handle.now ? { now: handle.now } : {}),
        ...(handle.reconcileReceipts ? { reconcile: handle.reconcileReceipts } : {}),
      });
      for (const definition of enabled.filter(isScheduleAutomation)) {
        const key = `${projectId}:${definition.id}`;
        let at: number | null;
        // A throwing `dueAt` (an unknown zone, an unwritable state file) skips this item rather
        // than stalling the one timer every other automation shares.
        try { at = runner.dueAt(definition); } catch { continue; }
        if (at === null) continue;
        live.add(key);
        // A rejected fire (a held lease included) re-arms at the floor; the schedule's own next
        // occurrence is the runner's business, not the timer's.
        due.push({ key, at: Math.max(at, this.retryAfter.get(key) ?? 0), retryAfterMs: MIN_RETRY_MS, fire: () => runner.fire(definition) });
      }
    }
    for (const key of this.retryAfter.keys()) if (!live.has(key)) this.retryAfter.delete(key);
    if (!due.length) {
      if (this.options.coordinator.hasProjects()) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.reschedule(); }, WORKSPACE_TIMER_CAP_MS);
      }
      return;
    }
    due.sort((a, b) => a.at - b.at);
    const next = due[0]!;
    const clock = () => this.options.now?.() ?? Date.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // A capped wake short of the due instant fires nothing: look again from fresh state.
      if (clock() < next.at) { void this.reschedule(); return; }
      void next.fire().then(
        () => { this.retryAfter.delete(next.key); },
        () => { this.retryAfter.set(next.key, clock() + next.retryAfterMs); },
      ).finally(() => this.reschedule());
    }, Math.min(WORKSPACE_TIMER_CAP_MS, Math.max(0, next.at - clock())));
  }
}
