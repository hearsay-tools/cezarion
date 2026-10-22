import type { AskQuestion } from '@open-mercato/cezar-contract/ask';
import type { VoiceAnswer, VoiceDecideRequest, VoiceDecision, VoicePosition, VoiceStatus } from '@open-mercato/cezar-contract/voice';
import { decideVoice } from './decide.ts';
import { QUESTION_IDS, textKey, type DecisionEngine, type EngineAnswer } from './engine.ts';
import { splitWords } from './sentence.ts';

/**
 * The voice replay set (hearsay-tools/cezarion#1463): sentences with the screen they were said on and
 * the decision they must give. `replay-set.test.ts` runs every case against scripted engine answers,
 * which reuse the word labels Jev gave in the spike. `scripts/voice-replay.ts` runs the same cases
 * against the live engine, to check the criteria wording and to set `EXTRACT_MIN`.
 */

/** One scripted engine answer: a choice with its confidence, or a yes/no value. */
export interface ScriptedAnswer {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  noul?: number;
}

type NoneReason = Extract<VoiceDecision, { action: 'none' }>['reason'];

/** The decision a case must give. Only the fields named here are compared. */
export type ExpectedDecision =
  | { action: 'answer'; answers: VoiceAnswer[] }
  | { action: 'tell'; text: string }
  | { action: 'open'; status: VoiceStatus; position: VoicePosition }
  | { action: 'none'; reason: NoneReason };

export interface ReplayCase {
  name: string;
  sentence: string;
  /** The question the server has for the open task. */
  ask?: { requestId: string; questions: AskQuestion[] };
  openTask: boolean;
  /** What the browser says it shows; omitted means the question the server has. */
  askRequestId?: string | null;
  proposal?: 'answer' | 'tell';
  scripted: Record<string, ScriptedAnswer>;
  expect: ExpectedDecision;
}

export const REPLAY_RUN_ID = '11111111-2222-4333-8444-555555555555';
export const REPLAY_DECISION_ID = '99999999-2222-4333-8444-555555555555';

