import { TIMER_MIN_SECONDS, TIMER_MAX_SECONDS } from '@open-mercato/cezar-contract/waits';
import { randomUUID } from 'node:crypto';
import type { CiWatcherSupervisor } from '../../ci-wait/supervisor.ts';
import type { TimerWaitEntry, PrWaitEntry, ProcessWaitEntry, PeerWaitEntry, WorkerWaitEntry, HumanWaitEntry, CezarWaitRequestInput, WaitVia, SubagentWaitEntry, SubagentChild } from '@open-mercato/cezar-contract';
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
  watch: 'ci' | 'process' | 'none' | 'worker' | 'peer' | 'subagent' | 'timer';
  answerKind: (wait: Wait) => Exclude<Wait['kind'], 'human' | 'subagent'> | 'request' | undefined;
  hasDeadline: (wait: Wait) => boolean;
  requestKinds: readonly CezarWaitRequest['kind'][];
  delegation: boolean;

  entry: {
    pr: typeof prWaitEntry; timer: typeof timerWaitEntry; process: typeof processWaitEntry;
    peer: typeof peerWaitBuilder; worker: typeof workerWaitBuilder;
    human: typeof askWaitEntry; subagent: typeof subagentWaitEntry;
  }[K];

  duplicate: (wait: Wait, request: CezarWaitRequestInput, turnId: string, context: { startToken?: string; exitFile?: string }) => boolean;
  canonicalize: (request: CezarWaitRequest) => void;
  repeatTimeout: (wait: Wait) => number | undefined;
  requestedTimeout: (request: CezarWaitRequest) => number | undefined;

  chargesWake: K extends 'subagent' ? 'timeout' : boolean;
  refusesSpentBudget: boolean;
  holdsSession: boolean;
  cancellable: K extends 'human' ? 'unshown' : true;
  timersDisabled: K extends 'timer' | 'process' ? true : false;
  userAnswers: boolean;
  holdsConversationInput: boolean;
  runnerResumeCancels: readonly WaitPhase[];
} & {
  pr: {};
  process: {};
  subagent: {};
  worker: {
    completionEntry: typeof completionWaitEntry;
    duplicateWorker: typeof identicalWorkerWait;
    workerListTarget: (request: Extract<CezarWaitRequest, { kind: 'worker' | 'request' }>) => {
      workerIds?: string[]; requestIds?: string[]; mode?: 'one' | 'any' | 'all'; timeoutSeconds: number;
    };
  };
  human: {
    aliasEntry: typeof humanAliasEntry;
    recoveredEntry: typeof recoveredAskEntry;
    aliasSource: (via: WaitVia) => 'agent' | 'cezar';
    duplicateAsk: (waits: readonly Wait[], answering: number | undefined) => HumanWaitEntry | undefined;
  };
  timer: {
    monitoringEntry: typeof monitoringTimerEntry;
    duplicateMonitoring: (waits: readonly Wait[], via: WaitVia) => boolean;
  };
  peer: { duplicatePeer: typeof identicalPeerWait };
}[K];

