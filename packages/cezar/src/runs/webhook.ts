import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiRun, RunStatus, WebhookTrigger } from '@open-mercato/cezar-contract';
import { DEFAULT_WEBHOOK_TRIGGERS, deriveWebhookState, type AttentionInput } from '@open-mercato/cezar-contract/attention';
import { asksQuestion } from '@open-mercato/cezar-contract/waits';
import { projectStatus, type PendingQuestion } from '../task-cli/projections.ts';
import { loadWorkspaceConfig, type WorkspaceProject } from '../workspace/config.ts';
import { taskWebhooks } from '../workspace/webhooks.ts';
import { deriveRunContextEvents } from './event-history.ts';
import type { RunRecord, RunStore } from './store.ts';

/**
 * Opted-in task webhooks from selected derived-state entries. One store subscriber queues
 * ordered deliveries per run and per webhook, with bounded retries, to every project webhook
 * with task notifications on (hearsay-tools/cezarion#1576): a slow or failing webhook never
 * delays another. Failures never change lifecycle; pending in-memory deliveries can be lost on
 * restart. `sendAgentReport` is the on-demand delivery an agent sends through an exposed webhook.
 */

export type TaskWebhookEvent = 'task.status' | 'task.question' | 'task.subscribed' | 'task.test';

export interface WebhookEndpoint {
  url: string;
  token?: string | undefined;
}

