import { describe, expect, it } from 'vitest';
import type { ApiRun } from '@open-mercato/cezar-contract';
import { attentionFields, projectStatus } from './projections.ts';

describe('attentionFields', () => {
  it('usage-limit label carries the resume time', () => {
    // A usage-limit hold is a waiting run with a resume booked (hearsay-tools/cezarion#1236): a
    // CLI reader gets when it resumes, not only that it is held.
    const autoResumeAt = '2026-10-21T14:05:00.000Z';
    expect(attentionFields({ status: 'waiting', autoResumeAt })).toEqual({
      attention: 'none',
      attentionLabel: `usage limit, resumes ${autoResumeAt}`,
    });
  });

  it('leaves every other label as the cockpit says it', () => {
    expect(attentionFields({ status: 'failed' })).toEqual({ attention: 'error', attentionLabel: 'failed' });
  });
});

// hearsay-tools/cezarion#1458: a CLI or webhook reader answers from the same context the card shows.
describe('projectStatus', () => {
  const run = { id: 'r1', title: 'Task', status: 'waiting' } as unknown as ApiRun;
  const questions = [{ header: 'Choice', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }];

  it('carries a pending question with its context', () => {
    expect(projectStatus(run, 'u', { questions, context: '## Draft' })).toMatchObject({ question: questions, questionContext: '## Draft' });
  });

  it('leaves both keys off without a question, and the context off without one', () => {
    const none = projectStatus(run, 'u');
    expect(none).not.toHaveProperty('question');
    expect(none).not.toHaveProperty('questionContext');
    const bare = projectStatus(run, 'u', { questions });
    expect(bare).toMatchObject({ question: questions });
    expect(bare).not.toHaveProperty('questionContext');
  });
});