export const WAIT_KINDS: { readonly [K in Wait['kind']]: WaitKindRow<K> } = {
  pr: { watch: 'ci', entry: prWaitEntry,
    duplicate: (wait, request) => request.kind === 'pr' && wait.kind === 'pr' && normalizePrUrl(wait.prUrl) === normalizePrUrl(request.pr) && wait.until === (request.until ?? 'checks') && wait.wakeOnConflict === (request.wake_on_conflict ?? true),
    canonicalize: request => { if (request.kind === 'pr') request.pr = normalizePrUrl(request.pr); },
    repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
    requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
    answerKind: () => 'pr',
    hasDeadline: () => true,
    requestKinds: ['pr'],
    delegation: false,
    userAnswers: false, holdsConversationInput: true, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: true, cancels: ENDS_WAITS, resolves: [
    { trigger: 'checks settle or the head changes; a merge wait: merged, closed or a conflict; merge_or_blocked also resolves when no merge remains pending', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 7,200 s, default 1,800) or a fatal gh error', firedBy: 'watcher' },
  ] },
  timer: { watch: 'timer', entry: timerWaitEntry,
    monitoringEntry: monitoringTimerEntry,
    duplicate: (wait, request, turnId) => request.kind === 'timer' && wait.kind === 'timer' && wait.seconds === request.seconds && wait.note === request.note && wait.turnId === turnId,
    canonicalize: () => {},
    repeatTimeout: wait => 'seconds' in wait ? wait.seconds : undefined,
    requestedTimeout: () => undefined,
    duplicateMonitoring: (waits, via) => waits.some(wait => wait.phase === 'open' && wait.kind === 'timer' && wait.via === via),
    answerKind: () => 'timer',
    hasDeadline: () => true,
    requestKinds: ['timer'],
    delegation: false,
    userAnswers: false, holdsConversationInput: false, runnerResumeCancels: ['open'],
    chargesWake: true, refusesSpentBudget: true, holdsSession: false, cancellable: true, timersDisabled: true,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the wake budget is spent at its deadline'], resolves: [
    { trigger: 'the deadline (60 to 7,200 s)', firedBy: 'timer' },
  ] },
  process: { watch: 'process', entry: processWaitEntry,
    duplicate: (wait, request, _turnId, context) => request.kind === 'process' && wait.kind === 'process' && wait.pid === request.pid && wait.startToken === context.startToken && wait.exitFile === context.exitFile,
    canonicalize: () => {},
    repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
    requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
    answerKind: () => 'process',
    hasDeadline: () => true,
    requestKinds: ['process'],
    delegation: false,
    userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: true, refusesSpentBudget: true, holdsSession: false, cancellable: true, timersDisabled: true,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the process is not signalled'], resolves: [
    { trigger: 'the exit file, the process gone, the deadline (up to 7,200 s) or a probe error, polled every 5 s', firedBy: 'watcher' },
  ] },
  subagent: { watch: 'subagent', entry: subagentWaitEntry,
    duplicate: () => false,
    canonicalize: () => {},
    repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
    requestedTimeout: () => undefined,
    answerKind: () => undefined,
    hasDeadline: () => true,
    requestKinds: [],
    delegation: false,
    userAnswers: false, holdsConversationInput: false, runnerResumeCancels: ['open', 'resolved'],
    chargesWake: 'timeout', refusesSpentBudget: false, holdsSession: true, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the runner starts a parent turn itself', 'every child already ended at the turn end', 'the deadline with the wake budget spent'], resolves: [
    { trigger: 'every child ended and no parent turn started within 15 s', firedBy: 'runner' },
    { trigger: 'the deadline, 30 minutes after the last child event', firedBy: 'timer' },
    { trigger: 'a restart or a lost session: the children stopped', firedBy: 'recovery' },
  ] },
  peer: { watch: 'peer', entry: peerWaitBuilder,
    duplicate: () => false,
    canonicalize: () => {},
    repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
    requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
    duplicatePeer: identicalPeerWait,
    answerKind: () => 'peer',
    hasDeadline: () => true,
    requestKinds: ['peer'],
    delegation: true,
    userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: true, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: false, cancels: [...ENDS_WAITS, 'the wake budget is spent at its resolution'], resolves: [
    { trigger: 'a message of any kind from a named peer', firedBy: 'peer' },
    { trigger: 'a named peer settles or is deleted', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 1,800 s, default 600)', firedBy: 'timer' },
  ] },
  worker: { watch: 'worker', entry: workerWaitBuilder,
    completionEntry: completionWaitEntry,
    duplicate: () => false,
    canonicalize: request => { if ((request.kind === 'worker' || request.kind === 'request') && request.mode === undefined) request.mode = 'any'; },
    repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
    requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
    duplicateWorker: identicalWorkerWait,
    answerKind: wait => 'requestIds' in wait && wait.requestIds ? 'request' : 'worker',
    hasDeadline: wait => 'deadline' in wait && wait.deadline !== undefined,
    requestKinds: ['worker', 'request'],
    delegation: true,
    workerListTarget: request => ({ ...(request.kind === 'worker' ? { workerIds: request.worker_ids } : { requestIds: request.request_ids }), ...(request.mode === undefined ? {} : { mode: request.mode }), timeoutSeconds: request.timeout_seconds }),
    userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'agent-only', keepsSlot: false, cancels: [...ENDS_WAITS, 'the parent settles'], resolves: [
    { trigger: 'the workers report outcomes or the requests get replies, as its mode says', firedBy: 'worker' },
    { trigger: 'the deadline of an agent wait; Cezar\'s completion wait has none', firedBy: 'timer' },
  ] },
  human: { watch: 'none', entry: askWaitEntry,
    aliasEntry: humanAliasEntry,
    recoveredEntry: recoveredAskEntry,
    aliasSource: via => via === 'budget' || via === 'no-wait' || via === 'completion' ? 'cezar' : 'agent',
    duplicate: () => false,
    canonicalize: () => {},
    repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
    requestedTimeout: () => undefined,
    duplicateAsk: (waits, answering) => waits.find((wait): wait is HumanWaitEntry => wait.phase === 'open' && wait.kind === 'human' && wait.source !== 'cezar' && (answering === undefined || wait.askSeq !== answering)),
    answerKind: () => undefined,
    hasDeadline: () => false,
    requestKinds: [],
    delegation: false,
    userAnswers: true, holdsConversationInput: false, runnerResumeCancels: [],
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
  const row = waitRequestRow(request.kind);
  if (row.delegation) return undefined;
  return waits.find((wait): wait is PrWaitEntry | TimerWaitEntry | ProcessWaitEntry =>
    wait.phase === 'open' && row.duplicate(wait, request, turnId, context));
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
  return waitRequestRow(kind).delegation;
}

