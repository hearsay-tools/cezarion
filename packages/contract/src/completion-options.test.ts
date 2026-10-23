import { describe, expect, it } from 'vitest';
import { createRunInputSchema, patchRunInputSchema } from './runs.ts';
import { automationTaskSchema } from './automations.ts';

describe('completion options', () => {
  it('uses the same opt-in values for task creation, edits, and automation tasks', () => {
    const options = { archiveWhenDone: true, autoMergePr: true };
    expect(createRunInputSchema.parse({ workflow: 'quick-task', task: 'test', ...options })).toMatchObject(options);
    expect(patchRunInputSchema.parse(options)).toEqual(options);
    expect(automationTaskSchema.parse({ prompt: 'test', ...options })).toMatchObject(options);
  });
  it('leaves absent flags off and refuses non-booleans', () => {
    const task = { workflow: 'quick-task', task: 'test' };
    expect(createRunInputSchema.parse(task)).not.toHaveProperty('archiveWhenDone');
    expect(createRunInputSchema.parse(task)).not.toHaveProperty('autoMergePr');
    for (const key of ['archiveWhenDone', 'autoMergePr']) {
      expect(createRunInputSchema.safeParse({ ...task, [key]: 'true' }).success).toBe(false);
    }
  });
});