export interface TaskWebhookTarget extends WebhookEndpoint {
  id: string;
  name: string;
  /** Absent = `DEFAULT_WEBHOOK_TRIGGERS`; `[]` = only `task.subscribed` and `task.test`. */
  triggers?: readonly WebhookTrigger[] | undefined;
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
  /** The state this delivery reports the run entering; `null` on `task.subscribed`. */
  state: WebhookTrigger | null;
  occurredAt: string;
  message?: string;
  /** Which project webhook this delivery went to (hearsay-tools/cezarion#1576). */
  webhook: { id: string; name: string };
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
  /** This project's registry id and its webhooks with task notifications on, read per delivery
   *  so a settings change applies without a restart and a removed webhook stops at once. */
  resolveProject: () => Promise<{ id: string; webhooks: TaskWebhookTarget[] } | undefined>;
  /** The cockpit origin (`http://127.0.0.1:4321`) for the thread link; unknown before listen. */
  origin: () => string | undefined;
  /** Resolves once the origin is known. Recovery runs before the server listens, and its
   *  transitions queue behind this rather than going out with a path-only link. */
  ready?: () => Promise<void>;
  /** Where the run's NDJSON lives, for the pending question. */
  dataDir: string;
  /** `CEZ_DRY_RUN=1` by default: log the payload as a run event, send nothing. */
  dryRun?: boolean;
  fetch?: typeof fetch | undefined;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** One POST, no retries. Shared by the queue and `POST /projects/:id/webhook/test`. */
export async function deliverOnce(
  target: WebhookEndpoint,
  payload: unknown,
  options: { fetch?: typeof fetch | undefined; timeoutMs?: number | undefined } = {},
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
  state: WebhookTrigger | undefined;
}

interface Pending {
  event: TaskWebhookEvent;
  run: RunRecord;
  previousStatus: RunStatus | null;
  /** Set on `task.status` and `task.question`: what `deliver()` filters on. */
  state?: WebhookTrigger;
  occurredAt: string;
  message?: string | undefined;
}

const seenOf = (run: AttentionInput): Seen => ({ status: run.status, state: deriveWebhookState(run) });

const sleepFor = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Up to `WEBHOOK_ATTEMPTS` POSTs with backoff; a 4xx other than 408/429 stops at once. */
async function deliverWithRetries(
  target: WebhookEndpoint,
  payload: unknown,
  options: { fetch?: typeof fetch | undefined; timeoutMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ result: DeliveryResult; attempts: number }> {
  const sleep = options.sleep ?? sleepFor;
  let result: DeliveryResult = { ok: false, error: 'not attempted' };
  let attempts = 0;
  while (attempts < WEBHOOK_ATTEMPTS) {
    if (attempts > 0) await sleep(WEBHOOK_BACKOFF_MS[attempts - 1] ?? 0);
    attempts += 1;
    result = await deliverOnce(target, payload, { fetch: options.fetch, timeoutMs: options.timeoutMs });
    if (result.ok || !retryable(result)) break;
  }
  return { result, attempts };
}

export class TaskWebhook {
  private readonly seen = new Map<string, Seen>();
  /** Per run: resolves the project's task webhooks in order, then fans out. */
  private readonly dispatches = new Map<string, Promise<void>>();
  /** Per run and webhook (`<runId>\0<webhookId>`): the ordered sends. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly seqs = new Map<string, number>();
  private readonly onRun = (run: RunRecord) => this.observe(run);
  private readonly onDeleted = (id: string) => this.seen.delete(id);
  private disposed = false;

  constructor(
    private readonly store: RunStore,
    private readonly options: TaskWebhookOptions,
  ) {
    // Seed from every run the store knows, so a context built after a restart does not report
    // every existing run as a fresh transition — nor one whose `notify` turns on later. Off the
    // list rows: a finished run is no longer in memory (#779).
    for (const run of store.listRunSummaries().runs) this.seen.set(run.id, seenOf(run));
    store.on('run', this.onRun);
    store.on('deleted', this.onDeleted);
  }

  dispose(): void {
    this.disposed = true;
    this.store.off('run', this.onRun);
    this.store.off('deleted', this.onDeleted);
  }

  /** The hand-off delivery (`POST /runs/:id/notify` turning notify on). A run created with
   *  `notify: true` gets the same delivery from `observe`. */
  subscribed(runId: string, message?: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    this.enqueue({ event: 'task.subscribed', run, previousStatus: null, occurredAt: new Date().toISOString(), message });
  }

  /** Resolves once every delivery queued so far has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.dispatches.size > 0 || this.queues.size > 0) {
      await Promise.all([...this.dispatches.values(), ...this.queues.values()]);
    }
  }

  private observe(run: RunRecord): void {
    const before = this.seen.get(run.id);
    const now = seenOf(run);
    this.seen.set(run.id, now);
    if (!run.notify || this.disposed) return;
    const occurredAt = new Date().toISOString();
    // A run created opted in (the New task toggle, `cez task start`) announces itself once, as
    // `POST /runs/:id/notify` does, so the bot learns the id and link while the run is queued.
    if (!before) {
      this.enqueue({ event: 'task.subscribed', run, previousStatus: null, occurredAt });
      return;
    }
    if (now.state === undefined || before.state === now.state) return;
    // One delivery per entry: a question that parks the run is one `task.question`, not a
    // `task.status` to `waiting` beside it.
    const event = now.state === 'needs-you' && asksQuestion(run) ? 'task.question' : 'task.status';
    this.enqueue({ event, run, previousStatus: before.status, state: now.state, occurredAt });
  }

  private enqueue(pending: Pending): void {
    const runId = pending.run.id;
    // Snapshot now: the record object is live and will have moved on by the time this sends.
    const snapshot: Pending = { ...pending, run: { ...pending.run } };
    this.chain(this.dispatches, runId, () => this.dispatch(snapshot));
  }

  /** Run `task` after the previous one under `key`, whatever that one did. */
  private chain(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>): void {
    const previous = map.get(key) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch(() => undefined)
      .finally(() => {
        if (map.get(key) === next) map.delete(key);
      });
    map.set(key, next);
  }

  /** Resolve the webhooks as they are now, then queue one send per webhook that wants it. The
   *  per-run dispatch keeps a run's changes in order; the per-webhook queues keep one webhook's
   *  retries from holding up another. */
  private async dispatch(pending: Pending): Promise<void> {
    await this.options.ready?.();
    const project = await this.options.resolveProject().catch(() => undefined);
    // Removed since the run opted in: nothing to send to, and nobody to tell.
    if (!project) return;
    for (const target of project.webhooks) {
      if (!wants(target, pending)) continue;
      this.chain(this.queues, `${pending.run.id}\0${target.id}`, () => this.deliver(pending, target.id));
    }
  }

  /** The webhook as it is when its send reaches the head of its queue: a send that waited behind
   *  a slow one never POSTs to a removed webhook, nor to an old URL or with an old token. Filtered
   *  before the payload, so a skipped change does not use up a `seq` number. */
  private async current(pending: Pending, webhookId: string): Promise<{ projectId: string; target: TaskWebhookTarget } | undefined> {
    const project = await this.options.resolveProject().catch(() => undefined);
    const target = project?.webhooks.find((webhook) => webhook.id === webhookId);
    return project && target && wants(target, pending) ? { projectId: project.id, target } : undefined;
  }

  private async payload(pending: Pending, projectId: string, target: TaskWebhookTarget): Promise<TaskWebhookPayload> {
    const { run } = pending;
    const seqKey = `${run.id}\0${target.id}`;
    const seq = (this.seqs.get(seqKey) ?? 0) + 1;
    this.seqs.set(seqKey, seq);
    const url = threadUrl(this.options.origin(), projectId, run.id);
    const question = asksQuestion(run) ? await pendingQuestion(this.options.dataDir, run.id) : undefined;
    return {
      event: pending.event,
      deliveryId: randomUUID(),
      seq,
      projectId,
      runId: run.id,
      url,
      status: run.status,
      previousStatus: pending.previousStatus,
      state: pending.state ?? null,
      occurredAt: pending.occurredAt,
      ...(pending.message === undefined ? {} : { message: pending.message }),
      webhook: { id: target.id, name: target.name },
      // The same slim projection `cez task status` prints, so a bot parses one shape.
      task: { ...projectStatus(run as unknown as ApiRun, url, question), notify: run.notify === true },
    };
  }

  private async deliver(pending: Pending, webhookId: string): Promise<void> {
    const current = await this.current(pending, webhookId);
    if (!current) return;
    const { projectId, target } = current;
    const payload = await this.payload(pending, projectId, target);
    const runId = pending.run.id;
    if (this.options.dryRun ?? process.env.CEZ_DRY_RUN === '1') {
      this.store.appendEvent(runId, { type: 'webhook.dry-run', event: payload.event, payload });
      this.recordOutcome(runId, target, { ok: true });
      return;
    }
    const { result, attempts } = await deliverWithRetries(target, payload, this.options);
    this.recordOutcome(runId, target, result);
    if (result.ok) return;
    this.store.appendEvent(runId, {
      type: 'webhook.failed',
      event: payload.event,
      deliveryId: payload.deliveryId,
      webhookId: target.id,
      webhookName: target.name,
      attempts,
      error: (result.error ?? 'delivery failed').slice(0, 500),
      ...(result.status === undefined ? {} : { status: result.status }),
    });
  }

  /** `run.webhook`: a success clears an error only when it came from the same webhook, so one
   *  working webhook never hides another's failure. */
  private recordOutcome(runId: string, target: TaskWebhookTarget, result: DeliveryResult): void {
    const previous = this.store.getRun(runId)?.webhook;
    if (result.ok) {
      const keepError = previous?.lastError !== undefined && previous.lastErrorWebhookId !== undefined && previous.lastErrorWebhookId !== target.id;
      this.store.updateRun(runId, {
        webhook: {
          lastDeliveredAt: new Date().toISOString(),
          ...(keepError ? { lastError: previous.lastError, lastErrorWebhookId: previous.lastErrorWebhookId } : {}),
        },
      });
      return;
    }
    const error = `${target.name}: ${(result.error ?? 'delivery failed').slice(0, 500)}`;
    this.store.updateRun(runId, {
      webhook: {
        ...(previous?.lastDeliveredAt ? { lastDeliveredAt: previous.lastDeliveredAt } : {}),
        lastError: error,
        lastErrorWebhookId: target.id,
      },
    });
  }
}

/** A status change goes only to a webhook that selected its state; the hand-off always does. */
function wants(target: TaskWebhookTarget, pending: Pending): boolean {
  return pending.state === undefined || (target.triggers ?? DEFAULT_WEBHOOK_TRIGGERS).includes(pending.state);
}

function threadUrl(origin: string | undefined, projectId: string, runId: string): string {
  return `${origin ?? ''}/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(runId)}`;
}

async function pendingQuestion(dataDir: string, runId: string): Promise<PendingQuestion | undefined> {
  try {
    const context = await deriveRunContextEvents(dataDir, runId);
    const ask = [...context.contextEvents].reverse().find((event) => event.type === 'ask.requested');
    return ask ? { questions: ask.questions, context: ask.context } : undefined;
  } catch {
    return undefined;
  }
}

/** One on-demand report from an agent (hearsay-tools/cezarion#1576): `event: "agent.report"`. */
export interface AgentReportPayload {
  event: 'agent.report';
  deliveryId: string;
  occurredAt: string;
  projectId: string;
  webhook: { id: string; name: string };
  runId?: string;
  /** The reporting task's cockpit thread. */
  url?: string | undefined;
  title?: string;
  /** Markdown. */
  message: string;
  data?: Record<string, unknown>;
  /** The `cez task status` projection of the reporting task. */
  task?: Record<string, unknown>;
}

export interface AgentReportOptions {
  projectId: string;
  webhook: TaskWebhookTarget;
  input: { runId?: string | undefined; title?: string | undefined; message: string; data?: Record<string, unknown> | undefined };
  /** The reporting run's store, when the run is known: its thread gets a `webhook.report` line. */
  store?: RunStore;
  origin?: string | undefined;
  dataDir?: string;
  dryRun?: boolean;
  fetch?: typeof fetch | undefined;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface AgentReportResult {
  ok: boolean;
  deliveryId: string;
  attempts: number;
  status?: number;
  error?: string;
  dryRun?: boolean;
}

/**
 * Send one agent report now, with the retries task deliveries get, and answer how it went. The
 * reporting run's thread records the outcome; a failure never changes the run's status.
 */
export async function sendAgentReport(options: AgentReportOptions): Promise<AgentReportResult> {
  const { input, webhook } = options;
  const run = input.runId ? options.store?.getRun(input.runId) : undefined;
  const url = run ? threadUrl(options.origin, options.projectId, run.id) : undefined;
  const payload: AgentReportPayload = {
    event: 'agent.report',
    deliveryId: randomUUID(),
    occurredAt: new Date().toISOString(),
    projectId: options.projectId,
    webhook: { id: webhook.id, name: webhook.name },
    ...(run ? { runId: run.id, url } : {}),
    ...(input.title === undefined ? {} : { title: input.title }),
    message: input.message,
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(run && url ? { task: projectStatus(run as unknown as ApiRun, url, undefined) as unknown as Record<string, unknown> } : {}),
  };
  const dryRun = options.dryRun ?? process.env.CEZ_DRY_RUN === '1';
  const outcome: AgentReportResult = dryRun
    ? { ok: true, deliveryId: payload.deliveryId, attempts: 0, dryRun: true }
    : await deliverWithRetries(webhook, payload, options).then(({ result, attempts }) => ({
        ok: result.ok,
        deliveryId: payload.deliveryId,
        attempts,
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.ok ? {} : { error: (result.error ?? 'delivery failed').slice(0, 500) }),
      }));
  if (run && options.store) {
    options.store.appendEvent(run.id, {
      type: 'webhook.report',
      webhookId: webhook.id,
      webhookName: webhook.name,
      deliveryId: payload.deliveryId,
      ok: outcome.ok,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(outcome.dryRun ? { dryRun: true } : {}),
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
  }
  return outcome;
}

/**
 * Attach one webhook subscriber per store before recovery. Wait for setOrigin before delivering
 * so startup transitions retain a usable cockpit URL.
 */
export class TaskWebhooks {
  private readonly hooks = new WeakMap<RunStore, TaskWebhook>();
  private origin: string | undefined;
  private markReady!: () => void;
  private readonly ready = new Promise<void>((done) => { this.markReady = done; });

  constructor(private readonly options: { fetch?: typeof fetch | undefined; origin?: string } = {}) {
    if (options.origin !== undefined) this.setOrigin(options.origin);
  }

  setOrigin(origin: string): void {
    this.origin = origin;
    this.markReady();
  }

  /** The cockpit origin for thread links, once the server listens. */
  currentOrigin(): string | undefined {
    return this.origin;
  }

  /** Idempotent: a store already attached keeps its subscriber and its queue. `id` may be the
   *  reserved `default` alias, which resolves to the registry entry holding `root`. */
  attach(project: { id: string; root: string; store: RunStore }): TaskWebhook {
    const existing = this.hooks.get(project.store);
    if (existing) return existing;
    const hook = new TaskWebhook(project.store, {
      resolveProject: () => registryWebhooks(project.id, project.root),
      origin: () => this.origin,
      ready: () => this.ready,
      dataDir: join(project.root, '.ai/cezar'),
      fetch: this.options.fetch,
    });
    this.hooks.set(project.store, hook);
    return hook;
  }

  get(store: RunStore): TaskWebhook | undefined {
    return this.hooks.get(store);
  }
}

/** The registry entry this project is, read per delivery so a settings change applies at once. */
async function registryWebhooks(id: string, root: string): Promise<{ id: string; webhooks: TaskWebhookTarget[] } | undefined> {
  const entry = await registryEntry(id, root);
  return entry ? { id: entry.id, webhooks: taskWebhooks(entry) } : undefined;
}

/** `id` may be the reserved `default` alias, which resolves to the registry entry holding `root`. */
export async function registryEntry(id: string, root: string): Promise<WorkspaceProject | undefined> {
  const projects = (await loadWorkspaceConfig()).projects;
  const real = id === 'default' ? await realpath(root).catch(() => root) : root;
  return id === 'default'
    ? projects.find((project) => project.root === real || project.root === root)
    : projects.find((project) => project.id === id);
}
