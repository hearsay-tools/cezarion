import { describe, expect, it } from 'vitest';
import {
  automationDefinitionSchema,
  isGithubAutomation,
  isScheduleAutomation,
  automationDefinitionsFileSchema,
  automationRuntimeStateSchema,
} from './types.ts';

const definition = {
  id: 'review-new-prs',
  revision: 1,
  name: 'Review new PRs',
  enabled: false,
  events: ['pull_request.opened'],
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}}' },
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:00.000Z',
};

describe('automation schemas', () => {
  it('pins safe interval, lookback, and result bounds', () => {
    expect(automationDefinitionSchema.safeParse({ ...definition, intervalSeconds: 59 }).success).toBe(false);
    expect(
      automationDefinitionSchema.safeParse({
        ...definition,
        filters: { lookbackDays: 91, maxRecords: 101 },
      }).success,
    ).toBe(false);
  });

  it('requires watched labels for label transition events', () => {
    expect(
      automationDefinitionSchema.safeParse({ ...definition, events: ['issue.labeled'] }).success,
    ).toBe(false);
  });

  it('preserves unknown fields at every persisted object layer', () => {
    const parsed = automationDefinitionSchema.parse({
      ...definition,
      future: true,
      filters: { ...definition.filters, futureFilter: 'kept' },
      task: { ...definition.task, futureTask: 'kept' },
    });
    expect(parsed.future).toBe(true);
    expect(parsed.filters?.futureFilter).toBe('kept');
    expect(parsed.task.futureTask).toBe('kept');
    const scheduled = automationDefinitionSchema.parse({
      ...definition,
      kind: 'schedule',
      events: undefined,
      intervalSeconds: undefined,
      filters: undefined,
      schedule: { type: 'daily', futureSchedule: 'kept' },
    });
    expect(scheduled.schedule?.futureSchedule).toBe('kept');
    expect(automationDefinitionsFileSchema.parse({ version: 1, automations: [], future: 1 }).future).toBe(1);
    expect(automationRuntimeStateSchema.parse({ future: 'kept' }).future).toBe('kept');
  });

  it('defaults new definitions to paused and conservative bounds', () => {
    const parsed = automationDefinitionSchema.parse({
      ...definition,
      enabled: undefined,
      intervalSeconds: undefined,
      filters: {},
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.intervalSeconds).toBe(300);
    expect(parsed.filters).toMatchObject({ lookbackDays: 7, maxRecords: 25 });
  });

  it('parses a pre-schedule definition as a github poll with its defaults', () => {
    const { intervalSeconds: _interval, filters: _filters, ...old } = definition;
    const parsed = automationDefinitionSchema.parse(old);
    expect(parsed.kind).toBe('github');
    expect(parsed.intervalSeconds).toBe(300);
    expect(parsed.filters).toMatchObject({ lookbackDays: 7, maxRecords: 25 });
    expect(isGithubAutomation(parsed)).toBe(true);
    expect(isScheduleAutomation(parsed)).toBe(false);
  });

  it('parses a schedule definition without poll keys', () => {
    const { events: _events, intervalSeconds: _interval, filters: _filters, ...base } = definition;
    const parsed = automationDefinitionSchema.parse({ ...base, kind: 'schedule', schedule: { type: 'daily' } });
    expect(parsed.intervalSeconds).toBeUndefined();
    expect(parsed.filters).toBeUndefined();
    expect(isScheduleAutomation(parsed)).toBe(true);
    expect(isGithubAutomation(parsed)).toBe(false);
  });

  it('reports a missing schedule or missing events at their own path', () => {
    const { events: _events, ...noEvents } = definition;
    const github = automationDefinitionSchema.safeParse(noEvents);
    expect(github.success).toBe(false);
    expect(!github.success && github.error.issues.map((issue) => issue.path)).toContainEqual(['events']);

    const { events: _e, intervalSeconds: _i, filters: _f, ...base } = definition;
    const schedule = automationDefinitionSchema.safeParse({ ...base, kind: 'schedule' });
    expect(schedule.success).toBe(false);
    expect(!schedule.success && schedule.error.issues.map((issue) => issue.path)).toContainEqual(['schedule']);
  });
});
