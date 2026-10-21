import { describe, expect, it } from 'vitest';
import { candidateSpans, tellStarts } from './sentence.ts';

describe('candidateSpans', () => {
  it('splits at question references', () => {
    const spans = candidateSpans('answer Right, go on to question first and Needs changes to question second: drop the wake word');
    expect(spans).toContain('Right, go on');
    expect(spans).toContain('Needs changes');
    expect(spans).toContain('drop the wake word');
    expect(spans).toContain('Needs changes: drop the wake word');
  });

  it('cleans punctuation and fillers', () => {
    expect(candidateSpans('Um, answer Vitest to question one.')).toContain('Vitest');
  });

  it('reads the sentence the dry-run browser test says', () => {
    const spans = candidateSpans('answer Vitest to question first and the second answer to question second');
    expect(spans).toContain('Vitest');
    expect(spans).toContain('the second answer');
  });

  it('reads a question named before its answer', () => {
    expect(candidateSpans('answer Vite for the second question')).toContain('Vite');
  });

  it('never cleans a segment down to nothing', () => {
    expect(candidateSpans('answer okay to question one')).toEqual(['answer okay', 'okay']);
    expect(candidateSpans('answer so to question one')).toEqual(['answer so', 'so']);
    expect(candidateSpans('answer none to question one')).toEqual(['answer none', 'none']);
    expect(candidateSpans('um, answer ok to question one')).toEqual(['um, answer ok', 'ok']);
    expect(candidateSpans('okay answer Vitest to question one')).toContain('Vitest');
  });

  it('keeps an answer that is a connector word', () => {
    expect(candidateSpans('answer and to question one')).toContain('and');
    expect(candidateSpans('answer then to question one')).toContain('then');
  });

  it('offers every span as said first, then cleaned', () => {
    expect(candidateSpans('answer for now keep both')).toEqual(['answer for now keep both', 'now keep both']);
    expect(candidateSpans('Vitest to question one, and then Jev to question two.')).toEqual(
      ['Vitest', 'and then Jev', 'Jev', 'Vitest: and then Jev', 'Vitest: Jev'],
    );
  });

  it('splits at card headers as well as numbers', () => {
    const spans = candidateSpans('answer Vitest to Library and Fake to Engine', ['Library', 'Engine']);
    expect(spans).toContain('Vitest');
    expect(spans).toContain('Fake');
    expect(candidateSpans('answer Vitest for the library question', ['Library'])).toContain('Vitest');
    expect(candidateSpans('answer Vitest library question', ['Library'])).toContain('Vitest');
  });

  it('matches headers case-insensitively, word-bounded and escaped', () => {
    expect(candidateSpans('answer yes to ENGINE', ['engine'])).toContain('yes');
    expect(candidateSpans('answer yes to engineering', ['engine'])).toEqual(['answer yes to engineering', 'yes to engineering']);
    expect(candidateSpans('answer yes to C++ (new)', ['C++ (new)'])).toContain('yes');
  });

  it('keeps the whole sentence as one span when no question is named', () => {
    expect(candidateSpans('answer use both')).toEqual(['answer use both', 'use both']);
  });

  it('returns nothing for an empty sentence', () => {
    expect(candidateSpans('  .  ')).toEqual([]);
  });

  it('de-duplicates and caps the candidates at 20', () => {
    expect(candidateSpans('answer a to question one and a to question two')).toContain('a');
    expect(candidateSpans('answer a to question one and a to question two').filter((s) => s === 'a')).toHaveLength(1);
    const long = Array.from({ length: 30 }, (_, i) => `word${i} to question one`).join(' and ');
    expect(candidateSpans(long).length).toBeLessThanOrEqual(20);
  });
});

describe('tellStarts', () => {
  it('finds tell-it starts', () => {
    expect(tellStarts('tell it: run the tests again')).toContain('run the tests again');
    expect(tellStarts('tell the agent to run the tests again')).toContain('run the tests again');
  });

  it.each([
    ['reply with thanks, that works', 'thanks, that works'],
    ['please say hello there.', 'hello there'],
    ['message it stop now', 'stop now'],
  ])('finds the start after a trigger in %j', (sentence, start) => {
    expect(tellStarts(sentence)).toContain(start);
  });

  it.each([
    ['tell it: answer the question', 'answer the question'],
    ['tell it: for now keep both', 'for now keep both'],
    ['tell it: and then stop.', 'and then stop'],
    ['tell it: Then run it', 'Then run it'],
  ])('keeps the dictated words of %j as said', (sentence, start) => {
    expect(tellStarts(sentence)[0]).toBe(start);
  });

  it('also offers the start without a stray connector', () => {
    expect(tellStarts('tell it: and run the tests again')).toEqual(['and run the tests again', 'run the tests again']);
  });

  it('returns nothing without a colon or trigger', () => {
    expect(tellStarts('open next finished')).toEqual([]);
  });

  it('caps the candidates at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => `say w${i}`).join(' ');
    expect(tellStarts(many).length).toBeLessThanOrEqual(20);
  });
});
