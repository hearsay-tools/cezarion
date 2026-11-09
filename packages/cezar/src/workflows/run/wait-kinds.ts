import { randomUUID } from 'node:crypto';
import type { CiWatcherSupervisor } from '../../ci-wait/supervisor.ts';
import type { TimerWaitEntry, PrWaitEntry, ProcessWaitEntry, PeerWaitEntry, WorkerWaitEntry, HumanWaitEntry, CezarWaitRequestInput, WaitVia } from '@open-mercato/cezar-contract';
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
  canonicalize: (request: CezarWaitRequest) => void;
  repeatTimeout: (wait: Wait) => number | undefined;
  requestedTimeout: (request: CezarWaitRequest) => number | undefined;
  duplicateWorker: K extends 'worker' ? typeof identicalWorkerWait : undefined;
  duplicatePeer: K extends 'peer' ? typeof identicalPeerWait : undefined;
  duplicateAsk: K extends 'human' ? (waits: readonly Wait[], answering: number | undefined) => HumanWaitEntry | undefined : undefined;
  duplicateMonitoring: K extends 'timer' ? (waits: readonly Wait[], via: WaitVia) => boolean : undefined;
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
  pr: { canonicalize: request => { if (request.kind === 'pr') request.pr = normalizePrUrl(request.pr); }, repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined, requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
    duplicateWorker: undefined, duplicatePeer: undefined, duplicateAsk: undefined, duplicateMonitoring: undefined, answerKind: () => 'pr', hasDeadline: () => true, requestKinds: ['pr'], delegation: false,
    workerListTarget: undefined, userAnswers: false, holdsConversationInput: true, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: true, cancels: ENDS_WAITS, resolves: [
    { trigger: 'checks settle or the head changes; a merge wait: merged, closed or a conflict; merge_or_blocked also resolves when no merge remains pending', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 7,200 s, default 1,800) or a fatal gh error', firedBy: 'watcher' },
  ] },
  timer: { canonicalize: () => {}, repeatTimeout: wait => 'seconds' in wait ? wait.seconds : undefined, requestedTimeout: () => undefined,
    duplicateWorker: undefined, duplicatePeer: undefined, duplicateAsk: undefined, duplicateMonitoring: (waits, via) => waits.some(wait => wait.phase === 'open' && wait.kind === 'timer' && wait.via === via), answerKind: () => 'timer', hasDeadline: () => true, requestKinds: ['timer'], delegation: false,
    workerListTarget: undefined, userAnswers: false, holdsConversationInput: false, runnerResumeCancels: ['open'],
    chargesWake: true, refusesSpentBudget: true, holdsSession: false, cancellable: true, timersDisabled: true,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the wake budget is spent at its deadline'], resolves: [
    { trigger: 'the deadline (60 to 7,200 s)', firedBy: 'timer' },
  ] },
  process: { canonicalize: () => {}, repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined, requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
    duplicateWorker: undefined, duplicatePeer: undefined, duplicateAsk: undefined, duplicateMonitoring: undefined, answerKind: () => 'process', hasDeadline: () => true, requestKinds: ['process'], delegation: false,
    workerListTarget: undefined, userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: true, refusesSpentBudget: true, holdsSession: false, cancellable: true, timersDisabled: true,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the process is not signalled'], resolves: [
    { trigger: 'the exit file, the process gone, the deadline (up to 7,200 s) or a probe error, polled every 5 s', firedBy: 'watcher' },
  ] },
  subagent: { canonicalize: () => {}, repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined, requestedTimeout: () => undefined,
    duplicateWorker: undefined, duplicatePeer: undefined, duplicateAsk: undefined, duplicateMonitoring: undefined, answerKind: () => undefined, hasDeadline: () => true, requestKinds: [], delegation: false,
    workerListTarget: undefined, userAnswers: false, holdsConversationInput: false, runnerResumeCancels: ['open', 'resolved'],
    chargesWake: 'timeout', refusesSpentBudget: false, holdsSession: true, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the runner starts a parent turn itself', 'every child already ended at the turn end', 'the deadline with the wake budget spent'], resolves: [
    { trigger: 'every child ended and no parent turn started within 15 s', firedBy: 'runner' },
    { trigger: 'the deadline, 30 minutes after the last child event', firedBy: 'timer' },
    { trigger: 'a restart or a lost session: the children stopped', firedBy: 'recovery' },
  ] },
  peer: { canonicalize: () => {}, repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined, requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
    duplicateWorker: undefined, duplicatePeer: identicalPeerWait, duplicateAsk: undefined, duplicateMonitoring: undefined, answerKind: () => 'peer', hasDeadline: () => true, requestKinds: ['peer'], delegation: true,
    workerListTarget: undefined, userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: true, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: false, cancels: [...ENDS_WAITS, 'the wake budget is spent at its resolution'], resolves: [
    { trigger: 'a message of any kind from a named peer', firedBy: 'peer' },
    { trigger: 'a named peer settles or is deleted', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 1,800 s, default 600)', firedBy: 'timer' },
  ] },
  worker: { canonicalize: request => { if ((request.kind === 'worker' || request.kind === 'request') && request.mode === undefined) request.mode = 'any'; }, repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined, requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
    duplicateWorker: identicalWorkerWait, duplicatePeer: undefined, duplicateAsk: undefined, duplicateMonitoring: undefined, answerKind: wait => 'requestIds' in wait && wait.requestIds ? 'request' : 'worker', hasDeadline: wait => 'deadline' in wait && wait.deadline !== undefined, requestKinds: ['worker', 'request'], delegation: true,
    workerListTarget: request => ({ ...(request.kind === 'worker' ? { workerIds: request.worker_ids } : { requestIds: request.request_ids }), ...(request.mode === undefined ? {} : { mode: request.mode }), timeoutSeconds: request.timeout_seconds }), userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'agent-only', keepsSlot: false, cancels: [...ENDS_WAITS, 'the parent settles'], resolves: [
    { trigger: 'the workers report outcomes or the requests get replies, as its mode says', firedBy: 'worker' },
    { trigger: 'the deadline of an agent wait; Cezar\'s completion wait has none', firedBy: 'timer' },
  ] },
  human: { canonicalize: () => {}, repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined, requestedTimeout: () => undefined,
    duplicateWorker: undefined, duplicatePeer: undefined, duplicateAsk: (waits, answering) => waits.find((wait): wait is HumanWaitEntry => wait.phase === 'open' && wait.kind === 'human' && wait.source !== 'cezar' && (answering === undefined || wait.askSeq !== answering)), duplicateMonitoring: undefined, answerKind: () => undefined, hasDeadline: () => false, requestKinds: [], delegation: false,
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

/**
 * The open wait a registration repeats, if any. PR: the same PR, target and conflict switch, whatever
 * its timeout (hearsay-tools/cezarion#1425). Timer: the
 * same seconds and note, registered in the same turn (a later turn asking again means a new check).
 * Process: the same PID, start token and resolved exit file in `context`, whatever its timeout or
 * note (hearsay-tools/cezarion#1446).
 */
export function identicalWait(waits: readonly Wait[], request: CezarWaitRequestInput, turnId: string,
  context: { startToken?: string; exitFile?: string } = {}): PrWaitEntry | TimerWaitEntry | ProcessWaitEntry | undefined {
  return waits.find((wait): wait is PrWaitEntry | TimerWaitEntry | ProcessWaitEntry => {
    // Worker and request waits: `identicalWorkerWait`; peer waits: `identicalPeerWait`.
    if (wait.phase !== 'open' || registersThroughDelegation(request.kind)) return false;
    if (request.kind === 'pr') return wait.kind === 'pr' && normalizePrUrl(wait.prUrl) === normalizePrUrl(request.pr)
      && wait.until === (request.until ?? 'checks') && wait.wakeOnConflict === (request.wake_on_conflict ?? true);
    if (request.kind === 'process') {
      return wait.kind === 'process' && wait.pid === request.pid && wait.startToken === context.startToken && wait.exitFile === context.exitFile;
    }
    return 'seconds' in request && wait.kind === 'timer' && wait.seconds === request.seconds && wait.note === request.note && wait.turnId === turnId;
  });
}

/**
 * The open worker wait a registration repeats (hearsay-tools/cezarion#1235): the same target kind,
 * the same ids in any order and the same mode (`any` when omitted), whatever its timeout.
 */
export function identicalWorkerWait(waits: readonly Wait[], target: { workerIds?: readonly string[]; requestIds?: readonly string[] | undefined; mode?: string | undefined }): WorkerWaitEntry | undefined {
  const key = (ids: readonly string[] | undefined) => ids ? [...ids].sort().join(',') : undefined;
  return waits.find((wait): wait is WorkerWaitEntry => wait.kind === 'worker' && wait.phase === 'open' &&
    key(wait.workerIds) === key(target.workerIds) && key(wait.requestIds) === key(target.requestIds) && (wait.mode ?? 'any') === (target.mode ?? 'any'));
}

/** The open peer wait a registration repeats (hearsay-tools/cezarion#1995): the same peers in any
 *  order, whatever its timeout. */
export function identicalPeerWait(waits: readonly Wait[], peerIds: readonly string[]): PeerWaitEntry | undefined {
  const key = (ids: readonly string[]) => [...ids].sort().join(',');
  return waits.find((wait): wait is PeerWaitEntry => wait.kind === 'peer' && wait.phase === 'open' && key(wait.peerIds) === key(peerIds));
}


/** Whether this request kind registers through the delegation facade. */
export function registersThroughDelegation(kind: CezarWaitRequest['kind']): boolean {
  return Object.values(WAIT_KINDS).some(row => row.delegation && row.requestKinds.includes(kind));
}
