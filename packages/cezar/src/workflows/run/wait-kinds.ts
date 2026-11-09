import type { Wait, WaitPhase } from '@open-mercato/cezar-contract';
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
  pr: { userAnswers: false, holdsConversationInput: true, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: true, cancels: ENDS_WAITS, resolves: [
    { trigger: 'checks settle or the head changes; a merge wait: merged, closed or a conflict; merge_or_blocked also resolves when no merge remains pending', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 7,200 s, default 1,800) or a fatal gh error', firedBy: 'watcher' },
  ] },
  timer: { userAnswers: false, holdsConversationInput: false, runnerResumeCancels: ['open'],
    chargesWake: true, refusesSpentBudget: true, holdsSession: false, cancellable: true, timersDisabled: true,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the wake budget is spent at its deadline'], resolves: [
    { trigger: 'the deadline (60 to 7,200 s)', firedBy: 'timer' },
  ] },
  process: { userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: true, refusesSpentBudget: true, holdsSession: false, cancellable: true, timersDisabled: true,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the process is not signalled'], resolves: [
    { trigger: 'the exit file, the process gone, the deadline (up to 7,200 s) or a probe error, polled every 5 s', firedBy: 'watcher' },
  ] },
  subagent: { userAnswers: false, holdsConversationInput: false, runnerResumeCancels: ['open', 'resolved'],
    chargesWake: 'timeout', refusesSpentBudget: false, holdsSession: true, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the runner starts a parent turn itself', 'every child already ended at the turn end', 'the deadline with the wake budget spent'], resolves: [
    { trigger: 'every child ended and no parent turn started within 15 s', firedBy: 'runner' },
    { trigger: 'the deadline, 30 minutes after the last child event', firedBy: 'timer' },
    { trigger: 'a restart or a lost session: the children stopped', firedBy: 'recovery' },
  ] },
  peer: { userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: true, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'required', keepsSlot: false, cancels: [...ENDS_WAITS, 'the wake budget is spent at its resolution'], resolves: [
    { trigger: 'a message of any kind from a named peer', firedBy: 'peer' },
    { trigger: 'a named peer settles or is deleted', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 1,800 s, default 600)', firedBy: 'timer' },
  ] },
  worker: { userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    deadline: 'agent-only', keepsSlot: false, cancels: [...ENDS_WAITS, 'the parent settles'], resolves: [
    { trigger: 'the workers report outcomes or the requests get replies, as its mode says', firedBy: 'worker' },
    { trigger: 'the deadline of an agent wait; Cezar\'s completion wait has none', firedBy: 'timer' },
  ] },
  human: { userAnswers: true, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: 'unshown', timersDisabled: false,
    deadline: 'none', keepsSlot: false, humanOnly: 'The question is the user\'s gate.',
    cancels: ['the agent\'s own wait replaces Cezar\'s', 'a done in the same turn', 'Stop', 'Finish', 'an authored step timeoutMs'],
    resolves: [{ trigger: 'an answer; the parent\'s for a routed worker question', firedBy: 'human' }] },
};

