import type { WorkerWait } from './delegation.ts';
import type { RunIndexEntry, RunRecord, RunSummary } from './runs.ts';
import { hasResolvedWait, resolveWaitingOn, type WaitingOn } from './waits.ts';

/**
 * Canonical Node-free attention classification for browser and CLI. Map run facts to bucket,
 * tone and pulse without UI state or backend-specific inference.
 */

/**
 * The attention priority ladder, highest first (spec: permission > error > waiting/review >
 * running > unseen). `rank` is exported because it *is* the contract — a table test asserts the
 * order rather than trusting the if-chain below to be read correctly.
 */
export const ATTENTION_RANK = {
  permission: 0,
  error: 1,
  waiting: 2,
  running: 3,
  unseen: 4,
  none: 5,
} as const;

export type AttentionBucket = keyof typeof ATTENTION_RANK;

/** The dot tones the cockpit's design system defines (`--success`/`--pending`/`--danger`/
 *  `--accent-strong`/`--info`/`--status-running`, plus the neutral `--soft-foreground`). Named
 *  here rather than imported from the cockpit's `StatusDot` to keep this module UI-free; the
 *  cockpit's `attention.test.ts` asserts the two sets stay identical. `accent` stays in the
 *  vocabulary for non-status dots (a reference's "closed as completed"); no status rung uses it
 *  since #617, because brand teal read as "done". */
export type AttentionTone = 'success' | 'pending' | 'danger' | 'accent' | 'info' | 'running' | 'neutral';

/**
 * The status key's second channel (#617): hue says the family, SHAPE says whether it is waiting.
 *  - `filled` — it is moving, or it has ended.
 *  - `ring` — it is waiting on something outside it (a monitored command, a free slot, a clock).
 *  - `workers` — it is waiting on its own workers (the robot glyph).
 * Shape is what separates rungs that share a hue: running vs monitoring, queued vs cancelled.
 */
export type AttentionShape = 'filled' | 'ring' | 'workers';

/**
 * One id per rung of the ladder (spec 2026-10-17-unified-waits, "Status and display"), in its
 * order (hearsay-tools/cezarion#1496). A rung's label is copy and can carry a count; a reader that
 * decides something reads the id. Rung 8 has an id per PR target (merge since
 * hearsay-tools/cezarion#1425) and the process rung sits between CI and timer
 * (hearsay-tools/cezarion#1446). `unseen` is reserved: `isUnseen` never matches.
 */
export const ATTENTION_RUNGS = [
  'needs-permission',
  'failed',
  'needs-you',
  'needs-review',
  'running',
  'usage-limit',
  'waiting-on-workers',
  'waiting-for-ci',
  'waiting-for-merge',
  'waiting-for-command',
  'monitoring',
  'waiting-for-capacity',
  'queued',
  'done',
  'cancelled',
  'unseen',
] as const;

export type AttentionRung = (typeof ATTENTION_RUNGS)[number];

export interface Attention {
  /** Which rung the run is on: what a reader compares, never `label`. */
  rung: AttentionRung;
  bucket: AttentionBucket;
  tone: AttentionTone;
  shape: AttentionShape;
  /** True while the run is *transitioning* — the spec's "pulsing while transitioning" rule. */
  pulse: boolean;
  /** Lower-case human phrase for the dot's tooltip / accessible name, and the CLI's `attentionLabel`. */
  label: string;
}

/** Permission attention comes only from a live native request, never from waiting alone. */
function hasPendingPermission(run: AttentionInput): boolean {
  return run.hasPendingPermission === true && (run.status === 'waiting' || run.status === 'running');
}

/**
 * Reserved unseen attention bucket remains unused. Finished-item read receipts use a separate
 * channel; do not recolor status from unread state.
 */
function isUnseen(_run: AttentionInput): boolean {
  return false;
}

/** What attention derivation actually reads. `Pick`ed rather than the full `RunRecord` so
 *  surfaces that only have a status can use
 *  the same canonical function instead of inventing a second status-to-tone mapping. Delegation
 *  uses the slim contract projection: full run records, `ApiRun`s and workspace index rows all
 *  carry it. A summary carries `waitingOn`; a full or stream-patched record carries `waits` and no
 *  `waitingOn`, and `resolveWaitingOn` computes it from them (spec 2026-10-17-unified-waits). */
export type AttentionInput = Pick<RunRecord, 'status' | 'autoResumeAt' | 'hasPendingPermission'> & Pick<RunIndexEntry, 'delegation'>
  & Partial<Pick<RunSummary, 'waitingOn' | 'waitWakePending'>> & Partial<Pick<RunRecord, 'waits'>>;

/** Dependency wording for a worker wait in the legacy `WorkerWait` shape, which the run's
 * relationship details show (#375). A worker can only wait on requests to its parent; only roots
 * can wait for worker completion. */
