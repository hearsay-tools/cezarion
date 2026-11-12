import type { ActivityPrProgress, ActivityWait, ConversationState, Wait, WorkerWaitEntry } from '@open-mercato/cezar-contract';
import { ACTIVITY_TEXT_MAX } from '@open-mercato/cezar-contract/activity';
import { isLiveStatus } from '@open-mercato/cezar-contract/run-predicates';
import { asksQuestion, computeWaitingOn, workerWaitTargets } from '@open-mercato/cezar-contract/waits';
import type { RunRecord } from '../runs/store.ts';
import { clampText } from './text.ts';

/** The check progress of an open PR wait, by wait id. The CI progress registry implements it.
 *  `projectId` names the project whose snapshot reads the wait: the registry gates its extra
 *  checks reads on that project's demand. */
export interface CiProgressSource {
  read(waitId: string, projectId: string): ActivityPrProgress | undefined;
}

/** The progress of one project's waits: a `CiProgressSource` bound to the project it reads. */
export interface ProjectCiProgress {
  read(waitId: string): ActivityPrProgress | undefined;
}

type OpenOf<K extends Wait['kind']> = Extract<Wait, { kind: K }>;
const openOf = <K extends Wait['kind']>(run: RunRecord, kind: K): OpenOf<K>[] =>
  (run.waits ?? []).filter((wait): wait is OpenOf<K> => wait.kind === kind && wait.phase === 'open');
const earliest = (values: readonly (string | undefined)[]): string | undefined =>
  values.filter((value): value is string => value !== undefined).sort((a, b) => Date.parse(a) - Date.parse(b))[0];

/**
 * A run's top wait, as `computeWaitingOn` names it, so the view and the Tasks list never disagree
 * on what a task waits for. `computeWaitingOn` aggregates worker, peer and subagent entries and
 * names none, so those kinds aggregate every open entry here too. `ledger` holds the family's
 * requests: the root's own, or a worker's parent's.
 */
export function activityWait(run: RunRecord, ledger: ConversationState | undefined, ci: ProjectCiProgress): ActivityWait | undefined {
  if (!isLiveStatus(run.status)) return undefined;
  const waitingOn = computeWaitingOn(run);
  switch (waitingOn?.kind) {
    case undefined: return undefined;
    case 'human': return humanWait(run);
    case 'usage-limit': return { kind: 'usage-limit', detail: { resumeAt: waitingOn.at } };
    case 'workers': return workersWait(openOf(run, 'worker'), waitingOn.count, waitingOn.replies === true, ledger);
    case 'peers': {
      const entries = openOf(run, 'peer');
      return { kind: 'peers', since: earliest(entries.map((entry) => entry.registeredAt))!, deadline: earliest(entries.map((entry) => entry.deadline))!,
        detail: { peerRunIds: [...new Set(entries.flatMap((entry) => entry.peerIds))] } };
    }
    case 'subagents': {
      const entries = openOf(run, 'subagent');
      return { kind: 'subagents', since: earliest(entries.map((entry) => entry.registeredAt))!, deadline: earliest(entries.map((entry) => entry.deadline))!,
        detail: { running: waitingOn.count } };
    }
    case 'pr': {
      const entry = openOf(run, 'pr').find((wait) => wait.id === waitingOn.waitId)!;
      const progress = ci.read(entry.id);
      return { kind: 'pr', since: entry.registeredAt, deadline: waitingOn.deadline, detail: { number: waitingOn.prNumber, target: waitingOn.until, ...progress } };
    }
    case 'process': {
      const entry = openOf(run, 'process').find((wait) => wait.id === waitingOn.waitId)!;
      return { kind: 'process', since: entry.registeredAt, deadline: waitingOn.deadline,
        detail: { pid: waitingOn.pid, ...(waitingOn.note === undefined ? {} : { note: waitingOn.note }) } };
    }
    case 'timer': {
      const entry = openOf(run, 'timer').find((wait) => wait.id === waitingOn.waitId)!;
      return { kind: 'timer', since: entry.registeredAt, deadline: entry.deadline,
        detail: { wakeAt: waitingOn.at, ...(waitingOn.note === undefined ? {} : { note: waitingOn.note }) } };
    }
  }
}

/** A question, or one of Squawk's own waits for the user: a plain turn end, a spent wake budget or
 *  the completion gate. */
function humanWait(run: RunRecord): ActivityWait {
  const entries = openOf(run, 'human');
  const question = entries.find((entry) => entry.questions?.length)?.questions?.[0]?.question;
  const vias = new Set(entries.map((entry) => entry.via));
  const reason = asksQuestion(run) ? 'question' : vias.has('budget') ? 'budget' : vias.has('completion') ? 'completion' : 'turn-end';
  const queuedMessages = (run.agentInputs ?? []).filter((input) => !input.deliveredAt).length;
  return {
    kind: 'human',
    since: earliest(entries.map((entry) => entry.registeredAt))!,
    detail: {
      ...(question === undefined ? {} : { question: clampText(question, ACTIVITY_TEXT_MAX) }),
      reason,
      ...(queuedMessages > 0 ? { queuedMessages } : {}),
    },
  };
}

/** Completion and reply waits, both kind `worker`. `owed` is `computeWaitingOn`'s count; the bar
 *  counts the same targets, each worker or request once however many entries name it
 *  (hearsay-tools/cezarion#2588). A mode is shown only for one entry. */
function workersWait(entries: readonly WorkerWaitEntry[], owed: number, replies: boolean, ledger: ConversationState | undefined): ActivityWait {
  const total = new Set(entries.flatMap((entry) => workerWaitTargets(entry).map((target) => target.key))).size;
  const recipients = new Map((ledger?.messages ?? []).map((message) => [message.id, message.recipientRunId]));
  const recipientRunIds = new Set<string>();
  for (const entry of entries) {
    const answered = new Set(entry.requestOutcomes?.map((outcome) => outcome.requestId));
    for (const id of entry.requestIds ?? []) {
      const recipient = recipients.get(id);
      if (!answered.has(id) && recipient !== undefined) recipientRunIds.add(recipient);
    }
  }
  const mode = entries.length === 1 ? entries[0]!.mode : undefined;
  const deadline = earliest(entries.map((entry) => entry.deadline));
  return {
    kind: 'workers',
    since: earliest(entries.map((entry) => entry.registeredAt))!,
    ...(deadline === undefined ? {} : { deadline }),
    detail: { owed, total, settled: total - owed, ...(replies ? { replies: true as const } : {}), ...(mode === undefined ? {} : { mode }), recipientRunIds: [...recipientRunIds] },
  };
}
