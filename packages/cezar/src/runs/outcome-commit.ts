import type { AgentInput, Wait } from '@open-mercato/cezar-contract';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { LAST_WAITS_LIMIT } from '@open-mercato/cezar-contract/waits';
import { waitInputId } from '../workflows/waits.ts';
import type { RunRecord } from './store.ts';

/**
 * Outcome writes (hearsay-tools/cezarion#1805). A write that records an outcome — an input or a
 * wait `delivered`, a wake `charged`, a wait `settled`, a question `answered` — is staged here, with
 * what it depends on, and committed by `RunStore.commitOutcome` in one transaction. Nothing outside
 * this module writes those fields: the `outcome-write-outside-commit-outcome` ast-grep rule refuses
 * one. A conversation request outcome is the one exception: `RunStore.commitConversation` commits
 * it with the recipient's reply input, in one transaction of its own.
 *
 * hearsay-tools/cezarion#1250 shipped three orderings this closes: a wake delivered before its
 * charge was saved, a counter write that threw past Finish, and a Continue that settled its human
 * wait before saving the answer. `outcome-crash.testkit.ts` reads the committed row after every
 * write, so a split commit fails the parity cells that use it.
 */
export type RunOutcome =
  /** Each named undelivered input is delivered at `at` (an observable harness still owes its read:
   *  `awaitingRead`); each resolved wait among them (input id = wait id) settles `delivered`. An input
   *  already delivered keeps its time. Open waits stay open. */
  | { kind: 'delivered'; inputIds: readonly string[]; at: string; awaitingRead?: true }
  /** The model read each named delivered input (#505). Never un-sets `deliveredAt`. */
  | { kind: 'consumed'; inputIds: readonly string[]; at: string }
  /** The opening turn handled its instruction: delivered and read. The continuation must name it. */
  | { kind: 'opening-handled'; inputId: string; at: string }
  /** Accepted input the harness never read returns to the queue (#505): its receipts go. */
  | { kind: 'requeued'; inputIds: readonly string[] }
  /** An inbox read's receipt: every member is delivered, and the receipt acknowledged, at `at`. */
  | { kind: 'inbox-acknowledged'; receiptId: string; at: string }
  /** The user answered: each open human wait (or only those named) settles `delivered`. */
  | { kind: 'answered'; waitIds?: readonly string[] }
  /** Each named open or resolved wait settles `cancelled`, and its undelivered wake input goes.
   *  `superseded`: the runner resumed the parent itself, which a subagent wait records as its result
   *  (hearsay-tools/cezarion#2431). */
  | { kind: 'cancelled'; waitIds: readonly string[]; superseded?: true }
  /** A deferred human message reached the session: its persisted queue entry goes. */
  | { kind: 'message-delivered'; messageId: string }
  /** The automatic-wake budget spent so far: a charge, or 0 when the user restarts it. */
  | { kind: 'charged'; automaticWakes: number }
  /** The failed wake-delivery count; `undefined` clears it. */
  | { kind: 'counted'; waitDeliveryFailures: number | undefined };

/** The record fields only an outcome writes. */
type OutcomeField = 'agentInputs' | 'waits' | 'lastWaits' | 'queuedMessages' | 'automaticWakes' | 'waitDeliveryFailures';

/** What an outcome depends on, committed with it. */
export interface OutcomeDependencies {
  /** Fields that are not outcomes, already normalized by the caller (status, activity, the
   *  continuation, …). */
  patch?: Partial<Omit<RunRecord, OutcomeField | 'id' | 'steps' | 'delegation'>>;
  /** The step that resumes with the outcome: a `waiting` one reads `running`. */
  resumeStepId?: string | undefined;
  /** Inputs accepted with the outcome, appended to the queue (an input whose id is queued stays). */
  enqueue?: readonly AgentInput[];
}

export interface StagedOutcome {
  next: RunRecord;
  /** False when nothing would change: the store then writes nothing. */
  changed: boolean;
  /** The human waits an `answered` outcome settled. */
  answered: string[];
}

/** A wait list as the record stores it: absent when empty. */
function nonEmpty(waits: Wait[]): Wait[] | undefined {
  return waits.length ? waits : undefined;
}

/** Append settled waits to the history, newest last, dropping the oldest past `LAST_WAITS_LIMIT`. */
function settle(run: RunRecord, settled: readonly Wait[]): RunRecord {
  const ids = new Set(settled.map((wait) => wait.id));
  return { ...run, waits: nonEmpty((run.waits ?? []).filter((wait) => !ids.has(wait.id))),
    lastWaits: nonEmpty([...(run.lastWaits ?? []), ...settled].slice(-LAST_WAITS_LIMIT)) };
}

/** `run.agentInputs` with `change` applied to each input it returns a new object for. */
function mapInputs(run: RunRecord, change: (input: AgentInput) => AgentInput): { run: RunRecord; changed: boolean } {
  if (!run.agentInputs) return { run, changed: false };
  let changed = false;
  const agentInputs = run.agentInputs.map((input) => {
    const next = change(input);
    if (next !== input) changed = true;
    return next;
  });
  return changed ? { run: { ...run, agentInputs }, changed } : { run, changed };
}

type Step = { run: RunRecord; changed: boolean };
type Handler<K extends RunOutcome['kind']> = (run: RunRecord, outcome: Extract<RunOutcome, { kind: K }>, answered: string[]) => Step;
const unchanged = (run: RunRecord): Step => ({ run, changed: false });

