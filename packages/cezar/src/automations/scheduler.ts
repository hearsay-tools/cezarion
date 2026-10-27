import { githubBaselineState } from './github-baseline.ts';
import type { AutomationCoordinator } from './coordinator.ts';
import { AutomationCandidateChangedError, type GithubCandidate, type GithubPoller, type GithubPollResult } from './github-poller.ts';
import { AutomationProjectUnavailableError, ScheduleRunner, type ScheduleLauncher } from './schedule-runner.ts';
import type { AutomationLease, AutomationStore } from './store.ts';
import { isGithubAutomation, isScheduleAutomation, type AutomationRuntimeState, type GithubAutomationDefinition } from './types.ts';

export interface AutomationLaunchResult { runId: string; existing?: boolean }
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
  launch?: AutomationLauncher | undefined;
  launchSchedule?: ScheduleLauncher;
  onChange?: (automationId: string, revision: number) => void;
  now?: () => number;
  /** See `ScheduleRunnerHandle.reconcile`. */
  reconcileReceipts?: () => Promise<void>;
  /** See `ScheduleRunnerHandle.ready`; a poll asks it before it launches what it found. */
  ready?: () => Promise<void>;
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

class ObsoleteAutomationCheck extends Error {
  constructor() { super('Automation changed while the check was in progress; discarded the obsolete result.'); }
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
      if (mode === 'execute') store.recoverArming(definition.id, (current) => isGithubAutomation(current) ? githubBaselineState(current) : undefined);
      this.assertCurrent(definition);
      const state = store.state(definition.id) ?? {};
      if (state.backoffUntil && Date.parse(state.backoffUntil) > Date.now()) {
        throw new Error(`automation is backed off until ${state.backoffUntil}`);
      }
      const { baseline, overlapSince } = pollWindow(definition, state, mode);
      const duplicates: GithubCandidate[] = [];
      const accept = candidateAcceptor(definition, baseline, mode, store, candidate => duplicates.push(candidate));
      const result = await githubRequests.run(() => github.poller.poll(
        github.owner,
        github.repo,
        definition,
        { since: overlapSince, accept, ...(mode === 'execute' && state.historyScan ? { historyScan: state.historyScan } : {}) },
      ));
      this.assertCurrent(definition);
      const eligible = result.candidates.filter(candidate => afterBaseline(candidate, definition, baseline));
      if (mode === 'execute') await this.launchCandidates(definition, eligible);
      await this.recordDuplicates(definition, duplicates);
      this.assertCurrent(definition);
      this.recordSuccess(definition, state, result, mode, detectionOnly);
      this.handle.onChange?.(definition.id, definition.revision);
      completion = mode === 'preview'
        ? { result: 'preview', reason: `Bounded preview found ${eligible.length} filter match${eligible.length === 1 ? '' : 'es'}; no tasks were launched. Counts can include closed items and previously processed events.` }
        : { result: 'no-match', reason: 'Scheduled check completed.' };
      return { ...result, candidates: eligible };
    } catch (error) {
      return await this.handleCheckError(definition, mode, error);
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

  private async launchCandidates(definition: GithubAutomationDefinition, candidates: GithubCandidate[]): Promise<void> {
    if (!this.handle.launch || !candidates.length) return;
    await this.handle.ready?.();
    for (const candidate of candidates) {
      this.assertCurrent(definition);
      await this.launch(definition, candidate);
    }
  }

  /** Audit handled matches independently of the new-work budget, after selected launches own their receipts. */
  private async recordDuplicates(definition: GithubAutomationDefinition, candidates: GithubCandidate[]): Promise<void> {
    if (!candidates.length) return;
    const owners = new Map([...this.handle.store.latestReceipts().values()]
      .filter(receipt => receipt.automationId === definition.id && receipt.status !== 'released')
      .map(receipt => [receipt.candidate ? candidateKey(receipt.candidate) : receipt.eventId, receipt]));
    for (const candidate of candidates) {
      this.assertCurrent(definition);
      const owner = owners.get(candidateKey(candidate));
      await this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event,
        result: 'duplicate', reason: owner
          ? `A durable receipt already exists for this automation and item.${owner.runId ? ` Task: ${owner.runId}.` : ''}`
          : 'Another matching event for this issue was selected in this check.',
        ...(owner?.runId ? { runId: owner.runId } : {}),
        githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
    }
  }

  private recordSuccess(definition: GithubAutomationDefinition, state: AutomationRuntimeState,
    result: GithubPollResult, mode: 'preview' | 'execute', detectionOnly: boolean): void {
    const { store } = this.handle;
    if (mode === 'execute') {
      const now = new Date().toISOString();
      const cursor = laterCursor(state.cursor, result.cursor);
      store.setState(definition.id, (current) => ({
        ...this.currentState(definition, current),
        revision: definition.revision,
        cursor,
        historyScan: result.historyScan,
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
        ...this.currentState(definition, current),
        revision: definition.revision,
        nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1_000).toISOString(),
      }));
    }
  }

  private async handleCheckError(definition: GithubAutomationDefinition, mode: 'preview' | 'execute', error: unknown): Promise<GithubPollResult> {
    const { store } = this.handle;
    // A definition edit can re-arm state while a provider call or launch is in flight.
    // Never write the old window (including failure backoff) over the new policy.
    if (!(error instanceof LeaseHeldError)) {
      try { this.assertCurrent(definition); } catch (obsolete) {
        if (!(obsolete instanceof ObsoleteAutomationCheck)) throw obsolete;
        await store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'skipped', reason: obsolete.message });
        return { candidates: [], truncated: false, pages: 0 };
      }
    }
    if (error instanceof LeaseHeldError) await this.recordSkip(definition, error);
    // Not a failure: nothing was launched or moved, and the timer retries at its floor.
    else if (error instanceof AutomationProjectUnavailableError) { /* see above */ }
    else if (mode === 'execute') await this.recordFailure(definition, error);
    else await store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'error', reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  private currentState(definition: GithubAutomationDefinition, current: AutomationRuntimeState) {
    if (current.revision !== undefined && current.revision !== definition.revision) throw new ObsoleteAutomationCheck();
    return current;
  }

  private assertCurrent(definition: GithubAutomationDefinition): void {
    this.handle.store.reloadIfChanged();
    const stateRevision = this.handle.store.state(definition.id)?.revision;
    if (this.handle.store.get(definition.id)?.revision !== definition.revision
      || (stateRevision !== undefined && stateRevision !== definition.revision)) throw new ObsoleteAutomationCheck();
  }

  private async launch(definition: GithubAutomationDefinition, candidate: GithubCandidate): Promise<void> {
    if (definition.filters.requireCurrentLabels) {
      const matches = await this.handle.github!.poller.matchesCurrentLabels(candidate, definition);
      this.assertCurrent(definition);
      if (!matches) {
        await this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event,
          result: 'skipped', reason: 'Automation item is closed or no longer matches current labels; no receipt or task was created.',
          githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
        return;
      }
    }
    // Keep event receipts (including old ones) for retry/recovery, but collapse every issue
    // event onto its first reservation, even after restart or a definition edit.
    const previous = candidate.event.startsWith('issue.')
      ? [...this.handle.store.latestReceipts().values()].find((receipt) => receipt.status !== 'released' && receipt.automationId === definition.id
        && receipt.candidate?.event.startsWith('issue.')
        && receipt.candidate.repo.toLowerCase() === candidate.repo.toLowerCase()
        && receipt.candidate.number === candidate.number)
      : undefined;
    if (previous) {
      await this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event,
        result: 'duplicate', reason: `A durable receipt already exists for this automation and issue.${previous.runId ? ` Task: ${previous.runId}.` : ''}`,
        ...(previous.runId ? { runId: previous.runId } : {}),
        githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
      return;
    }
    const receipt = this.handle.store.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId: candidate.eventId, candidate });
    if (!receipt) {
      await this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event, result: 'duplicate', reason: 'A durable receipt already exists for this automation and event.', githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
      return;
    }
    try {
      const launched = await this.handle.launch!(definition, candidate, receipt.receiptId);
      this.handle.store.appendReceipt({ ...receipt, status: 'launched', runId: launched.runId, updatedAt: new Date().toISOString() });
      await this.handle.store.appendLog({
        automationId: definition.id, revision: definition.revision, event: candidate.event,
        result: launched.existing ? 'skipped' : 'launched',
        ...(launched.existing ? { reason: `Issue already has non-archived task ${launched.runId}.` } : {}),
        receiptId: receipt.receiptId, runId: launched.runId,
        githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url,
      });
    } catch (error) {
      const released = error instanceof AutomationCandidateChangedError;
      this.handle.store.appendReceipt({ ...receipt, status: released ? 'released' : 'launch-error', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
      if (released) {
        await this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event,
          result: 'skipped', reason: error.message, receiptId: receipt.receiptId,
          githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
        return;
      }
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
      this.currentState(definition, current);
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

/** Preview uses the rule window; execution resumes its durable scan with a two-minute overlap. */
function pollWindow(definition: GithubAutomationDefinition, state: AutomationRuntimeState, mode: 'preview' | 'execute') {
  // Preview tests the rule's window, independently of how far execution has scanned.
  const historyStart = definition.filters.includeExisting
    ? new Date(Date.now() - definition.filters.lookbackDays * 86_400_000).toISOString()
    : undefined;
  const baseline = historyStart
    ? new Date(Math.max(Date.parse(historyStart), mode === 'preview' ? 0 : Date.parse(state.baselineAt ?? historyStart))).toISOString()
    : state.baselineAt;
  const since = mode === 'preview' ? baseline : state.cursor?.timestamp ?? baseline;
  let overlapSince = mode === 'preview' && historyStart ? historyStart : since
    ? new Date(Date.parse(since) - 120_000).toISOString()
    : undefined;
  if (historyStart && (!overlapSince || Date.parse(overlapSince) < Date.parse(historyStart))) overlapSince = historyStart;
  return { baseline, overlapSince };
}

function afterBaseline(candidate: GithubCandidate, definition: GithubAutomationDefinition, baseline?: string): boolean {
  if (!baseline) return true;
  const timestamp = Date.parse(candidate.timestamp);
  return definition.filters.includeExisting ? timestamp >= Date.parse(baseline) : timestamp > Date.parse(baseline);
}

function candidateAcceptor(definition: GithubAutomationDefinition, baseline: string | undefined,
  mode: 'preview' | 'execute', store: AutomationStore,
  duplicate: (candidate: GithubCandidate) => void): (candidate: GithubCandidate) => boolean {
  const handled = new Set([...store.latestReceipts().values()]
    .filter(receipt => receipt.automationId === definition.id && receipt.status !== 'released')
    .map(receipt => receipt.candidate ? candidateKey(receipt.candidate) : receipt.eventId));
  return candidate => {
    if (!afterBaseline(candidate, definition, baseline)) return false;
    if (mode === 'preview') return true;
    const key = candidateKey(candidate);
    if (handled.has(key)) {
      duplicate(candidate);
      return false;
    }
    handled.add(key);
    return true;
  };
}

/** Issue receipts own the item across transitions; PR receipts own their opened event. */
function candidateKey(candidate: GithubCandidate): string {
  return candidate.event.startsWith('issue.')
    ? `${candidate.repo.toLowerCase()}:issue:${candidate.number}`
    : candidate.eventId;
}

function laterCursor(
  current: { timestamp: string; tieBreaker?: string | undefined } | undefined,
  observed: { timestamp: string; tieBreaker: string } | undefined,
): { timestamp: string; tieBreaker?: string | undefined } | undefined {
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
  private timer?: ReturnType<typeof setTimeout> | undefined;
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
        ...(handle.ready ? { ready: handle.ready } : {}),
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
