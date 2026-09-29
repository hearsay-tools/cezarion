import { describe, expect, it } from 'vitest';
import { workflowStepDefSchema } from '@open-mercato/cezar-contract';
import { skillStackOf, skillsToSteps, workflowStepSchema } from './types.ts';

describe('authored workflow timeout policy', () => {
  for (const [name, schema] of [['contract', workflowStepDefSchema], ['workflow', workflowStepSchema]] as const) {
    it.each([0, 150, 7_200_000, 2_147_483_647])(`${name} preserves timeoutMs %i`, timeoutMs => {
      expect(schema.parse({ id: 'work', skill: 'implement', timeoutMs })).toMatchObject({ timeoutMs });
    });
    it.each([-1, 0.5, 2_147_483_648, Infinity, NaN, '1000', null])(`${name} rejects unsafe timeoutMs %s`, timeoutMs => {
      expect(schema.safeParse({ id: 'work', prompt: '{{task}}', timeoutMs }).success).toBe(false);
    });
    it(`${name} rejects a timeout on a shell check`, () => {
      expect(schema.safeParse({ id: 'check', command: 'npm test', timeoutMs: 1000 }).success).toBe(false);
    });
  }
  it.each([0, 150])('does not discard authored timeoutMs %i when saving a skill workflow', timeoutMs => {
    const step = workflowStepSchema.parse({ id: 'implement', skill: 'implement', prompt: '{{task}}', timeoutMs });
    expect(skillStackOf([step])).toBeNull();
  });
  it('skill shorthand introduces no authored limit', () => {
    const steps = skillsToSteps(['implement', 'verify']);
    expect(steps).toEqual([
      { id: 'implement', name: 'implement', skill: 'implement', prompt: '{{task}}' },
      { id: 'verify', name: 'verify', skill: 'verify', prompt: '{{task}}' },
    ]);
    expect(skillStackOf(steps)).toEqual(['implement', 'verify']);
  });
});