/** One handler per outcome kind: each stages its own fields and says whether anything changed. */
const APPLY: { [K in RunOutcome['kind']]: Handler<K> } = {
  delivered(run, outcome) {
    const ids = new Set(outcome.inputIds);
    const waits = (run.waits ?? []).filter((wait) => wait.phase === 'resolved' && ids.has(waitInputId(wait)));
    const awaiting = outcome.awaitingRead ? { awaitingRead: true as const } : {};
    const inputs = mapInputs(run, (input) => ids.has(input.id) && !input.deliveredAt ? { ...input, deliveredAt: outcome.at, ...awaiting } : input);
    if (!waits.length) return inputs;
    return { run: settle(inputs.run, waits.map((wait) => ({ ...wait, phase: 'delivered' as const, deliveredAt: outcome.at }))), changed: true };
  },
  consumed(run, outcome) {
    return mapInputs(run, (input) => {
      if (!outcome.inputIds.includes(input.id) || !input.deliveredAt || input.consumedAt) return input;
      const { awaitingRead: _awaiting, ...read } = input;
      return { ...read, consumedAt: outcome.at };
    });
  },
  'opening-handled'(run, outcome) {
    if (run.continuationMessage?.agentInputId !== outcome.inputId || !run.agentInputs?.some((input) => input.id === outcome.inputId)) {
      throw new Error('opening agent input checkpoint changed');
    }
    const handled = mapInputs(run, (input) => {
      if (input.id !== outcome.inputId) return input;
      const { awaitingRead: _awaiting, ...rest } = input;
      return { ...rest, deliveredAt: input.deliveredAt ?? outcome.at, consumedAt: input.consumedAt ?? outcome.at };
    });
    return { run: { ...handled.run, continuationMessage: undefined }, changed: true };
  },
  requeued(run, outcome) {
    return mapInputs(run, (input) => {
      if (!outcome.inputIds.includes(input.id)) return input;
      const { deliveredAt: _delivered, consumedAt: _consumed, awaitingRead: _awaiting, ...queued } = input;
      return queued;
    });
  },
  'inbox-acknowledged'(run, outcome) {
    return mapInputs(run, (input) => input.inboxClaim?.receiptId === outcome.receiptId
      ? agentInputSchema.parse({ ...input, deliveredAt: outcome.at, inboxClaim: { ...input.inboxClaim, acknowledgedAt: outcome.at } }) : input);
  },
  answered(run, outcome, answered) {
    const waits = (run.waits ?? []).filter((wait) => wait.kind === 'human' && wait.phase === 'open' && (!outcome.waitIds || outcome.waitIds.includes(wait.id)));
    if (!waits.length) return unchanged(run);
    const deliveredAt = new Date().toISOString();
    answered.push(...waits.map((wait) => wait.id));
    return { run: settle(run, waits.map((wait) => ({ ...wait, phase: 'delivered' as const, deliveredAt }))), changed: true };
  },
  cancelled(run, outcome) {
    const waits = (run.waits ?? []).filter((wait) => outcome.waitIds.includes(wait.id) && (wait.phase === 'open' || wait.phase === 'resolved'));
    if (!waits.length) return unchanged(run);
    const cancelledAt = new Date().toISOString();
    const inputs = new Set(waits.map(waitInputId));
    const next = settle(run, waits.map((wait): Wait => wait.kind === 'subagent' && outcome.superseded
      ? { ...wait, phase: 'cancelled', cancelledAt, result: { reason: 'superseded' } } : { ...wait, phase: 'cancelled', cancelledAt }));
    return { run: { ...next, ...(run.agentInputs ? { agentInputs: run.agentInputs.filter((input) => !inputs.has(input.id) || input.deliveredAt) } : {}) }, changed: true };
  },
  'message-delivered'(run, outcome) {
    const queuedMessages = (run.queuedMessages ?? []).filter((message) => message.id !== outcome.messageId);
    return queuedMessages.length === (run.queuedMessages ?? []).length ? unchanged(run) : { run: { ...run, queuedMessages }, changed: true };
  },
  charged(run, outcome) {
    return run.automaticWakes === outcome.automaticWakes ? unchanged(run) : { run: { ...run, automaticWakes: outcome.automaticWakes }, changed: true };
  },
  counted(run, outcome) {
    return run.waitDeliveryFailures === outcome.waitDeliveryFailures ? unchanged(run)
      : { run: { ...run, waitDeliveryFailures: outcome.waitDeliveryFailures }, changed: true };
  },
};

function applyOne(run: RunRecord, outcome: RunOutcome, answered: string[]): Step {
  return (APPLY[outcome.kind] as Handler<RunOutcome['kind']>)(run, outcome, answered);
}

/**
 * `run` with every outcome applied in order, then what they depend on: the queued inputs, the
 * patch and the resumed step. Pure: the store commits `next`, or writes nothing when nothing changed.
 */
export function applyOutcomes(run: RunRecord, outcomes: readonly RunOutcome[], deps: OutcomeDependencies = {}): StagedOutcome {
  const answered: string[] = [];
  let next = run;
  let changed = false;
  for (const outcome of outcomes) {
    const step = applyOne(next, outcome, answered);
    next = step.run;
    changed ||= step.changed;
  }
  const queued = (deps.enqueue ?? []).map((input) => agentInputSchema.parse(input)).filter((input) => !next.agentInputs?.some((row) => row.id === input.id));
  if (queued.length) { next = { ...next, agentInputs: [...(next.agentInputs ?? []), ...queued] }; changed = true; }
  if (deps.patch && Object.keys(deps.patch).length) { next = { ...next, ...deps.patch }; changed = true; }
  const resumeStepId = deps.resumeStepId;
  if (resumeStepId && next.steps.some((step) => step.id === resumeStepId && step.status === 'waiting')) {
    next = { ...next, steps: next.steps.map((step) => step.id === resumeStepId && step.status === 'waiting' ? { ...step, status: 'running' as const } : step) };
    changed = true;
  }
  return { next, changed, answered };
}
