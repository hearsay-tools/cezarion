import { describe, expect, it } from 'vitest';
import { attentionFields } from './projections.ts';

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
