import { describe, expect, it } from 'vitest';
import { ASK_LIMITS, askRequestSchema } from './ask-schema.ts';
import { cezarAskRequestSchema, humanWaitEntrySchema } from './waits.ts';

const questions = [{ header: 'Choice', question: 'Which module?', options: [{ label: 'Parser' }, { label: 'Runner' }] }];

// hearsay-tools/cezarion#1458: the tool requires context; every stored shape keeps asks without it.
describe('ask context', () => {
  it('limits context to 20,000 characters', () => {
    expect(ASK_LIMITS.context).toBe(20_000);
  });

  it('keeps context optional in the stored ask shape', () => {
    expect(askRequestSchema.parse({ questions })).toEqual({ questions });
    expect(askRequestSchema.parse({ context: '## Draft', questions })).toEqual({ context: '## Draft', questions });
    expect(askRequestSchema.safeParse({ context: '', questions }).success).toBe(false);
    expect(askRequestSchema.safeParse({ context: 'a'.repeat(ASK_LIMITS.context + 1), questions }).success).toBe(false);
  });

  it('requires context in the cezar_ask input', () => {
    const missing = cezarAskRequestSchema.safeParse({ questions });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map(issue => issue.path)).toEqual([['context']]);
    expect(cezarAskRequestSchema.safeParse({ context: 'a'.repeat(ASK_LIMITS.context), questions }).success).toBe(true);
  });

  it('stores context on a human wait, and parses a wait recorded without it', () => {
    const wait = { id: '00000000-0000-4000-8000-000000000001', kind: 'human', source: 'agent', via: 'cezar_ask',
      registeredAt: '2026-10-22T00:00:00.000Z', phase: 'open', turnId: 't', questions };
    expect(humanWaitEntrySchema.parse(wait)).toEqual(wait);
    expect(humanWaitEntrySchema.parse({ ...wait, context: '## Draft' })).toMatchObject({ context: '## Draft' });
  });
});
