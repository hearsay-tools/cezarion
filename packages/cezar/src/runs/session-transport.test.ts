import { STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import { runRecordSchema } from './store.ts';

describe('stored session transport', () => {
  it('keeps a print step and rejects an unknown transport', () => {
    const step = { id: 'work', name: 'Work', kind: STEP_KIND.agent, status: STEP_STATUS.waiting, iterations: 1, tokensUsed: 0, sessionId: 'native-id', sessionTransport: 'cursor-print' };
    const parsed = runRecordSchema.shape.steps.element.safeParse(step);
    expect(parsed.success && parsed.data.sessionTransport).toBe('cursor-print');
    expect(runRecordSchema.shape.steps.element.safeParse({ ...step, sessionTransport: 'other' }).success).toBe(false);
  });
});
