import { describe, expect, it } from 'vitest';
import { cezarDoneAnswerSchema } from '@open-mercato/cezar-contract/waits';
import { stepLabel } from './run.ts';
import { workflowStepSchema } from './types.ts';

// The step a `cezar_done` names in `next_step` (hearsay-tools/cezarion#1620). The answer schema
// requires a nonempty name, and a workflow file may give a step an empty one.
describe('stepLabel', () => {
  const answer = (next_step: string) => ({ ok: true, finishes: 'at_turn_end', completes: 'step', next_step, open_waits: [] });

  it('names a step by its name', () => {
    expect(stepLabel(workflowStepSchema.parse({ id: 'review', name: 'Review', prompt: 'p' }))).toBe('Review');
  });

  it.each([undefined, '', '   '])('falls back to the step id for the name %j, so the done answer stays valid', name => {
    const label = stepLabel(workflowStepSchema.parse({ id: 'review', ...(name === undefined ? {} : { name }), prompt: 'p' }));
    expect(label).toBe('review');
    expect(cezarDoneAnswerSchema.safeParse(answer(label)).success).toBe(true);
  });
});
