import { describe, expect, it } from 'vitest';
import { buildVoiceQuestions } from './decide.ts';
import { QUESTION_IDS, keyText, textKey, type EngineAnswer, type EngineQuestion, type VoiceEngineState } from './engine.ts';
import { FakeVoiceEngine } from './fake-engine.ts';
import { splitWords } from './sentence.ts';

type Card = NonNullable<VoiceEngineState['card']>;

const CARD: Card = [
  { number: 1, header: 'Library', question: 'Which test library?', options: [{ label: 'Vitest' }, { label: 'Node test' }] },
  { number: 2, header: 'Build', question: 'Which bundler?', options: [{ label: 'Vite' }, { label: 'Webpack' }] },
];
const ONE: Card = [CARD[0]!];
const MULTI_CARD: Card = [
  { number: 1, header: 'Checks', question: 'Which checks?', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Typecheck' }, { label: 'Unit tests' }] },
];

/** The fake answers the real question set for the sentence, as `decideVoice` builds it. */
async function run(
  sentence: string,
  options: { card?: Card; pendingProposal?: 'answer' | 'tell'; openTask?: boolean } = {},
): Promise<Record<string, EngineAnswer>> {
  const words = splitWords(sentence);
  const state: VoiceEngineState = {
    sentence,
    words: words.map((w) => `${w.id} ${w.text}`),
    screen: { page: 'task', sidebarView: 'active', project: 'cezar', ...(options.openTask === false ? {} : { openTask: { title: 'T', status: 'waiting' } }) },
    ...(options.pendingProposal ? { pendingProposal: options.pendingProposal } : {}),
    ...(options.card ? { card: options.card } : {}),
    recent: [],
  };
  const { answers } = await new FakeVoiceEngine().decide({ state, questions: buildVoiceQuestions(state, words) }, new AbortController().signal);
  return answers;
}

function picked(answers: Record<string, EngineAnswer>, id: string): string {
  const answer = answers[id];
  if (answer?.type !== 'choice') throw new Error(`no choice answer for ${id}`);
  return answer.choice;
}
function noulOf(answers: Record<string, EngineAnswer>, id: string): number {
  const answer = answers[id];
  if (answer?.type !== 'noul') throw new Error(`no noul answer for ${id}`);
  return answer.noul;
}
/** Every word's label, in order. */
function wordLabels(answers: Record<string, EngineAnswer>, sentence: string): string[] {
  return splitWords(sentence).map((_, k) => picked(answers, QUESTION_IDS.word(k)));
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
    const answers = await run(sentence, { openTask: false });
    expect(noulOf(answers, QUESTION_IDS.isCommand)).toBeGreaterThanOrEqual(0.9);
    expect(picked(answers, QUESTION_IDS.scope)).toBe('project');
    expect(picked(answers, QUESTION_IDS.projectAction)).toBe('open');
    expect(picked(answers, QUESTION_IDS.position)).toBe(position);
    expect(picked(answers, QUESTION_IDS.status)).toBe(status);
  });

  it('labels two named answers and picks their options', async () => {
    const sentence = 'answer Vitest to question first and the second answer to question second';
    const answers = await run(sentence, { card: CARD });
    expect(picked(answers, QUESTION_IDS.scope)).toBe('session');
    expect(picked(answers, QUESTION_IDS.sessionAction)).toBe('respond');
    expect(wordLabels(answers, sentence)).toEqual(['command', 'q1', 'command', 'command', 'command', 'command', 'q2', 'q2', 'q2', 'command', 'command', 'command']);
    expect(keyText(picked(answers, QUESTION_IDS.option(0)))).toBe('Vitest');
    expect(keyText(picked(answers, QUESTION_IDS.option(1)))).toBe('Webpack');
  });

  it('labels "answer that …" on a one-question card without the command words', async () => {
    const sentence = 'answer that use both';
    const answers = await run(sentence, { card: ONE });
    expect(wordLabels(answers, sentence)).toEqual(['command', 'command', 'q1', 'q1']);
    expect(picked(answers, QUESTION_IDS.option(0))).toBe('other');
  });

  it('labels a message without a card', async () => {
    const sentence = 'tell it: run the tests again';
    const answers = await run(sentence);
    expect(wordLabels(answers, sentence)).toEqual(['command', 'command', 'message', 'message', 'message', 'message']);
    const instruction = 'tell it to run the tests again'
    expect(wordLabels(await run(instruction), instruction)).toEqual(['command', 'command', 'command', 'message', 'message', 'message', 'message'])
    const reply = 'reply with go ahead';
    expect(wordLabels(await run(reply), reply)).toEqual(['command', 'command', 'message', 'message']);
  });

  it('names a choice by label in any case, and by ordinal word', async () => {
    expect(picked(await run('answer node TEST to question two', { card: CARD }), QUESTION_IDS.option(1))).toBe('other');
    expect(keyText(picked(await run('answer node TEST to question one', { card: CARD }), QUESTION_IDS.option(0)))).toBe('Node test');
    expect(keyText(picked(await run('answer option two to question 1', { card: CARD }), QUESTION_IDS.option(0)))).toBe('Node test');
    expect(keyText(picked(await run('answer the 1st choice to question second', { card: CARD }), QUESTION_IDS.option(1)))).toBe('Vite');
  });

  it('picks a card option labeled other by its quoted key, not the free-text sentinel', async () => {
    const card: Card = [{ number: 1, header: 'Mode', question: 'Which mode?', options: [{ label: 'other' }, { label: 'main' }] }];
    expect(picked(await run('answer other to question one', { card }), QUESTION_IDS.option(0))).toBe(textKey('other'));
    expect(picked(await run('answer something else to question one', { card }), QUESTION_IDS.option(0))).toBe('other');
  });

  it('marks every multi-select option the answer names', async () => {
    const answers = await run('answer lint and unit tests to question first', { card: MULTI_CARD });
    expect(noulOf(answers, QUESTION_IDS.optionSelected(0, 0))).toBe(1);
    expect(noulOf(answers, QUESTION_IDS.optionSelected(0, 1))).toBe(0);
    expect(noulOf(answers, QUESTION_IDS.optionSelected(0, 2))).toBe(1);
  });

  it.each(['Yes, confirmed.', 'yes', 'confirm', 'Confirmed', 'send it'])('reads %j as confirm', async (sentence) => {
    const answers = await run(sentence, { pendingProposal: 'answer' });
    expect(picked(answers, QUESTION_IDS.scope)).toBe('session');
    expect(picked(answers, QUESTION_IDS.sessionAction)).toBe('confirm');
  });

  it.each(['no', 'Cancel.', 'stop', 'never mind'])('reads %j as cancel', async (sentence) => {
    expect(picked(await run(sentence, { pendingProposal: 'tell' }), QUESTION_IDS.sessionAction)).toBe('cancel');
  });

  it('reads small talk as not a command', async () => {
    const answers = await run('what a nice day');
    expect(noulOf(answers, QUESTION_IDS.isCommand)).toBeLessThanOrEqual(0.1);
    expect(picked(answers, QUESTION_IDS.scope)).toBe('none');
    expect(picked(answers, QUESTION_IDS.status)).toBe('none');
  });

  it('answers every question it is given, with a choice that was offered', async () => {
    const questions: Record<string, EngineQuestion> = {
      mystery_choice: { type: 'choice', instructions: 'pick', options: { alpha: null, beta: null } },
      mystery_none: { type: 'choice', instructions: 'pick', options: { alpha: null, none: null } },
      mystery_noul: { type: 'noul', instructions: 'yes or no', criteria: { true: 'yes', false: 'no' } },
    };
    const state: VoiceEngineState = { sentence: 'whatever', words: ['W01 whatever'], screen: { page: 'task', sidebarView: 'active', project: 'p' }, recent: [] };
    const { answers } = await new FakeVoiceEngine().decide({ state, questions }, new AbortController().signal);
    expect(Object.keys(answers).sort()).toEqual(Object.keys(questions).sort());
    expect(picked(answers, 'mystery_choice')).toBe('alpha');
    expect(picked(answers, 'mystery_none')).toBe('none');
    expect(noulOf(answers, 'mystery_noul')).toBe(0);
    const choice = answers.mystery_choice;
    expect(choice?.type === 'choice' && choice.confidence).toBe(1);
  });

  it('is the dry-run engine and reports no token use', async () => {
    const engine = new FakeVoiceEngine();
    expect(engine.id).toBe('fake');
    const state: VoiceEngineState = { sentence: 'x', words: ['W01 x'], screen: { page: 'task', sidebarView: 'active', project: 'p' }, recent: [] };
    expect(await engine.decide({ state, questions: {} }, new AbortController().signal)).toEqual({ answers: {} });
  });
});
