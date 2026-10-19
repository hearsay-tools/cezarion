import { runnerModelOptionSchema } from '@open-mercato/cezar-contract/workspace';
import { describe, expect, it } from 'vitest';

describe('runnerModelOptionSchema effort metadata (#55)', () => {
  it('preserves ordered canonical effort levels and keeps omission compatible', () => {
    expect(
      runnerModelOptionSchema.parse({
        id: 'openai/gpt-5.6-sol',
        label: 'openai/gpt-5.6-sol',
        description: 'via openai',
        effortLevels: ['low', 'high', 'max'],
      }),
    ).toEqual({
      id: 'openai/gpt-5.6-sol',
      label: 'openai/gpt-5.6-sol',
      description: 'via openai',
      effortLevels: ['low', 'high', 'max'],
    });
    expect(
      runnerModelOptionSchema.parse({ id: 'legacy', label: 'Legacy', description: '' }),
    ).toEqual({ id: 'legacy', label: 'Legacy', description: '' });
  });

  it('rejects non-canonical discovered levels', () => {
    expect(
      runnerModelOptionSchema.safeParse({
        id: 'model',
        label: 'Model',
        description: '',
        effortLevels: ['minimal'],
      }).success,
    ).toBe(false);
  });
});
