import { describe, expect, it } from 'vitest';
import { copyRange, namesQuestion, questionReferenceWords, splitWords } from './sentence.ts';

describe('splitWords', () => {
  it('numbers each word and keeps its place in the sentence', () => {
    const sentence = 'answer that, uh, jest.';
    const words = splitWords(sentence);
    expect(words.map((w) => w.id)).toEqual(['W01', 'W02', 'W03', 'W04']);
    expect(words.map((w) => w.text)).toEqual(['answer', 'that,', 'uh,', 'jest.']);
    for (const word of words) expect(sentence.slice(word.start, word.end)).toBe(word.text);
  });

  it('numbers past 99 with three digits', () => {
    const words = splitWords(Array.from({ length: 100 }, () => 'a').join(' '));
    expect(words[98]?.id).toBe('W99');
    expect(words[99]?.id).toBe('W100');
  });

  it('has no words for blank text', () => {
    expect(splitWords('   ')).toEqual([]);
  });
});

describe('questionReferenceWords', () => {
  it('finds numbered question references', () => {
    const sentence = 'answer vitest to question one and yes to question two';
    expect([...questionReferenceWords(sentence, splitWords(sentence), [])].sort((a, b) => a - b)).toEqual([2, 3, 4, 7, 8, 9]);
  });

  it('finds header references and leaves the answer words alone', () => {
    const sentence = 'for coverage say no, and for the runner pick jest';
    const found = questionReferenceWords(sentence, splitWords(sentence), ['Coverage', 'Runner']);
    expect([...found].sort((a, b) => a - b)).toEqual([0, 1, 5, 6, 7]);
  });

  it('finds nothing when no question is named', () => {
    const sentence = 'use vitest and skip coverage';
    expect(questionReferenceWords(sentence, splitWords(sentence), ['Runner']).size).toBe(0);
  });
});

describe('namesQuestion', () => {
  it('is true for numbered and header references', () => {
    expect(namesQuestion('answer vitest to question one', [])).toBe(true);
    expect(namesQuestion('for coverage say no', ['Coverage'])).toBe(true);
  });

  it('is false when no question is named', () => {
    expect(namesQuestion('use vitest and skip coverage', ['Runner'])).toBe(false);
  });
});

describe('copyRange', () => {
  it('copies the words as said and drops only a trailing mark', () => {
    const a = 'use jest, please.';
    expect(copyRange(a, splitWords(a), 0, 1)).toBe('use jest');
    const b = 'say no, then go.';
    expect(copyRange(b, splitWords(b), 1, 3)).toBe('no, then go');
    const c = 'answer that We Use   Vitest!';
    expect(copyRange(c, splitWords(c), 2, 4)).toBe('We Use   Vitest');
  });
});
