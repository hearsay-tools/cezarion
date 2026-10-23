import type { WorkerWait } from './delegation.ts';
import type { RunIndexEntry, RunRecord, RunSummary } from './runs.ts';
import { hasResolvedWait, resolveWaitingOn } from './waits.ts';

/**
 * The one canonical attention function (cockpit spec, "Design system" → status grammar).
 *
 * Every surface that says "this run wants you" derives it from here: the cockpit's quick-list
 * dot, the table's dot, the thread header, the browser notification — and, since #553/#609, the
 * `cez task` CLI (`status`/`list` rows, and the `wait --until attention` decision). One function
 * means those can never disagree, which is the whole point of naming it in the spec. Before it
 * moved here the CLI kept its own two-line "is this settled" and the two drifted: a root parked
 * on its own workers stopped a CLI attention wait that the cockpit showed as "waiting on
 * 2 workers" (#553), and an operator cleared a run on a pending-question flag while the
 * cockpit showed Needs You (#609).
 *
 * Deliberately UI-free and Node-free: no React, no class names, no tokens, no `node:*` (the
 * contract tsconfig makes that structural). It maps a run to a bucket, a tone name and whether
 * the dot pulses; the components decide what those look like, the CLI prints the bucket and
 * the label. That is also what lets the cockpit's notification path call it from outside a
 * component tree.
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

export interface Attention {
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
 * Whether a run finished while the user was not looking.
 *
 * Still always false here, but now by DESIGN rather than for want of data. The "finished while
 * you weren't looking" question is answered by the cockpit's read/unread channel
 * (#unread-done-items): `RunRecord.seenAt` + `isUnread()` in the cockpit's `lib/read-state.ts`.
 * That signal is deliberately kept OFF the status dot — the dot keeps saying done/failed, and
 * unread rides its own trailing violet marker (the approved "Option B") so status and "have I
 * seen it" never collapse into one dot. Routing unread through this `unseen` bucket would recolor
 * the status dot violet, which is exactly the conflation that design avoids, so the bucket stays
 * reserved and unused. Like `hasPendingPermission`, it reads no cockpit-only state, so nothing
 * here needs injecting for the CLI to reproduce the cockpit's answer.
 */
function isUnseen(_run: AttentionInput): boolean {
  return false;
}

/** What attention derivation actually reads. `Pick`ed rather than the full `RunRecord` so
 *  surfaces that only have a status — the cockpit compare view's `GroupVariant` columns — can use
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

const CAPACITY: Attention = { bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity' };

/** A worker wait owes its wake as a resolved list entry (hearsay-tools/cezarion#1235, #1301). */
function owesWorkerWake(run: AttentionInput): boolean {
  return Array.isArray(run.waits) && run.waits.some((wait) => wait?.kind === 'worker' && wait.phase === 'resolved');
}

/**
 * `RunRecord` → attention: the spec's ladder (2026-10-17-unified-waits, "Status and display"),
 * read from the wait list alone since phase 4b (hearsay-tools/cezarion#1236).
 *
 * The chain below *is* the priority order — first match wins, so `error` can never be masked by a
 * lower rung. Tones follow the cockpit mockups (`mockups/tasks-home.html`):
 *
 *  - Needs you → amber/pending: the agent stopped and is asking you something.
 *  - `review`/permission → blue `--info`: there is work to look at (was brand teal until #617).
 *  - `running` → the violet family (`--status-running`), pulsing and filled; a CI or timer park is
 *    the same hue as a ring, and a parked parent is the same hue as the robot (#617 status key).
 *  - `queued`/usage limit → neutral ring, still: parked, not transitioning. `cancelled` shares the
 *    neutral hue but is filled — it has ended.
 *  - `done`/`failed` → the green/red outcome, still.
 */
