import { randomUUID } from 'node:crypto';
import type { CiWatcherSupervisor } from '../../ci-wait/supervisor.ts';
import type { TimerWaitEntry, PrWaitEntry, ProcessWaitEntry, WaitVia } from '@open-mercato/cezar-contract';
import type { Wait, WaitPhase, CezarWaitRequest } from '@open-mercato/cezar-contract';
import type { FiredBy } from '../run-states.ts';

/** Each wait kind: its deadline, whether it keeps a slot while it is the top wait, who resolves it. */
export type WaitKindSpec = {
  deadline: 'required' | 'agent-only' | 'none';
  keepsSlot: boolean;
  resolves: readonly { trigger: string; firedBy: FiredBy }[];
  cancels: readonly string[];
  humanOnly?: string;
};

const ENDS_WAITS = ['cezar_cancel_wait', 'a done is accepted', 'Stop', 'Finish', 'delete'] as const;

export type WaitKindRow<K extends Wait['kind']> = WaitKindSpec & {
  answerKind: (wait: Wait) => Exclude<Wait['kind'], 'human' | 'subagent'> | 'request' | undefined;
  hasDeadline: (wait: Wait) => boolean;
  requestKinds: readonly CezarWaitRequest['kind'][];
  delegation: boolean;
  workerListTarget: K extends 'worker' ? (request: Extract<CezarWaitRequest, { kind: 'worker' | 'request' }>) => { workerIds?: string[]; requestIds?: string[]; mode?: 'one' | 'any' | 'all'; timeoutSeconds: number } : undefined;
  chargesWake: K extends 'subagent' ? 'timeout' : boolean;
  refusesSpentBudget: boolean;
  holdsSession: boolean;
  cancellable: K extends 'human' ? 'unshown' : true;
  timersDisabled: K extends 'timer' | 'process' ? true : false;
  userAnswers: boolean;
  holdsConversationInput: boolean;
  runnerResumeCancels: readonly WaitPhase[];
};

