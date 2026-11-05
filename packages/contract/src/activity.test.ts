import { describe, expect, it } from 'vitest';
import { ACTIVITY_TOOL_KINDS, activityQuerySchema, activityRunSchema } from './activity.ts';
import { RUN_STATUS } from './test-factories.testkit.ts';
import type { ToolKind } from './tool-display.ts';

type Assert<T extends true> = T;
type _EveryToolKind = Assert<[ToolKind] extends [(typeof ACTIVITY_TOOL_KINDS)[number]] ? true : false>;

describe('the activity contract', () => {
  it('takes a project slug or the boot alias, never a colon', () => {
    expect(activityQuerySchema.parse({})).toEqual({});
    expect(activityQuerySchema.parse({ project: 'default' })).toEqual({ project: 'default' });
    expect(activityQuerySchema.parse({ project: 'all' })).toEqual({ project: 'all' });
    expect(activityQuerySchema.safeParse({ project: 'shop:all' }).success).toBe(false);
    expect(activityQuerySchema.safeParse({ project: 'Shop' }).success).toBe(false);
  });

  it('holds a heartbeat of exactly 30 buckets', () => {
    const run = { runId: 'r', title: 't', status: RUN_STATUS.running, rung: 'running', rate: Array.from({ length: 30 }, () => 0), workers: [] };
    expect(activityRunSchema.safeParse(run).success).toBe(true);
    expect(activityRunSchema.safeParse({ ...run, rate: [0] }).success).toBe(false);
    expect(ACTIVITY_TOOL_KINDS).toHaveLength(11);
  });
});