export function deriveAttention(run: AttentionInput): Attention {
  if (hasPendingPermission(run)) {
    return { bucket: 'permission', tone: 'info', shape: 'filled', pulse: true, label: 'needs permission' };
  }
  if (run.status === 'failed') {
    return { bucket: 'error', tone: 'danger', shape: 'filled', pulse: false, label: 'failed' };
  }
  const live = run.status === 'waiting' || run.status === 'queued' || run.status === 'running';
  const waitingOn = live ? resolveWaitingOn(run) : undefined;
  // Rung 3: a question the user sees waits on them at any live status, a wake turn's included. One
  // registered mid-turn and not shown yet reads as the turn it is in until its turn end shows it.
  if (waitingOn?.kind === 'human' && (waitingOn.shown || run.status === 'waiting')) {
    return { bucket: 'waiting', tone: 'pending', shape: 'filled', pulse: true, label: 'needs you' };
  }
  if (run.status === 'review') {
    return { bucket: 'waiting', tone: 'info', shape: 'filled', pulse: true, label: 'needs review' };
  }
  if (run.status === 'running') {
    return { bucket: 'running', tone: 'running', shape: 'filled', pulse: true, label: 'running' };
  }
  if (run.status === 'waiting' || run.status === 'queued') {
    // A usage-limit hold waits for its appointment, not for a slot (phase 4a).
    if (waitingOn?.kind === 'usage-limit') {
      return { bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'usage limit' };
    }
    // A queued automatic wake is a scheduler/capacity wait, not a human gate (#971). Covers both
    // the parked session still open (`waiting`) and a leftover after restart / Continue
    // (`queued`). Workers already settled. Ahead of the CI and timer rungs: workers outrank them,
    // and a worker park keeps its open waits (hearsay-tools/cezarion#1233).
    if (run.delegation?.role !== 'invalid' && owesWorkerWake(run)) return CAPACITY;
  }
  if (run.status === 'waiting') {
    if (waitingOn?.kind === 'workers') {
      // Worker waits in the list (hearsay-tools/cezarion#1235), Cezar's completion wait included
      // (hearsay-tools/cezarion#1301). Its own workers → the robot; a worker waiting on its parent
      // is waiting on something outside it → a ring. Both violet: still in motion, just not on
      // this turn. A root with only request waits waits on replies.
      if (run.delegation?.role === 'worker') return { bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting on parent reply' };
      if (waitingOn.replies) return { bucket: 'none', tone: 'running', shape: 'workers', pulse: false, label: 'waiting on worker replies' };
      const count = waitingOn.count;
      return {
        bucket: 'none', tone: 'running', shape: 'workers', pulse: false,
        label: count ? `waiting on ${count} worker${count === 1 ? '' : 's'}` : 'waiting on workers',
      };
    }
    // A CI or timer park is `waiting` on its own downstream work, not on you: it keeps the
    // running bucket and ring the monitoring activity gave it before the wait list.
    if (waitingOn?.kind === 'pr') return { bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: waitingOn.until === 'merge' ? 'waiting for merge' : 'waiting for CI' };
    if (waitingOn?.kind === 'process') return { bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'waiting for a command' };
    if (waitingOn?.kind === 'timer') return { bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'monitoring' };
    // A resolved CI or timer wait owes the agent a wake that has not started: the same scheduler
    // wait as the worker wake above, never a human gate (rung 10).
    if (waitingOn === undefined && hasResolvedWait(run)) return CAPACITY;
    // Nothing open and nothing owed: the turn ended on the user.
    return { bucket: 'waiting', tone: 'pending', shape: 'filled', pulse: true, label: 'needs you' };
  }
  if (isUnseen(run)) {
    return { bucket: 'unseen', tone: 'accent', shape: 'filled', pulse: false, label: 'unseen' };
  }
  if (run.status === 'queued') {
    return { bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'queued' };
  }
  if (run.status === 'done') {
    return { bucket: 'none', tone: 'success', shape: 'filled', pulse: false, label: 'done' };
  }
  return { bucket: 'none', tone: 'neutral', shape: 'filled', pulse: false, label: 'cancelled' };
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
 * `RunRecord` → the webhook state it is in, or `undefined` for none (hearsay-tools/cezarion#1356).
 *
 * Read off `deriveAttention`, so the webhook and the status dot never disagree: a run the dot
 * shows as parked on a clock or a free slot — `queued`, a usage limit's resume, waiting for
 * capacity — is in no state and sends nothing. A wait kind the dot has no rung for
 * reads as Needs you there and as `waiting-other` here, since nobody is asked anything.
 */
export function deriveWebhookState(run: AttentionInput): WebhookTrigger | undefined {
  const attention = deriveAttention(run);
  if (attention.bucket === 'permission') return 'needs-you';
  if (attention.bucket === 'error') return 'failed';
  // A question the user sees during a wake turn or in the line (rung 3); a waiting run reads
  // its top wait below.
  if (attention.label === 'needs you' && run.status !== 'waiting') return 'needs-you';
  switch (run.status) {
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'running';
    case 'review':
      return 'needs-you';
    case 'waiting':
      break;
    default:
      return undefined;
  }
  if (attention.label === 'waiting for capacity') return undefined;
  const waitingOn = resolveWaitingOn(run);
  switch (waitingOn?.kind) {
    case undefined:
    case 'human':
      return 'needs-you';
    case 'workers':
      return 'waiting-workers';
    case 'pr':
      // The webhook trigger names keep their wording; a merge wait is not CI (hearsay-tools/cezarion#1425).
      return waitingOn.until === 'merge' ? 'waiting-other' : 'waiting-ci';
    case 'timer':
      return 'waiting-timer';
    case 'usage-limit':
      return undefined;
    default:
      return 'waiting-other';
  }
}
