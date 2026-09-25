import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ApiRun, RunActivity, RunStatus } from '@open-mercato/cezar-contract';
import { projectStatus } from '../task-cli/projections.ts';
import { deriveRunContextEvents } from './event-history.ts';
import type { RunRecord, RunStore } from './store.ts';

/**
 * The task webhook (#589, spec 2026-09-25-task-webhook-handoff): a run that opted in with
 * `notify: true` POSTs its status changes to the project's webhook with a Bearer token.
 *
 * One subscriber per project store, on the store's `'run'` emission. That emission is the single
 * choke point every status change passes through — both turn-end handlers in `workflows/run.ts`,
 * both `ActiveRun` construction sites, recovery and the routes — so nothing upstream is edited
 * to feed it. The subscriber diffs each record against the last one it saw and queues a delivery
 * for what changed.
 *
 * Delivery is best-effort and never touches the run's lifecycle: one in-order queue per run, a
 * 10 s timeout, 3 attempts with backoff, and the outcome written to `run.webhook` plus a
 * `webhook.failed` thread event when every attempt failed. The queue is in memory; a restart
 * drops what was pending (out of scope in #589).
 */

export type TaskWebhookEvent = 'task.status' | 'task.question' | 'task.activity' | 'task.subscribed' | 'task.test';

export interface TaskWebhookTarget {
  url: string;
  token?: string;
}