const RUNNER = {
  requestId: 'ask-runner',
  questions: [{ header: 'Runner', question: 'Which test runner?', options: [{ label: 'Vitest' }, { label: 'Jest' }] }],
};
const TWO = {
  requestId: 'ask-two',
  questions: [
    { header: 'Library', question: 'Which test library?', options: [{ label: 'Vitest' }, { label: 'Node test' }] },
    { header: 'Build', question: 'Which build tool?', options: [{ label: 'Vite' }, { label: 'Webpack' }] },
  ],
};
const FILE = { requestId: 'ask-file', questions: [{ header: 'File', question: 'Which file should I delete?' }] };
const CHECKS = {
  requestId: 'ask-checks',
  questions: [
    { header: 'Checks', question: 'Which checks?', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Typecheck' }, { label: 'Unit tests' }] },
  ],
};

const NEXT = {
  requestId: 'ask-next',
  questions: [{ header: 'Next action', question: 'What should I do next?', options: [{ label: 'Keep going' }, { label: 'Park it' }, { label: 'Stop here' }] }],
};

const respond: Record<string, ScriptedAnswer> = {
  is_command: { noul: 0.95 },
  scope: { choice: 'session', confidence: 0.9 },
  session_action: { choice: 'respond', confidence: 0.85 },
};

/** One label per word, `c` for command; a number after `:` is that word's confidence. */
function words(list: string): Record<string, ScriptedAnswer> {
  return Object.fromEntries(
    list.split(' ').map((entry, k) => {
      const [label = 'c', confidence] = entry.split(':');
      return [QUESTION_IDS.word(k), { choice: label === 'c' ? 'routing' : label, confidence: confidence ? Number(confidence) : 0.9 }];
    }),
  );
}

const option = (question: number, ...labels: string[]): VoiceAnswer => ({ question, kind: 'option', labels });
const other = (question: number, text: string): VoiceAnswer => ({ question, kind: 'other', text });
const picks = (question: number, label: string, confidence = 0.95) => ({
  [QUESTION_IDS.option(question)]: { choice: textKey(label), confidence },
});

export const REPLAY_CASES: ReplayCase[] = [
  {
    name: 'answer that, on a one-question card',
    sentence: 'answer that Vitest',
    ask: RUNNER,
    openTask: true,
    scripted: { ...respond, ...words('c c q1'), ...picks(0, 'Vitest') },
    expect: { action: 'answer', answers: [option(0, 'Vitest')] },
  },
  {
    name: 'tell it that, on a one-question card',
    sentence: 'tell it that we use Jest',
    ask: RUNNER,
    openTask: true,
    scripted: { ...respond, ...words('c c c q1 q1 q1'), ...picks(0, 'Jest') },
    expect: { action: 'answer', answers: [option(0, 'Jest')] },
  },
  {
    name: 'an option named by meaning',
    sentence: 'answer the one built on Vite',
    ask: RUNNER,
    openTask: true,
    scripted: { ...respond, ...words('c q1 q1 q1 q1 q1'), ...picks(0, 'Vitest', 0.8) },
    expect: { action: 'answer', answers: [option(0, 'Vitest')] },
  },
  {
    name: 'free text for a question with no options',
    sentence: 'answer that the old config in the root folder',
    ask: FILE,
    openTask: true,
    scripted: { ...respond, ...words('c c q1 q1 q1 q1 q1 q1 q1') },
    expect: { action: 'answer', answers: [other(0, 'the old config in the root folder')] },
  },
  {
    name: '"that" as content after "tell it that"',
    sentence: 'tell it that that file is fine',
    ask: FILE,
    openTask: true,
    scripted: { ...respond, ...words('c c c:0.52 q1:0.36 q1:0.3 q1:0.5 q1:0.48') },
    expect: { action: 'answer', answers: [other(0, 'that file is fine')] },
  },
  {
    name: 'two answers, each question named by number',
    sentence: 'answer Vitest to question first and Webpack to question second',
    ask: TWO,
    openTask: true,
    scripted: { ...respond, ...words('c q1 c c c c q2 c c c'), ...picks(0, 'Vitest'), ...picks(1, 'Webpack') },
    expect: { action: 'answer', answers: [option(0, 'Vitest'), option(1, 'Webpack')] },
  },
  {
    name: 'two answers, no question named',
    sentence: 'answer Vitest and Webpack',
    ask: TWO,
    openTask: true,
    scripted: { ...respond, ...words('c q1 c q2'), ...picks(0, 'Vitest'), ...picks(1, 'Webpack') },
    expect: { action: 'answer', answers: [option(0, 'Vitest'), option(1, 'Webpack')] },
  },
  {
    name: 'two answers, each question named by its header',
    sentence: 'for Library use Vitest, and for Build pick Webpack',
    ask: TWO,
    openTask: true,
    scripted: { ...respond, ...words('c c q1 q1 c c c c q2'), ...picks(0, 'Vitest'), ...picks(1, 'Webpack') },
    expect: { action: 'answer', answers: [option(0, 'Vitest'), option(1, 'Webpack')] },
  },
  {
    name: 'several options of a multi-select question',
    sentence: 'answer lint and unit tests',
    ask: CHECKS,
    openTask: true,
    scripted: {
      ...respond,
      ...words('c q1 q1 q1 q1'),
      [QUESTION_IDS.optionSelected(0, 0)]: { noul: 0.95 },
      [QUESTION_IDS.optionSelected(0, 1)]: { noul: 0.05 },
      [QUESTION_IDS.optionSelected(0, 2)]: { noul: 0.9 },
    },
    expect: { action: 'answer', answers: [option(0, 'Lint', 'Unit tests')] },
  },
  {
    name: 'a message to an open task with no card',
    sentence: 'tell it to run the tests again',
    openTask: true,
    scripted: { ...respond, ...words('c c c:0.48 message message message message') },
    expect: { action: 'tell', text: 'run the tests again' },
  },
  {
    name: 'a request for the agent while a card is shown',
    sentence: 'tell the agent to ask me one more question',
    ask: NEXT,
    openTask: true,
    scripted: { ...respond, ...words('c c c c message message message message message') },
    expect: { action: 'tell', text: 'ask me one more question' },
  },
  {
    name: '"skip the question" while a card is shown',
    sentence: 'Tell it skip the question',
    ask: NEXT,
    openTask: true,
    scripted: { ...respond, ...words('c c message message message') },
    expect: { action: 'tell', text: 'skip the question' },
  },
  {
    name: '"tell it to" answering a card by meaning',
    sentence: 'Tell it to park it',
    ask: NEXT,
    openTask: true,
    scripted: { ...respond, ...words('c c c q1 q1'), ...picks(0, 'Park it') },
    expect: { action: 'answer', answers: [option(0, 'Park it')] },
  },
  {
    name: '"tell it to" with no card',
    sentence: 'Tell it to park it',
    openTask: true,
    scripted: { ...respond, ...words('c c c message message') },
    expect: { action: 'tell', text: 'park it' },
  },
  {
    name: '"go to" opens a task',
    sentence: 'go to the first cancelled task',
    openTask: false,
    scripted: {
      is_command: { noul: 0.9 },
      scope: { choice: 'project', confidence: 1 },
      project_action: { choice: 'open', confidence: 0.9 },
      status: { choice: 'cancelled', confidence: 1 },
      position: { choice: '1', confidence: 0.9 },
    },
    expect: { action: 'open', status: 'cancelled', position: 1 },
  },
  {
    name: 'a status said before "task"',
    sentence: 'bring up the previous working task',
    openTask: false,
    scripted: {
      is_command: { noul: 0.9 },
      scope: { choice: 'project', confidence: 0.85 },
      project_action: { choice: 'open', confidence: 0.75 },
      status: { choice: 'working', confidence: 0.8 },
      position: { choice: 'previous', confidence: 0.85 },
    },
    expect: { action: 'open', status: 'working', position: 'previous' },
  },
  {
    name: 'opening another task while a card is shown',
    sentence: 'open the next needs you item',
    ask: NEXT,
    openTask: true,
    scripted: {
      is_command: { noul: 0.9 },
      scope: { choice: 'project', confidence: 0.95 },
      project_action: { choice: 'open', confidence: 0.9 },
      status: { choice: 'needs-you', confidence: 0.9 },
      position: { choice: 'next', confidence: 0.8 },
    },
    expect: { action: 'open', status: 'needs-you', position: 'next' },
  },
  {
    name: 'only command words',
    sentence: 'answer that',
    ask: RUNNER,
    openTask: true,
    scripted: { ...respond, ...words('c c') },
    expect: { action: 'none', reason: 'unclear' },
  },
  {
    name: 'a global command',
    sentence: 'open the settings please',
    openTask: false,
    scripted: { is_command: { noul: 0.95 }, scope: { choice: 'global', confidence: 0.9 } },
    expect: { action: 'none', reason: 'unsupported' },
  },
  {
    name: 'a reply with no open task',
    sentence: 'tell it to stop now',
    openTask: false,
    scripted: { is_command: { noul: 0.95 }, scope: { choice: 'session', confidence: 0.9 } },
    expect: { action: 'none', reason: 'no-open-task' },
  },
  {
    name: 'a card that changed after the sentence',
    sentence: 'answer that Vitest',
    ask: RUNNER,
    openTask: true,
    askRequestId: 'ask-older',
    scripted: { ...respond, ...words('c c q1'), ...picks(0, 'Vitest') },
    expect: { action: 'none', reason: 'stale-context' },
  },
  {
    name: 'a card the browser has not shown yet',
    sentence: 'answer that Vitest',
    ask: RUNNER,
    openTask: true,
    askRequestId: null,
    scripted: { ...respond, ...words('c c q1'), ...picks(0, 'Vitest') },
    expect: { action: 'none', reason: 'stale-context' },
  },
];

/** An engine that answers from `scripted`: `none` (or the first option) and 0 for anything else. */
export function scriptedEngine(scripted: Record<string, ScriptedAnswer>): DecisionEngine {
  return {
    id: 'fake',
    async decide({ questions }) {
      const answers: Record<string, EngineAnswer> = {};
      for (const [id, question] of Object.entries(questions)) {
        const given = scripted[id] ?? {};
        if (question.type === 'noul') {
          answers[id] = { type: 'noul', noul: given.noul ?? 0 };
          continue;
        }
        const keys = Object.keys(question.options);
        const choice = given.choice ?? (keys.includes('none') ? 'none' : keys[0]!);
        const confidence = given.confidence ?? 1;
        answers[id] = { type: 'choice', choice, confidence, probabilities: given.probabilities ?? { [choice]: confidence } };
      }
      return { answers };
    },
  };
}

/** The request the browser sends for a case. */
export function replayRequest(replay: ReplayCase): VoiceDecideRequest {
  const shown = replay.askRequestId !== undefined ? replay.askRequestId : (replay.ask?.requestId ?? null);
  return {
    text: replay.sentence,
    sidebarView: 'active',
    view: replay.openTask ? 'task' : 'other',
    ...(replay.openTask ? { openRunId: REPLAY_RUN_ID, askRequestId: shown } : {}),
    ...(replay.proposal ? { proposal: { decisionId: REPLAY_DECISION_ID, action: replay.proposal } } : {}),
  };
}

export function replayDecision(replay: ReplayCase, engine: DecisionEngine, signal: AbortSignal = new AbortController().signal) {
  return decideVoice({
    request: replayRequest(replay),
    ...(replay.openTask && replay.ask ? { ask: replay.ask } : {}),
    screen: { project: 'cezar', ...(replay.openTask ? { openTask: { title: 'Set up tests', status: 'waiting' } } : {}) },
    recent: [],
    engine,
    decisionId: REPLAY_DECISION_ID,
    signal,
  });
}

/** Why `decision` is not the expected one, or undefined when it is. */
export function mismatch(expected: ExpectedDecision, decision: VoiceDecision): string | undefined {
  if (decision.action !== expected.action) return `expected ${expected.action}, got ${decision.action}`;
  if (expected.action === 'answer' && decision.action === 'answer') {
    const want = JSON.stringify(expected.answers);
    const got = JSON.stringify(decision.answers);
    return want === got ? undefined : `expected answers ${want}, got ${got}`;
  }
  if (expected.action === 'tell' && decision.action === 'tell') {
    return expected.text === decision.text ? undefined : `expected text "${expected.text}", got "${decision.text}"`;
  }
  if (expected.action === 'open' && decision.action === 'open') {
    const want = `${expected.status} ${expected.position}`;
    const got = `${decision.status} ${decision.position}`;
    return want === got ? undefined : `expected open ${want}, got open ${got}`;
  }
  if (expected.action === 'none' && decision.action === 'none') {
    return expected.reason === decision.reason ? undefined : `expected reason ${expected.reason}, got ${decision.reason}`;
  }
  return undefined;
}

/** Each target's word confidences, by label (`q1`, `message`, …), for the live replay report. */
export function targetConfidences(sentence: string, answers: Record<string, EngineAnswer>): Record<string, { min: number; mean: number }> {
  const byLabel: Record<string, number[]> = {};
  splitWords(sentence).forEach((_, k) => {
    const answer = answers[QUESTION_IDS.word(k)];
    if (answer?.type !== 'choice' || answer.choice === 'routing') return;
    (byLabel[answer.choice] ??= []).push(answer.confidence);
  });
  return Object.fromEntries(
    Object.entries(byLabel).map(([label, list]) => [
      label,
      { min: Math.min(...list), mean: list.reduce((sum, value) => sum + value, 0) / list.length },
    ]),
  );
}
