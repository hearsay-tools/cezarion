import { describe, expect, it } from 'vitest';
import { stepStateSchema } from './runs.ts';

const step = { id: 'work', name: 'Work', kind: 'agent', status: 'waiting', iterations: 1, tokensUsed: 0 };

describe('step session transport', () => {
  it('keeps legacy records without a transport tag', () => {
    expect(stepStateSchema.parse(step)).not.toHaveProperty('sessionTransport');
  });

  it('round trips a print session without changing its native id', () => {
    const saved = { ...step, sessionId: 'native-id', sessionTransport: 'cursor-print' };
    expect(stepStateSchema.parse(JSON.parse(JSON.stringify(stepStateSchema.parse(saved))))).toMatchObject(saved);
  });

  it('rejects unknown transports', () => {
    expect(stepStateSchema.safeParse({ ...step, sessionTransport: 'cursor-other' }).success).toBe(false);
  });
});
