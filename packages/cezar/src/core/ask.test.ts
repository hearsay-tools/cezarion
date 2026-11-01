import { describe, expect, it } from 'vitest';

import { parseAskRequest, uiAskQuestions, type AskRequest } from './ask.ts';

const valid: AskRequest = {
  questions: [
    {
      header: 'Library',
      question: 'Which date library should I standardize on?',
      options: [
        { label: 'date-fns', description: 'Tree-shakeable' },
        { label: 'Luxon', description: 'Immutable, tz-aware' },
      ],
    },
  ],
};

describe('uiAskQuestions', () => {
  it('omits undefined fields at both question and option boundaries without changing JSON', () => {
    const questions: AskRequest['questions'] = [{
      header: 'Choice', question: 'Choose?', id: undefined, multiSelect: false,
      options: [{ label: 'Keep', description: undefined }],
    }, { header: 'Text', question: 'Explain?', options: undefined }];
    const result = uiAskQuestions(questions);
    expect(JSON.stringify(result)).toBe(JSON.stringify(questions));
    expect(Object.hasOwn(result[0]!, 'id')).toBe(false);
    expect(Object.hasOwn(result[0]!.options![0]!, 'description')).toBe(false);
    expect(Object.hasOwn(result[1]!, 'options')).toBe(false);
    expect(Object.hasOwn(questions[0]!, 'id')).toBe(true);
  });
});

describe('parseAskRequest', () => {
  it('accepts a well-formed single-question request', () => {
    expect(parseAskRequest(valid)).toEqual(valid);
  });

  it('accepts up to 4 questions with multiSelect and optional descriptions', () => {
    const req = {
      questions: [
        {
          id: 'q1',
          header: 'Sections',
          question: 'Which sections?',
          multiSelect: true,
          options: [{ label: 'Profile' }, { label: 'Billing' }],
        },
        {
          header: 'Theme',
          question: 'Which theme?',
          options: [{ label: 'Light' }, { label: 'Dark' }, { label: 'System' }],
        },
      ],
    };
    expect(parseAskRequest(req)).toEqual(req);
  });

  it('rejects an empty questions array', () => {
    expect(parseAskRequest({ questions: [] })).toBeNull();
  });

  it('rejects more than 4 questions', () => {
    const q = valid.questions[0];
    expect(parseAskRequest({ questions: [q, q, q, q, q] })).toBeNull();
  });

  it('rejects a question with fewer than 2 options', () => {
    expect(
      parseAskRequest({
        questions: [{ header: 'H', question: 'Q?', options: [{ label: 'only' }] }],
      }),
    ).toBeNull();
    expect(parseAskRequest({ questions: [{ header: 'H', question: 'Q?', options: [] }] })).toBeNull();
  });

  // hearsay-tools/cezarion#1234: options omitted, the user types the answer.
  it('accepts an open question, alone or beside one with options', () => {
    const open = { header: 'Name', question: 'What should the command be called?' };
    expect(parseAskRequest({ questions: [open] })).toEqual({ questions: [open] });
    expect(parseAskRequest({ questions: [open, valid.questions[0]] })).toEqual({ questions: [open, valid.questions[0]] });
  });

  it('rejects a question with more than 4 options', () => {
    expect(
      parseAskRequest({
        questions: [
          {
            header: 'H',
            question: 'Q?',
            options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }],
          },
        ],
      }),
    ).toBeNull();
  });

  it('rejects a header longer than 12 chars', () => {
    expect(
      parseAskRequest({
        questions: [
          { header: 'thirteen char', question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] },
        ],
      }),
    ).toBeNull();
  });

  it('rejects non-unique option labels within a question', () => {
    expect(
      parseAskRequest({
        questions: [
          { header: 'H', question: 'Q?', options: [{ label: 'same' }, { label: 'same' }] },
        ],
      }),
    ).toBeNull();
  });

  it('rejects non-unique question texts', () => {
    const q = valid.questions[0];
    expect(parseAskRequest({ questions: [q, { ...q }] })).toBeNull();
  });

  it('rejects unknown top-level and per-option keys (strict)', () => {
    expect(parseAskRequest({ questions: valid.questions, extra: 1 })).toBeNull();
    expect(
      parseAskRequest({
        questions: [
          {
            header: 'H',
            question: 'Q?',
            options: [
              { label: 'a', color: 'red' },
              { label: 'b' },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseAskRequest(null)).toBeNull();
    expect(parseAskRequest('CEZ:ASK')).toBeNull();
    expect(parseAskRequest(42)).toBeNull();
  });
});