export interface TaskWebhookPayload {
  event: TaskWebhookEvent;
  deliveryId: string;
  seq: number;
  projectId: string;
  runId: string;
  url: string;
  status: RunStatus;
  previousStatus: RunStatus | null;
  activity: RunActivity | null;
  occurredAt: string;
  message?: string;
  task: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3. */
export const WEBHOOK_BACKOFF_MS: readonly number[] = [1_000, 4_000];

export interface TaskWebhookOptions {
  /** This project's registry id and current webhook, read per delivery so a settings change
   *  applies without a restart and a removed webhook stops deliveries at once. */
  resolveProject: () => Promise<{ id: string; webhook?: TaskWebhookTarget } | undefined>;
  /** The cockpit origin (`http://127.0.0.1:4321`) for the thread link; unknown before listen. */
  origin: () => string | undefined;
  /** Where the run's NDJSON lives, for the pending question. */
  dataDir: string;
  /** `CEZ_DRY_RUN=1` by default: log the payload as a run event, send nothing. */
  dryRun?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** One POST, no retries. Shared by the queue and `POST /projects/:id/webhook/test`. */
export async function deliverOnce(
  target: TaskWebhookTarget,
  payload: unknown,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<DeliveryResult> {
  try {
    const response = await (options.fetch ?? fetch)(target.url, {
      method: 'POST',
      // A redirect would carry the Bearer token to a URL nobody configured.
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'cezar-task-webhook',
        ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, error: 'timed out' };
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
    return { ok: false, error: `${error instanceof Error ? error.message : String(error)}${cause}`.slice(0, 500) };
  }
}

/** A 4xx other than 408/429 is the endpoint's answer, not a transient failure. */
function retryable(result: DeliveryResult): boolean {
  if (result.status === undefined) return true;
  return result.status >= 500 || result.status === 408 || result.status === 429;
}

interface Seen {
  status: RunStatus;
  activity: RunActivity | null;
  ask: boolean;
}

interface Pending {
  event: TaskWebhookEvent;
  run: RunRecord;
  previousStatus: RunStatus | null;
  occurredAt: string;
  message?: string;
}

const seenOf = (run: RunRecord): Seen => ({
  status: run.status,
  activity: run.activity ?? null,
  ask: run.hasPendingHumanAsk === true,
});

export class TaskWebhook {
  private readonly seen = new Map<string, Seen>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly seqs = new Map<string, number>();
  private readonly onRun = (run: RunRecord) => this.observe(run);
  private readonly onDeleted = (id: string) => this.seen.delete(id);
  private disposed = false;

  constructor(
    private readonly store: RunStore,
    private readonly options: TaskWebhookOptions,
  ) {
    // Seed from what the store already holds, so a context built after a restart does not
    // report every existing run as a fresh transition.
    for (const run of store.listRuns()) this.seen.set(run.id, seenOf(run));
    store.on('run', this.onRun);
    store.on('deleted', this.onDeleted);
  }

  dispose(): void {
    this.disposed = true;
    this.store.off('run', this.onRun);
    this.store.off('deleted', this.onDeleted);
  }

  /** The hand-off delivery (`POST /runs/:id/notify` turning notify on). */
  subscribed(runId: string, message?: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    this.enqueue({ event: 'task.subscribed', run, previousStatus: null, occurredAt: new Date().toISOString(), message });
  }

  /** Resolves once every delivery queued so far has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  private observe(run: RunRecord): void {
    const before = this.seen.get(run.id);
    const now = seenOf(run);
    this.seen.set(run.id, now);
    // A new record is not a transition: the caller that created it has its answer already.
    if (!before || !run.notify || this.disposed) return;
    const occurredAt = new Date().toISOString();
    if (before.status !== now.status) {
      this.enqueue({ event: 'task.status', run, previousStatus: before.status, occurredAt });
    }
    if (before.activity !== now.activity) {
      this.enqueue({ event: 'task.activity', run, previousStatus: null, occurredAt });
    }
    if (!before.ask && now.ask) {
      this.enqueue({ event: 'task.question', run, previousStatus: null, occurredAt });
    }
  }

  private enqueue(pending: Pending): void {
    const runId = pending.run.id;
    // Snapshot now: the record object is live and will have moved on by the time this sends.
    const snapshot: Pending = { ...pending, run: { ...pending.run } };
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous
      .then(() => this.deliver(snapshot))
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(runId) === next) this.queues.delete(runId);
      });
    this.queues.set(runId, next);
  }

  private async payload(pending: Pending, projectId: string): Promise<TaskWebhookPayload> {
    const { run } = pending;
    const seq = (this.seqs.get(run.id) ?? 0) + 1;
    this.seqs.set(run.id, seq);
    const origin = this.options.origin() ?? '';
    const url = `${origin}/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(run.id)}`;
    const question = run.hasPendingHumanAsk ? await this.pendingQuestion(run.id) : undefined;
    return {
      event: pending.event,
      deliveryId: randomUUID(),
      seq,
      projectId,
      runId: run.id,
      url,
      status: run.status,
      previousStatus: pending.previousStatus,
      activity: run.activity ?? null,
      occurredAt: pending.occurredAt,
      ...(pending.message === undefined ? {} : { message: pending.message }),
      // The same slim projection `cez task status` prints, so a bot parses one shape.
      task: { ...projectStatus(run as unknown as ApiRun, url, question), notify: run.notify === true },
    };
  }

  private async pendingQuestion(runId: string): Promise<unknown> {
    try {
      const context = await deriveRunContextEvents(join(this.options.dataDir, 'runs', `${runId}.ndjson`));
      return [...context.contextEvents].reverse().find((event) => event.type === 'ask.requested')?.questions;
    } catch {
      return undefined;
    }
  }

  private async deliver(pending: Pending): Promise<void> {
    const project = await this.options.resolveProject().catch(() => undefined);
    // Removed since the run opted in: nothing to send to, and nobody to tell.
    if (!project?.webhook) return;
    const payload = await this.payload(pending, project.id);
    const runId = pending.run.id;
    if (this.options.dryRun ?? process.env.CEZ_DRY_RUN === '1') {
      this.store.appendEvent(runId, { type: 'webhook.dry-run', event: payload.event, payload });
      this.store.updateRun(runId, { webhook: { lastDeliveredAt: new Date().toISOString() } });
      return;
    }
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    let result: DeliveryResult = { ok: false, error: 'not attempted' };
    let attempts = 0;
    while (attempts < WEBHOOK_ATTEMPTS) {
      if (attempts > 0) await sleep(WEBHOOK_BACKOFF_MS[attempts - 1] ?? 0);
      attempts += 1;
      result = await deliverOnce(project.webhook, payload, {
        fetch: this.options.fetch,
        timeoutMs: this.options.timeoutMs,
      });
      if (result.ok || !retryable(result)) break;
    }
    const previous = this.store.getRun(runId)?.webhook;
    if (result.ok) {
      this.store.updateRun(runId, { webhook: { lastDeliveredAt: new Date().toISOString() } });
      return;
    }
    const error = (result.error ?? 'delivery failed').slice(0, 500);
    this.store.updateRun(runId, {
      webhook: { ...(previous?.lastDeliveredAt ? { lastDeliveredAt: previous.lastDeliveredAt } : {}), lastError: error },
    });
    this.store.appendEvent(runId, {
      type: 'webhook.failed',
      event: payload.event,
      deliveryId: payload.deliveryId,
      attempts,
      error,
      ...(result.status === undefined ? {} : { status: result.status }),
    });
  }
}
