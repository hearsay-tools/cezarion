import { describe, expect, it } from 'vitest';
import { VOICE_STATUS_IDS } from '@open-mercato/cezar-contract/voice';
import { QUESTION_IDS, keyText, textKey, type EngineAnswer, type EngineQuestion, type VoiceEngineState } from './engine.ts';
import { FakeVoiceEngine } from './fake-engine.ts';

type Card = NonNullable<VoiceEngineState['card']>;

const ACTIONS = ['open', 'answer', 'tell', 'confirm', 'cancel', 'none'];
const POSITIONS = ['next', 'previous', 'last', ...Array.from({ length: 10 }, (_, i) => String(i + 1)), 'none'];
const CARD: Card = [
  { header: 'Library', question: 'Which test library?', options: [{ label: 'Vitest' }, { label: 'Node test' }] },
  { header: 'Build', question: 'Which bundler?', options: [{ label: 'Vite' }, { label: 'Webpack' }] },
];
const MULTI_CARD: Card = [
  {
    header: 'Checks',
    question: 'Which checks?',
    multiSelect: true,
    options: [{ label: 'Lint' }, { label: 'Typecheck' }, { label: 'Unit tests' }],
  },
];

function choice(options: string[]): EngineQuestion {
  return { type: 'choice', instructions: 'pick one', options: Object.fromEntries(options.map((o) => [o, null])) };
}
function noul(): EngineQuestion {
  return { type: 'noul', instructions: 'yes or no', criteria: { true: 'yes', false: 'no' } };
}

/** The questions Task 3 asks, built here by hand: the fake only reads ids, options and state. */
function questionsFor(
  card: Card | undefined,
  spans: Record<number, string[]> = {},
  tellStarts: string[] = ['none'],
): Record<string, EngineQuestion> {
  const questions: Record<string, EngineQuestion> = {
    [QUESTION_IDS.isCommand]: noul(),
    [QUESTION_IDS.action]: choice(ACTIONS),
    [QUESTION_IDS.status]: choice([...VOICE_STATUS_IDS, 'none']),
    [QUESTION_IDS.position]: choice(POSITIONS),
    [QUESTION_IDS.tellStart]: choice(tellStarts.map(textKey)),
  };
  card?.forEach((entry, i) => {
    const labels = (entry.options ?? []).map((o) => o.label);
    questions[QUESTION_IDS.span(i)] = choice([...(spans[i] ?? []).map(textKey), 'none']);
    questions[QUESTION_IDS.choice(i)] = choice([...labels.map(textKey), 'other', 'none']);
    labels.forEach((_, j) => {
      questions[QUESTION_IDS.option(i, j)] = noul();
    });
  });
  return questions;
}

async function run(
  sentence: string,
  options: { card?: Card; pendingProposal?: 'answer' | 'tell'; spans?: Record<number, string[]>; tellStarts?: string[] } = {},
): Promise<Record<string, EngineAnswer>> {
  const state: VoiceEngineState = {
    sentence,
    view: { sidebarView: 'active', openTask: true },
    ...(options.pendingProposal ? { pendingProposal: options.pendingProposal } : {}),
    ...(options.card ? { card: options.card } : {}),
    recent: [],
  };
  const { answers } = await new FakeVoiceEngine().decide(
    { state, questions: questionsFor(options.card, options.spans, options.tellStarts) },
    new AbortController().signal,
  );
  return answers;
}

function picked(answers: Record<string, EngineAnswer>, id: string): string {
  const answer = answers[id];
  if (answer?.type !== 'choice') throw new Error(`no choice answer for ${id}`);
  return answer.choice;
}
/** The text behind a picked text key. */
function pickedText(answers: Record<string, EngineAnswer>, id: string): string | undefined {
  return keyText(picked(answers, id));
}
function noulOf(answers: Record<string, EngineAnswer>, id: string): number {
  const answer = answers[id];
  if (answer?.type !== 'noul') throw new Error(`no noul answer for ${id}`);
  return answer.noul;
}