export const WAIT_KINDS: { readonly [K in Wait['kind']]: WaitKindRow<K> } = {
  pr: { answerKind: () => 'pr', hasDeadline: () => true, requestKinds: ['pr'], delegation: false,
    workerListTarget: undefined, userAnswers: false, holdsConversationInput: true, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: true, cancels: ENDS_WAITS, resolves: [
    { trigger: 'checks settle or the head changes; a merge wait: merged, closed or a conflict; merge_or_blocked also resolves when no merge remains pending', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 7,200 s, default 1,800) or a fatal gh error', firedBy: 'watcher' },
  ] },
  timer: { answerKind: () => 'timer', hasDeadline: () => true, requestKinds: ['timer'], delegation: false,
    workerListTarget: undefined, userAnswers: false, holdsConversationInput: false, runnerResumeCancels: ['open'],
    chargesWake: true, refusesSpentBudget: true, holdsSession: false, cancellable: true, timersDisabled: true,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the wake budget is spent at its deadline'], resolves: [
    { trigger: 'the deadline (60 to 7,200 s)', firedBy: 'timer' },
  ] },
  process: { answerKind: () => 'process', hasDeadline: () => true, requestKinds: ['process'], delegation: false,
    workerListTarget: undefined, userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: true, refusesSpentBudget: true, holdsSession: false, cancellable: true, timersDisabled: true,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the process is not signalled'], resolves: [
    { trigger: 'the exit file, the process gone, the deadline (up to 7,200 s) or a probe error, polled every 5 s', firedBy: 'watcher' },
  ] },
  subagent: { answerKind: () => undefined, hasDeadline: () => true, requestKinds: [], delegation: false,
    workerListTarget: undefined, userAnswers: false, holdsConversationInput: false, runnerResumeCancels: ['open', 'resolved'],
    chargesWake: 'timeout', refusesSpentBudget: false, holdsSession: true, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the runner starts a parent turn itself', 'every child already ended at the turn end', 'the deadline with the wake budget spent'], resolves: [
    { trigger: 'every child ended and no parent turn started within 15 s', firedBy: 'runner' },
    { trigger: 'the deadline, 30 minutes after the last child event', firedBy: 'timer' },
    { trigger: 'a restart or a lost session: the children stopped', firedBy: 'recovery' },
  ] },
  peer: { answerKind: () => 'peer', hasDeadline: () => true, requestKinds: ['peer'], delegation: true,
    workerListTarget: undefined, userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: true, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: false, cancels: [...ENDS_WAITS, 'the wake budget is spent at its resolution'], resolves: [
    { trigger: 'a message of any kind from a named peer', firedBy: 'peer' },
    { trigger: 'a named peer settles or is deleted', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 1,800 s, default 600)', firedBy: 'timer' },
  ] },
  worker: { answerKind: wait => 'requestIds' in wait && wait.requestIds ? 'request' : 'worker', hasDeadline: wait => 'deadline' in wait && wait.deadline !== undefined, requestKinds: ['worker', 'request'], delegation: true,
    workerListTarget: request => ({ ...(request.kind === 'worker' ? { workerIds: request.worker_ids } : { requestIds: request.request_ids }), ...(request.mode === undefined ? {} : { mode: request.mode }), timeoutSeconds: request.timeout_seconds }), userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'agent-only', keepsSlot: false, cancels: [...ENDS_WAITS, 'the parent settles'], resolves: [
    { trigger: 'the workers report outcomes or the requests get replies, as its mode says', firedBy: 'worker' },
    { trigger: 'the deadline of an agent wait; Cezar\'s completion wait has none', firedBy: 'timer' },
  ] },
  human: { answerKind: () => undefined, hasDeadline: () => false, requestKinds: [], delegation: false,
    workerListTarget: undefined, userAnswers: true, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: 'unshown', timersDisabled: false,
    deadline: 'none', keepsSlot: false, humanOnly: 'The question is the user\'s gate.',
    cancels: ['the agent\'s own wait replaces Cezar\'s', 'a done in the same turn', 'Stop', 'Finish', 'an authored step timeoutMs'],
    resolves: [{ trigger: 'an answer; the parent\'s for a routed worker question', firedBy: 'human' }] },
};


/** One PR, however the agent spelled it: case-insensitive, trailing slash ignored. */
export function normalizePrUrl(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

export function timerWaitEntry(parsed: Extract<CezarWaitRequest, { kind: 'timer' }>, via: WaitVia, turnId: string, now: number) {
  const wait: TimerWaitEntry = { id: randomUUID(), kind: 'timer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
        deadline: new Date(now + parsed.seconds * 1000).toISOString(), phase: 'open', turnId, seconds: parsed.seconds,
        ...(parsed.note === undefined ? {} : { note: parsed.note }) };
  return wait;
}

export function prWaitEntry(identity: Awaited<ReturnType<CiWatcherSupervisor['resolve']>>, parsed: Extract<CezarWaitRequest, { kind: 'pr' }>, via: WaitVia, generation: string, turnId: string, now: number) {
  const wait: PrWaitEntry = { ...identity, id: randomUUID(), kind: 'pr', source: 'agent', via, generation, turnId,
        timeoutSeconds: parsed.timeout_seconds, until: parsed.until, wakeOnConflict: parsed.wake_on_conflict, registeredAt: new Date(now).toISOString(),
        deadline: new Date(now + parsed.timeout_seconds * 1000).toISOString(), phase: 'open' };
  return wait;
}

export function processWaitEntry(request: Extract<CezarWaitRequest, { kind: 'process' }>, via: WaitVia, turnId: string, now: number, startToken: string | undefined, exitFile: string | undefined) {
  const wait: ProcessWaitEntry = { id: randomUUID(), kind: 'process', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + request.timeout_seconds * 1000).toISOString(), phase: 'open', turnId, timeoutSeconds: request.timeout_seconds,
      pid: request.pid, ...(startToken === undefined ? {} : { startToken }), ...(exitFile === undefined ? {} : { exitFile }),
      ...(request.note === undefined ? {} : { note: request.note }) };
  return wait;
}
