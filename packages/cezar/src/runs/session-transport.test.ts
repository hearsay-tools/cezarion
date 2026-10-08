import { describe, expect, it } from 'vitest';
import { runRecordSchema } from './store.ts';

describe('stored session transport', () => {
  it('keeps a print step and rejects an unknown transport', () => {
    const step = { id: 'work', name: 'Work', kind: 'agent', status: 'waiting', iterations: 1, tokensUsed: 0, sessionId: 'native-id', sessionTransport: 'cursor-print' };
    const parsed = runRecordSchema.shape.steps.element.safeParse(step);
    expect(parsed.success && parsed.data.sessionTransport).toBe('cursor-print');
    expect(runRecordSchema.shape.steps.element.safeParse({ ...step, sessionTransport: 'other' }).success).toBe(false);
  });
});