describe('FakeVoiceEngine', () => {
  const open: [string, string, string][] = [
    ['Open next finished.', 'next', 'finished'],
    ['um, open the third failed', '3', 'failed'],
    ['open first needs you', '1', 'needs-you'],
    ['so open the last waiting for CI', 'last', 'waiting-for-ci'],
    ['okay open previous working', 'previous', 'working'],
    ['open 2 unread', '2', 'unread'],
  ];
  it.each(open)('reads %j as open %s %s', async (sentence, position, status) => {
    const answers = await run(sentence);
    expect(noulOf(answers, QUESTION_IDS.isCommand)).toBeGreaterThanOrEqual(0.9);
    expect(picked(answers, QUESTION_IDS.action)).toBe('open');
    expect(picked(answers, QUESTION_IDS.position)).toBe(position);
    expect(picked(answers, QUESTION_IDS.status)).toBe(status);
  });

  it('answers two questions of a card, each with the span that names it', async () => {
    const spans = { 0: ['Vitest', 'the second answer', 'Vitest and the second answer'], 1: ['Vitest', 'the second answer', 'Vitest and the second answer'] };
    const answers = await run('answer Vitest to question first and the second answer to question second', {
      card: CARD,
      spans,
    });
    expect(picked(answers, QUESTION_IDS.action)).toBe('answer');
    expect(pickedText(answers, QUESTION_IDS.choice(0))).toBe('Vitest');
    expect(pickedText(answers, QUESTION_IDS.choice(1))).toBe('Webpack');
    expect(pickedText(answers, QUESTION_IDS.span(0))).toBe('Vitest');
    expect(pickedText(answers, QUESTION_IDS.span(1))).toBe('the second answer');
  });

  it('puts words that match no choice into other, and leaves the other question unaddressed', async () => {
    const answers = await run('answer use both to question first', {
      card: CARD,
      spans: { 0: ['use both', 'use'], 1: ['use both'] },
    });
    expect(picked(answers, QUESTION_IDS.choice(0))).toBe('other');
    expect(pickedText(answers, QUESTION_IDS.span(0))).toBe('use both');
    expect(picked(answers, QUESTION_IDS.span(1))).toBe('none');
    expect(picked(answers, QUESTION_IDS.choice(1))).toBe('none');
  });

  it('names a choice by label in any case, and by ordinal word', async () => {
    const byLabel = await run('answer node TEST to question two', { card: CARD });
    expect(picked(byLabel, QUESTION_IDS.choice(1))).toBe('other'); // question two offers Vite and Webpack
    const second = await run('answer node TEST to question one', { card: CARD });
    expect(pickedText(second, QUESTION_IDS.choice(0))).toBe('Node test');
    const ordinal = await run('answer option two to question 1', { card: CARD });
    expect(pickedText(ordinal, QUESTION_IDS.choice(0))).toBe('Node test');
    const nth = await run('answer the 1st choice to question second', { card: CARD });
    expect(pickedText(nth, QUESTION_IDS.choice(1))).toBe('Vite');
  });

  it('reads a question named before its answer', async () => {
    const answers = await run('answer Vite for the second question', { card: CARD, spans: { 1: ['Vite'] } });
    expect(pickedText(answers, QUESTION_IDS.choice(1))).toBe('Vite');
    expect(pickedText(answers, QUESTION_IDS.span(1))).toBe('Vite');
    expect(picked(answers, QUESTION_IDS.span(0))).toBe('none');
  });

  it('picks a card option labeled other by its quoted key, not the free-text sentinel', async () => {
    const card: Card = [{ header: 'Mode', question: 'Which mode?', options: [{ label: 'other' }, { label: 'main' }] }];
    const named = await run('answer other to question one', { card });
    expect(picked(named, QUESTION_IDS.choice(0))).toBe(textKey('other'));
    const free = await run('answer something else to question one', { card });
    expect(picked(free, QUESTION_IDS.choice(0))).toBe('other');
  });

  it('marks every multi-select option the segment names', async () => {
    const answers = await run('answer lint and unit tests to question first', { card: MULTI_CARD });
    expect(noulOf(answers, QUESTION_IDS.option(0, 0))).toBe(1);
    expect(noulOf(answers, QUESTION_IDS.option(0, 1))).toBe(0);
    expect(noulOf(answers, QUESTION_IDS.option(0, 2))).toBe(1);
  });

  it('finds where the dictated text starts', async () => {
    const answers = await run('tell it: run the tests again', { tellStarts: ['run the tests again', 'the tests again', 'none'] });
    expect(picked(answers, QUESTION_IDS.action)).toBe('tell');
    expect(pickedText(answers, QUESTION_IDS.tellStart)).toBe('run the tests again');
    const spoken = await run('tell the agent to stop. ', { tellStarts: ['stop', 'to stop'] });
    expect(pickedText(spoken, QUESTION_IDS.tellStart)).toBe('to stop');
    const unmatched = await run('tell it: something else', { tellStarts: ['first', 'second'] });
    expect(pickedText(unmatched, QUESTION_IDS.tellStart)).toBe('first');
  });

  it.each(['Yes, confirmed.', 'yes', 'confirm', 'Confirmed', 'send it'])('reads %j as confirm', async (sentence) => {
    const answers = await run(sentence, { pendingProposal: 'answer' });
    expect(picked(answers, QUESTION_IDS.action)).toBe('confirm');
  });

  it.each(['no', 'Cancel.', 'stop', 'never mind'])('reads %j as cancel', async (sentence) => {
    const answers = await run(sentence, { pendingProposal: 'tell' });
    expect(picked(answers, QUESTION_IDS.action)).toBe('cancel');
  });

  it('does not depend on a pending proposal for confirm and cancel', async () => {
    expect(picked(await run('yes confirmed'), QUESTION_IDS.action)).toBe('confirm');
    expect(picked(await run('cancel'), QUESTION_IDS.action)).toBe('cancel');
  });

  it('reads small talk as not a command', async () => {
    const answers = await run('what a nice day');
    expect(noulOf(answers, QUESTION_IDS.isCommand)).toBeLessThanOrEqual(0.1);
    expect(picked(answers, QUESTION_IDS.action)).toBe('none');
    expect(picked(answers, QUESTION_IDS.status)).toBe('none');
  });

  it('answers every question it is given, with a choice that was offered', async () => {
    const questions: Record<string, EngineQuestion> = {
      ...questionsFor(CARD),
      mystery_choice: choice(['alpha', 'beta']),
      mystery_none: choice(['alpha', 'none']),
      mystery_noul: noul(),
    };
    const { answers } = await new FakeVoiceEngine().decide(
      { state: { sentence: 'whatever', view: { sidebarView: 'active', openTask: false }, recent: [] }, questions },
      new AbortController().signal,
    );
    expect(Object.keys(answers).sort()).toEqual(Object.keys(questions).sort());
    for (const [id, question] of Object.entries(questions)) {
      const answer = answers[id]!;
      expect(answer.type).toBe(question.type);
      if (answer.type === 'choice' && question.type === 'choice') {
        expect(Object.keys(question.options)).toContain(answer.choice);
        expect(answer.confidence).toBe(1);
        expect(answer.probabilities[answer.choice]).toBe(1);
        expect(Object.values(answer.probabilities).reduce((a, b) => a + b, 0)).toBe(1);
      }
    }
    expect(picked(answers, 'mystery_choice')).toBe('alpha');
    expect(picked(answers, 'mystery_none')).toBe('none');
    expect(noulOf(answers, 'mystery_noul')).toBe(0);
  });

  it('is the dry-run engine and reports no token use', async () => {
    const engine = new FakeVoiceEngine();
    expect(engine.id).toBe('fake');
    const result = await engine.decide(
      { state: { sentence: 'x', view: { sidebarView: 'active', openTask: false }, recent: [] }, questions: {} },
      new AbortController().signal,
    );
    expect(result).toEqual({ answers: {} });
  });
});