export function workerWaitLabel(role: 'root' | 'worker', wait: Pick<WorkerWait, 'requestIds' | 'outcomes' | 'workerIds'>): string {
  if (wait.requestIds?.length) return role === 'worker' ? 'waiting on parent reply' : 'waiting on worker replies';
  // The count is the workers still OWED an outcome (#617: "waiting on 2 workers"): a wait-for-all
  // stays open after one of two has reported, and "waiting on 2" would then overstate it. None
  // left says no number.
  const reported = new Set(wait.outcomes?.map((outcome) => outcome.workerId));
  const workers = wait.workerIds?.filter((id) => !reported.has(id)).length;
  return workers ? `waiting on ${workers} worker${workers === 1 ? '' : 's'}` : 'waiting on workers';
}

/** Presentation is exhaustive over rung ids; only worker waits need a dynamic label or shape. */
const PRESENTATION_OF_RUNG: Record<AttentionRung, Omit<Attention, 'rung'>> = {
  'needs-permission': { bucket: 'permission', tone: 'info', shape: 'filled', pulse: true, label: 'needs permission' },
  failed: { bucket: 'error', tone: 'danger', shape: 'filled', pulse: false, label: 'failed' },
  'needs-you': { bucket: 'waiting', tone: 'pending', shape: 'filled', pulse: true, label: 'needs you' },
  'needs-review': { bucket: 'waiting', tone: 'info', shape: 'filled', pulse: true, label: 'needs review' },
  running: { bucket: 'running', tone: 'running', shape: 'filled', pulse: true, label: 'running' },
  'usage-limit': { bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'usage limit' },
  'waiting-on-workers': { bucket: 'none', tone: 'running', shape: 'workers', pulse: false, label: 'waiting on workers' },
  'waiting-for-ci': { bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'waiting for CI' },
  'waiting-for-merge': { bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'waiting for merge' },
  'waiting-for-command': { bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'waiting for a command' },
  monitoring: { bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'monitoring' },
  'waiting-for-capacity': { bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity' },
  queued: { bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'queued' },
  done: { bucket: 'none', tone: 'success', shape: 'filled', pulse: false, label: 'done' },
  cancelled: { bucket: 'none', tone: 'neutral', shape: 'filled', pulse: false, label: 'cancelled' },
  unseen: { bucket: 'unseen', tone: 'accent', shape: 'filled', pulse: false, label: 'unseen' },
};

const CAPACITY: Attention = { rung: 'waiting-for-capacity', ...PRESENTATION_OF_RUNG['waiting-for-capacity'] };

function attentionOfRung(rung: AttentionRung): Attention {
  return rung === 'waiting-for-capacity' ? CAPACITY : { rung, ...PRESENTATION_OF_RUNG[rung] };
}

/** A worker wait owes its wake as a resolved list entry (hearsay-tools/cezarion#1235, #1301). */
function owesWorkerWake(run: AttentionInput): boolean {
  return Array.isArray(run.waits) && run.waits.some((wait) => wait?.kind === 'worker' && wait.phase === 'resolved');
}

/** Worker waits in the list include Cezar's completion wait (hearsay-tools/cezarion#1301).
 * A worker waits outside itself on its parent (ring); a root waits on its own workers (robot). */
function workerAttention(run: AttentionInput, waitingOn: Extract<WaitingOn, { kind: 'workers' }>): Attention {
  const attention = attentionOfRung('waiting-on-workers');
  if (run.delegation?.role === 'worker') return { ...attention, shape: 'ring', label: 'waiting on parent reply' };
  if (waitingOn.replies) return { ...attention, label: 'waiting on worker replies' };
  const count = waitingOn.count;
  return { ...attention, label: count ? `waiting on ${count} worker${count === 1 ? '' : 's'}` : attention.label };
}

/** The parked portion of the ladder, after human, review and running attention. */
function parkedRung(run: AttentionInput, waitingOn: WaitingOn | undefined): AttentionRung | undefined {
  if (run.status !== 'waiting' && run.status !== 'queued') return undefined;
  // A usage-limit hold waits for its appointment, not for a slot (phase 4a).
  if (waitingOn?.kind === 'usage-limit') return 'usage-limit';
  // Workers' owed wake outranks their retained CI and timer waits (hearsay-tools/cezarion#1233).
  // This includes a queued leftover after restart or Continue.
  if (run.delegation?.role !== 'invalid' && owesWorkerWake(run)) return 'waiting-for-capacity';
  if (run.status !== 'waiting') return undefined;
  switch (waitingOn?.kind) {
    case 'workers': return 'waiting-on-workers';
    case 'pr': return waitingOn.until === 'merge' ? 'waiting-for-merge' : 'waiting-for-ci';
    case 'process': return 'waiting-for-command';
    case 'timer': return 'monitoring';
  }
  // A resolved CI or timer wait owes a wake, never a human gate.
  if (waitingOn === undefined && hasResolvedWait(run)) return 'waiting-for-capacity';
  // Nothing open and nothing owed: the turn ended on the user.
  return 'needs-you';
}

type RungDecision = (run: AttentionInput, waitingOn: WaitingOn | undefined) => AttentionRung | undefined;

/** Permission and failure short-circuit before reading waits. The remaining decisions stay
 * in ladder order, with cancelled as the final fallback. */
const ATTENTION_LADDER: readonly RungDecision[] = [
  // A shown question wins at any live status; an unshown one wins only after the turn parks.
  (run, waitingOn) => waitingOn?.kind === 'human' && (waitingOn.shown || run.status === 'waiting') ? 'needs-you' : undefined,
  (run) => run.status === 'review' ? 'needs-review' : undefined,
  (run) => run.status === 'running' ? 'running' : undefined,
  parkedRung,
  (run) => isUnseen(run) ? 'unseen' : undefined,
  (run) => run.status === 'queued' ? 'queued' : undefined,
  (run) => run.status === 'done' ? 'done' : undefined,
];

function attentionRung(run: AttentionInput, waitingOn: WaitingOn | undefined): AttentionRung {
  for (const decide of ATTENTION_LADDER) {
    const rung = decide(run, waitingOn);
    if (rung !== undefined) return rung;
  }
  return 'cancelled';
}

/**
 * `RunRecord` → attention: the spec's ladder (2026-10-17-unified-waits, "Status and display"),
 * read from the wait list alone since phase 4b (hearsay-tools/cezarion#1236).
 * First match wins. Presentation comes from one rung table, with worker wording built separately.
 */
export function deriveAttention(run: AttentionInput): Attention {
  if (hasPendingPermission(run)) return attentionOfRung('needs-permission');
  if (run.status === 'failed') return attentionOfRung('failed');
  const live = run.status === 'waiting' || run.status === 'queued' || run.status === 'running';
  const waitingOn = live ? resolveWaitingOn(run) : undefined;
  const rung = attentionRung(run, waitingOn);
  if (rung === 'waiting-on-workers' && waitingOn?.kind === 'workers') return workerAttention(run, waitingOn);
  return attentionOfRung(rung);
}

/**
 * The task states a project's webhook can send deliveries for (hearsay-tools/cezarion#1356),
 * named as the cockpit names them. `waiting-other` is every wait kind without an option of its
 * own, including kinds added later. A change that gives a kind its own option adds that option,
 * by config migration, to every stored list holding `waiting-other`.
 */
export const WEBHOOK_TRIGGERS = [
  'needs-you',
  'failed',
  'done',
  'cancelled',
  'running',
  'waiting-workers',
  'waiting-ci',
  'waiting-timer',
  'waiting-other',
] as const;

export type WebhookTrigger = (typeof WEBHOOK_TRIGGERS)[number];

/** What a webhook with no stored `triggers` sends: the states that end a task or need a person. */
export const DEFAULT_WEBHOOK_TRIGGERS: readonly WebhookTrigger[] = ['needs-you', 'failed', 'done', 'cancelled'];

/**
 * The webhook state of each rung (hearsay-tools/cezarion#1356). A run the dot shows as parked on a
 * clock or a free slot — queued, a usage limit's resume, waiting for capacity — is in no state and
 * sends nothing. A merge wait is not CI: the trigger names keep their wording
 * (hearsay-tools/cezarion#1425). Exhaustive: a new rung fails to compile until it says.
 */
const WEBHOOK_STATE_OF_RUNG: Record<AttentionRung, WebhookTrigger | undefined> = {
  'needs-permission': 'needs-you',
  failed: 'failed',
  'needs-you': 'needs-you',
  'needs-review': 'needs-you',
  running: 'running',
  'usage-limit': undefined,
  'waiting-on-workers': 'waiting-workers',
  'waiting-for-ci': 'waiting-ci',
  'waiting-for-merge': 'waiting-other',
  'waiting-for-command': 'waiting-other',
  monitoring: 'waiting-timer',
  'waiting-for-capacity': undefined,
  queued: undefined,
  done: 'done',
  cancelled: 'cancelled',
  unseen: undefined,
};

/**
 * `RunRecord` → the webhook state it is in, or `undefined` for none (hearsay-tools/cezarion#1356).
 *
 * Read off `deriveAttention`'s rung, so the webhook and the status dot never disagree. A waiting
 * run on rung 3 reads its top wait: a wait kind the dot has no rung for reads as Needs you there
 * and as `waiting-other` here, since nobody is asked anything.
 */
export function deriveWebhookState(run: AttentionInput): WebhookTrigger | undefined {
  const { rung } = deriveAttention(run);
  if (rung === 'needs-you' && run.status === 'waiting') {
    const kind = resolveWaitingOn(run)?.kind;
    return kind === undefined || kind === 'human' ? 'needs-you' : 'waiting-other';
  }
  return WEBHOOK_STATE_OF_RUNG[rung];
}
