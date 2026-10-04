import { describe, expect, it } from 'vitest';
import { plannedWorkflow, skillFlagIssue, skillTaskSteps, stepsIssue, workflowStepSchema } from './types.ts';

describe('skill-task workflow helpers', () => {
  it('builds one task step that applies the selected skill', () => {
    expect(skillTaskSteps('x')).toEqual([
      { id: 'task', name: 'x', skill: 'x', prompt: '{{task}}' },
    ]);
  });

  it('wraps supplied steps as a built-in planned workflow', () => {
    const steps = [{ id: 'first', prompt: '{{task}}' }];
    expect(plannedWorkflow(steps)).toEqual({
      name: '(planned)', source: 'built-in', steps: [{ id: 'first', prompt: '{{task}}' }],
    });
  });

  it.each([
    { skill: 'x', workflow: 'review' },
    { skill: '', workflow: '' },
    { skill: ' ', workflow: 'review' },
  ])('rejects simultaneous skill and workflow flags: %j', (flags) => {
    expect(skillFlagIssue(flags)).toBe('--skill and --workflow cannot be used together');
  });

  it.each(['', ' ', '\t\n'])('rejects a blank skill name: %j', (skill) => {
    expect(skillFlagIssue({ skill })).toBe('--skill must name a skill');
  });

  it.each([{}, { workflow: 'review' }, { skill: 'x' }])('accepts valid flags: %j', (flags) => {
    expect(skillFlagIssue(flags)).toBeUndefined();
  });

  it('builds steps accepted by the server schema and structural validation', () => {
    const steps = skillTaskSteps('x');
    expect(workflowStepSchema.array().safeParse(steps).success).toBe(true);
    expect(stepsIssue(steps)).toBeNull();
  });
});