/** The stored row that serves a tool request kind, including request waits in the worker row. */
export function waitRequestRow(kind: CezarWaitRequest['kind']): WaitKindRow<Wait['kind']> {
  const row = Object.values(WAIT_KINDS).find(row => row.requestKinds.includes(kind));
  if (!row) throw new Error(`no wait row registers ${kind}`);
  return row;
}

type WorkerTarget = Pick<WorkerWaitEntry, 'workerIds' | 'requestIds' | 'outcomes' | 'requestOutcomes' | 'revisions'>;

function peerWaitBuilder(request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-message-wait', turnId: () => string): PeerWaitEntry {
  const now = Date.now();
  return { id: randomUUID(), kind: 'peer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
    deadline: new Date(now + request.timeoutSeconds * 1000).toISOString(), timeoutSeconds: request.timeoutSeconds,
    turnId: turnId(), phase: 'open', peerIds: request.peerIds };
}

function workerWaitBuilder(request: { timeoutSeconds: number; mode?: 'one' | 'all' | 'any' | undefined }, via: 'cezar_wait' | 'cez-worker-wait', now: number, turnId: string, target: WorkerTarget): WorkerWaitEntry & { deadline: string } {
  const entry: WorkerWaitEntry & { deadline: string } = { id: randomUUID(), kind: 'worker', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + request.timeoutSeconds * 1000).toISOString(), timeoutSeconds: request.timeoutSeconds,
      turnId, phase: 'open', ...(request.mode === undefined ? {} : { mode: request.mode }), ...target };
  return entry;
}

function completionWaitEntry(turnId: string, target: WorkerTarget): WorkerWaitEntry {
  const entry: WorkerWaitEntry = { id: randomUUID(), kind: 'worker', source: 'cezar', via: 'completion', registeredAt: new Date().toISOString(),
      turnId, phase: 'open', mode: 'all', ...target };
  return entry;
}

function askWaitEntry(turnId: string): HumanWaitEntry {
  return { id: randomUUID(), kind: 'human', source: 'agent', via: 'cezar_ask', registeredAt: new Date().toISOString(), phase: 'open', turnId };
}

function humanAliasEntry(source: 'agent' | 'cezar', via: WaitVia, turnId: string, card: Pick<HumanWaitEntry, 'questions' | 'context'> | undefined): HumanWaitEntry {
  const wait: HumanWaitEntry = { id: randomUUID(), kind: 'human', source, via,
      registeredAt: new Date().toISOString(), phase: 'open', turnId, ...card };
  return wait;
}

function recoveredAskEntry(askSeq: number): HumanWaitEntry {
  return { id: randomUUID(), kind: 'human', source: 'agent', via: 'ask-line', registeredAt: new Date().toISOString(), phase: 'open', turnId: 'recovered', askSeq };
}

function subagentWaitEntry(turnId: string, deadline: string, children: SubagentChild[]): SubagentWaitEntry {
  const wait: SubagentWaitEntry = { id: randomUUID(), kind: 'subagent', source: 'cezar', via: 'native-subagents', registeredAt: new Date().toISOString(),
      phase: 'open', turnId, deadline, children };
  return wait;
}

function monitoringTimerEntry(via: WaitVia, now: number, delay: number | undefined, minutes: number, turnId: string): TimerWaitEntry {
  // `seconds` is the record's bound; the live-workers deadline is the interval itself (tests run it sub-minute).
  const wait: TimerWaitEntry = { id: randomUUID(), kind: 'timer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + (delay === undefined ? minutes * 60_000 : delay * 1000)).toISOString(), phase: 'open', turnId,
      seconds: delay ?? Math.min(TIMER_MAX_SECONDS, Math.max(TIMER_MIN_SECONDS, Math.round(minutes * 60))),
      ...(via === 'monitoring-line' ? { note: 'Opened while workers run.' } : {}) };
  return wait;
}
