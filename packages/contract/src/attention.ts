import type { RunIndexEntry, RunRecord } from './runs.ts';

/**
 * The one canonical attention function (cockpit spec, "Design system" → status grammar).
 *
 * Every surface that says "this run wants you" derives it from here: the cockpit's quick-list
 * dot, the table's dot, the thread header, the browser notification — and, since #553/#609, the
 * `cez task` CLI (`status`/`list` rows, and the `wait --until attention` decision). One function
 * means those can never disagree, which is the whole point of naming it in the spec. Before it
 * moved here the CLI kept its own two-line "is this settled" and the two drifted: a root parked
 * on its own workers stopped a CLI attention wait that the cockpit showed as "waiting on
 * 2 workers" (#553), and an operator cleared a run on `hasPendingHumanAsk: false` while the
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

/**
 * Whether a run is blocked on a permission prompt.
 *
 * Always false today, on purpose. The `permission` bucket is in the ladder because the spec puts
 * it there and because R2 reserves the `permission.*` agent events that will feed it — but cezar
 * emits none of them yet, and `RunRecord` carries no field that means "a tool wants approval".
 * Inventing one (say, treating every `waiting` as a permission prompt) would put a bucket in the
 * UI that no data backs. So the slot stays, wired to the truth: nothing.
 *
 * When R2 lands the events, this is the only function that changes. It reads the record alone —
 * no cockpit-only state — so the CLI and the cockpit answer it identically.
 */
function hasPendingPermission(_run: AttentionInput): boolean {
  return false;
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
 *  the same canonical function instead of inventing a second status-to-tone mapping. `activity`
 *  is optional (#490), so status-only callers keep working unchanged. Delegation uses the slim
 *  contract projection: full run records, `ApiRun`s and workspace index rows all carry it. */
export type AttentionInput = Pick<RunRecord, 'status' | 'activity' | 'autoResumeAt' | 'hasPendingHumanAsk'> & Pick<RunIndexEntry, 'delegation'>;

/** Dependency wording shared by attention and relationship details (#375). A worker can only
 * wait on requests to its parent; only roots can wait for worker completion. */
export function delegationWaitLabel(delegation: AttentionInput['delegation']): string | undefined {
  if (!delegation || delegation.role === 'invalid' || !delegation.wait) return undefined;
  if (delegation.wait.requestIds?.length) {
    return delegation.role === 'worker' ? 'waiting on parent reply' : 'waiting on worker replies';
  }
  if (delegation.role !== 'root') return undefined;
  // A full `RunRecord` carries the worker ids (#617: "waiting on 2 workers"); the slim index
  // projection the global list and the palette read does not, and there the count is not claimed.
  // The count is the workers still OWED an outcome: a wait-for-all stays `parked` after one of two
  // has reported, and "waiting on 2" would then overstate it. None left, or nothing to count
  // from, says no number.
  const wait = delegation.wait as { workerIds?: readonly string[]; outcomes?: readonly { workerId: string }[] };
  const reported = new Set(wait.outcomes?.map((outcome) => outcome.workerId));
  const workers = wait.workerIds?.filter((id) => !reported.has(id)).length;
  return workers ? `waiting on ${workers} worker${workers === 1 ? '' : 's'}` : 'waiting on workers';
}

/**
 * `RunRecord` → attention.
 *
 * The chain below *is* the priority order — first match wins, so `error` can never be masked by a
 * lower rung. Tones follow the cockpit mockups (`mockups/tasks-home.html`):
 *
 *  - `waiting` → amber/pending: the agent stopped and is asking you something.
 *  - `review`/permission → blue `--info`: there is work to look at (was brand teal until #617).
 *  - `running` → the violet family (`--status-running`), pulsing and filled; `monitoring` is the
 *    same hue as a ring, and a parked parent is the same hue as the robot (#617 status key).
 *  - `queued`/`scheduled` → neutral ring, still: parked, not transitioning. `cancelled` shares the
 *    neutral hue but is filled — it has ended.
 *  - `done`/`failed` → the green/red outcome, still.
 */
export function deriveAttention(run: AttentionInput, hasPendingHumanAsk = false): Attention {
  if (hasPendingPermission(run)) {
    return { bucket: 'permission', tone: 'info', shape: 'filled', pulse: true, label: 'needs permission' };
  }
  // A run a provider usage limit stopped is `failed` on the record, but it is not an outcome —
  // it is a task with an appointment (spec 2026-08-03-auto-resume-after-usage-limit). Painting
  // it red would report a failure that is about to undo itself, and putting it in the `error`
  // bucket would notify the user about work that needs nothing from them. It reads as parked,
  // like `queued`: amber, still, and asking for nothing. Ahead of the `failed` rung because the
  // chain is first-match-wins.
  if (run.status === 'failed' && run.autoResumeAt) {
    return { bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'scheduled' };
  }
  if (run.status === 'failed') {
    return { bucket: 'error', tone: 'danger', shape: 'filled', pulse: false, label: 'failed' };
  }
  const dependencyLabel = delegationWaitLabel(run.delegation);
  if (!hasPendingHumanAsk && !run.hasPendingHumanAsk && run.status === 'waiting' && run.delegation?.role !== 'invalid' && run.delegation?.wait?.phase === 'parked' && dependencyLabel) {
    // Its own workers → the robot; a worker waiting on its parent is waiting on something
    // outside it → a ring. Both violet: still in motion, just not on this turn.
    return { bucket: 'none', tone: 'running', shape: run.delegation.role === 'root' ? 'workers' : 'ring', pulse: false, label: dependencyLabel };
  }
  if (run.status === 'waiting') {
    return { bucket: 'waiting', tone: 'pending', shape: 'filled', pulse: true, label: 'needs you' };
  }
  if (run.status === 'review') {
    return { bucket: 'waiting', tone: 'info', shape: 'filled', pulse: true, label: 'needs review' };
  }
  if (run.status === 'running' && run.activity === 'monitoring') {
    // Still working, but on its OWN downstream work (a sub-agent / a monitored
    // command), not on you (#490). A sub-state of `running`, so it stays in the
    // `running` bucket — no notification, no "Needs you" — with its own label.
    return { bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'monitoring' };
  }
  if (run.status === 'running') {
    return { bucket: 'running', tone: 'running', shape: 'filled', pulse: true, label: 'running' };
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
