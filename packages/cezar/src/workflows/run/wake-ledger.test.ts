import { describe, expect, it, vi } from 'vitest';
import { makeHumanWait, makeRunRecord, makeTimerWait, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { owesWake } from './wake-ledger.ts';

// The native-question gate must also hold after recovery, when no session exists.
describe('wake precedence', () => {
  it('a pending native question blocks resolved waits and messages until its routed answer arrives', () => {
    const run = makeRunRecord({ waits: [
      makeHumanWait({ via: WAIT_VIA['native-ask'] }),
      makeTimerWait({ phase: WAIT_PHASE.resolved }),
    ] });
    const routedAnswer = vi.fn<Parameters<typeof owesWake>[1]['routedAnswer']>().mockReturnValue(undefined);
    const pendingConversationWakes = vi.fn<Parameters<typeof owesWake>[1]['pendingConversationWakes']>();
    expect(owesWake(run, { routedAnswer, pendingConversationWakes })).toBe(false);
    expect(pendingConversationWakes).not.toHaveBeenCalled();
    routedAnswer.mockReturnValue({ id: 'answer', parentRunId: run.id, source: agentInputSchema.shape.source.enum.agent, text: 'Continue', createdAt: '2026-10-28T00:00:00Z' });
    expect(owesWake(run, { routedAnswer, pendingConversationWakes })).toBe(true);
    expect(pendingConversationWakes).not.toHaveBeenCalled();
  });

  it('a resolved wait wakes before conversation reads', () => {
    const run = makeRunRecord({ waits: [makeTimerWait({ phase: WAIT_PHASE.resolved })] });
    const routedAnswer = vi.fn<Parameters<typeof owesWake>[1]['routedAnswer']>();
    const pendingConversationWakes = vi.fn<Parameters<typeof owesWake>[1]['pendingConversationWakes']>();
    expect(owesWake(run, { routedAnswer, pendingConversationWakes })).toBe(true);
    expect(routedAnswer).not.toHaveBeenCalled();
    expect(pendingConversationWakes).not.toHaveBeenCalled();
  });

  it('with no pending native question or resolved wait, messages decide the wake', () => {
    const run = makeRunRecord();
    const pendingConversationWakes = vi.fn<Parameters<typeof owesWake>[1]['pendingConversationWakes']>().mockReturnValue([]);
    const routedAnswer = vi.fn<Parameters<typeof owesWake>[1]['routedAnswer']>().mockReturnValue(undefined);
    expect(owesWake(run, { routedAnswer, pendingConversationWakes })).toBe(false);
    expect(pendingConversationWakes).toHaveBeenCalledWith(run, undefined);
    expect(pendingConversationWakes.mock.invocationCallOrder[0]).toBeLessThan(routedAnswer.mock.invocationCallOrder[0]!);
  });
});
