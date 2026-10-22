import { describe, expect, it } from 'vitest';
import { onceStatus } from './service.ts';
import type { AutomationDefinition } from './types.ts';

const once = {
  id: 'once', revision: 1, name: 'Once', enabled: false, kind: 'schedule',
  schedule: { type: 'once', at: '2026-10-29T09:00', timeZone: 'UTC' },
  task: { prompt: 'Go' }, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
} as AutomationDefinition;

describe('onceStatus', () => {
  it.each([
    ['paused', once, undefined],
    ['waiting', { ...once, enabled: true }, undefined],
    ['failed', once, { onceOutcome: 'failed' as const }],
    ['missed', once, { onceOutcome: 'missed' as const }],
    ['archived', { ...once, archived: { at: '2026-10-29T09:00:01.000Z', outcome: 'launched' as const } }, { onceOutcome: 'failed' as const }],
  ])('%s', (expected, definition, state) => {
    expect(onceStatus(definition, state)).toBe(expected);
  });

  it('is absent for a repeating schedule', () => {
    expect(onceStatus({ ...once, schedule: { type: 'daily', hour: 4 } }, undefined)).toBeUndefined();
  });
});
