import { z } from 'zod';
import { automationKindSchema, automationHistoryScanSchema } from './automations.ts';
import { automationScheduleSchema, type AutomationSchedule } from './automation-schedule.ts';
import { runnerSchema } from './health.ts';
const RUNNER_IDS = runnerSchema.options;
import { workflowStepDefSchema as workflowStepSchema } from './workflows.ts';

export const storedAutomationEventSchema = z.enum([
  'pull_request.opened',
  'issue.opened',
  'issue.labeled',
  'issue.unlabeled',
]);

const boundedString = z.string().trim().min(1).max(200);
const stringList = z.array(boundedString).max(100).optional();

export const storedAutomationFiltersSchema = z
  .object({
    includeExisting: z.boolean().optional(),
    /** Require an open item and matching live labels before reservation and launch. */
    requireCurrentLabels: z.boolean().optional(),
    authors: stringList,
    assignees: stringList,
    allLabels: stringList,
    anyLabels: stringList,
    excludeLabels: stringList,
    changedLabels: stringList,
    lookbackDays: z.number().int().min(1).max(90).default(7),
    maxRecords: z.number().int().min(1).max(100).default(25),
  })
  .passthrough();

export const storedAutomationTaskSchema = z
  .object({
    prompt: z.string().min(1).max(100_000),
    workflow: z.string().trim().min(1).max(200).optional(),
    steps: z.array(workflowStepSchema).min(1).max(100).optional(),
    runner: z.enum(RUNNER_IDS).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    effort: z.string().trim().min(1).max(32).optional(),
    variants: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    worktree: z.boolean().optional(),
    autonomous: z.boolean().optional(),
    archiveWhenDone: z.boolean().optional(),
    autoMergePr: z.boolean().optional(),
    systemPrompt: z.string().max(100_000).optional(),
  })
  .passthrough()
  .refine((task) => !(task.workflow && task.steps), {
    message: 'task selects either a named workflow or inline steps, not both',
  });

/**
 * A poll's two defaulted keys are filled BEFORE parsing, and only for the poll kind: `.default()`
 * on the keys themselves would also stamp `intervalSeconds: 300` and an empty filter onto every
 * scheduled definition, and the routes would then read those as a GitHub filter on a schedule.
 */
const fillGithubDefaults = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (record.kind === 'schedule') return raw;
  return {
    ...record,
    intervalSeconds: record.intervalSeconds ?? 300,
    filters: record.filters ?? {},
  };
};

/** The definition's object shape, before the poll-default preprocess. */
export const storedAutomationDefinitionObjectSchema = z
  .object({
    id: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    enabled: z.boolean().default(false),
    /** A definition written before schedules has no `kind`: it is a poll. */
    kind: automationKindSchema.default('github'),
    events: z.array(storedAutomationEventSchema).min(1).max(4).optional(),
    intervalSeconds: z.number().int().min(60).max(86_400).optional(),
    filters: storedAutomationFiltersSchema.optional(),
    // Passthrough like every other persisted layer: a schedule key a later build adds survives a save here.
    schedule: automationScheduleSchema.passthrough().optional(),
    task: storedAutomationTaskSchema,
    /** `once` schedules only (hearsay-tools/cezarion#1465): the archive record. */
    archived: z
      .object({
        at: z.string().datetime(),
        outcome: z.enum(['launched', 'cancelled']),
        runId: z.string().optional(),
        receiptId: z.string().optional(),
        trigger: z.enum(['schedule', 'late', 'manual', 'retry']).optional(),
      })
      .passthrough()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough()
  .superRefine((definition, ctx) => {
    if (definition.kind === 'schedule') {
      if (!definition.schedule) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schedule'], message: 'a scheduled automation needs a schedule' });
      }
      return;
    }
    // github kind: the three poll keys are required, as they always were.
    if (!definition.events?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events'], message: 'a GitHub automation needs at least one event' });
    }
    if (definition.intervalSeconds === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['intervalSeconds'], message: 'a GitHub automation needs a poll interval' });
    }
    if (!definition.filters) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters'], message: 'a GitHub automation needs its bounded filter' });
    }
    if (
      definition.events?.some((event) => event === 'issue.labeled' || event === 'issue.unlabeled') &&
      !definition.filters?.changedLabels?.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filters', 'changedLabels'],
        message: 'changedLabels is required for issue label events',
      });
    }
  });

export const storedAutomationDefinitionSchema = z.preprocess(fillGithubDefaults, storedAutomationDefinitionObjectSchema);

export const storedAutomationDefinitionsFileSchema = z
  .object({
    version: z.literal(1).default(1),
    automations: z.array(z.unknown()).default([]),
    tombstones: z.record(z.string(), z.string().datetime()).optional(),
  })
  .passthrough();

export const storedAutomationCursorSchema = z
  .object({
    timestamp: z.string().datetime(),
    tieBreaker: z.string().optional(),
  })
  .passthrough();

/** Durable position inside a bounded historical search, independent of the live overlap. */
export const storedAutomationHistoryScanSchema = automationHistoryScanSchema.extend({
  cursor: storedAutomationCursorSchema.optional(),
});

export const storedAutomationRuntimeStateSchema = z
  .object({
    revision: z.number().int().positive().optional(),
    baselineAt: z.string().datetime().optional(),
    /** Arming time, independent of a history window's older lower bound. */
    armedAt: z.string().datetime().optional(),
    historyScan: storedAutomationHistoryScanSchema.optional(),
    cursor: storedAutomationCursorSchema.optional(),
    frozenHighWatermark: storedAutomationCursorSchema
      .extend({ tieBreaker: z.string() })
      .optional(),
    backlogAfter: storedAutomationCursorSchema.extend({ tieBreaker: z.string() }).optional(),
    nextCheckAt: z.string().datetime().optional(),
    lastSuccessAt: z.string().datetime().optional(),
    /** schedule kind: the next occurrence's instant and the last fired one's. */
    nextRunAt: z.string().datetime().optional(),
    lastRunAt: z.string().datetime().optional(),
    etags: z.record(z.string(), z.string()).optional(),
    backoffUntil: z.string().datetime().optional(),
    consecutiveFailures: z.number().int().nonnegative().optional(),
    /** once schedule: it stopped without a task — the launch failed, or it started past its cutoff. */
    onceOutcome: z.enum(['failed', 'missed']).optional(),
  })
  .passthrough();

export const storedAutomationStateFileSchema = z
  .object({
    version: z.literal(1).default(1),
    states: z.record(z.string(), storedAutomationRuntimeStateSchema).default({}),
  })
  .passthrough();

export const storedAutomationReceiptSchema = z
  .object({
    receiptId: z.string().min(1),
    receiptKey: z.string().min(1),
    eventId: z.string().min(1),
    automationId: z.string().min(1),
    revision: z.number().int().positive(),
    status: z.enum(['reserved', 'launched', 'launch-error', 'released']),
    runId: z.string().optional(),
    observedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    error: z.string().max(2_000).optional(),
    /** schedule kind: the occurrence this receipt reserved, so a retry can fire it again. */
    occurrenceAt: z.string().datetime().optional(),
    candidate: z
      .object({
        eventId: z.string(), event: storedAutomationEventSchema, timestamp: z.string().datetime(),
        tieBreaker: z.string(), repo: z.string(), nodeId: z.string(), number: z.number().int().positive(),
        title: z.string().max(500), url: z.string().url(), author: z.string().max(200),
        assignees: z.array(z.string().max(200)).max(100), labels: z.array(z.string().max(200)).max(100),
        changedLabel: z.string().max(200).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const storedAutomationLogResultSchema = z.enum([
  'launched',
  'no-match',
  'duplicate',
  'rate-limited',
  'error',
  'baseline',
  'preview',
  'skipped',
  // schedule kind
  'manual',
  'catch-up',
  'failed',
  // once schedule
  'missed',
]);

export const storedAutomationLogRecordSchema = z
  .object({
    seq: z.number().int().positive(),
    ts: z.string().datetime(),
    automationId: z.string().min(1),
    revision: z.number().int().positive(),
    event: storedAutomationEventSchema.optional(),
    result: storedAutomationLogResultSchema,
    reason: z.string().max(2_000).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    receiptId: z.string().optional(),
    runId: z.string().optional(),
    githubNumber: z.number().int().positive().optional(),
    githubTitle: z.string().max(500).optional(),
    githubUrl: z.string().url().optional(),
    rateLimit: z
      .object({
        bucket: z.enum(['core', 'search']),
        remaining: z.number().int().nonnegative().optional(),
        resetAt: z.string().datetime().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type StoredAutomationEvent = z.infer<typeof storedAutomationEventSchema>;
export type StoredAutomationDefinition = z.infer<typeof storedAutomationDefinitionSchema>;
export type StoredAutomationArchive = NonNullable<StoredAutomationDefinition['archived']>;
export type StoredAutomationRuntimeState = z.infer<typeof storedAutomationRuntimeStateSchema>;
export type StoredAutomationReceipt = z.infer<typeof storedAutomationReceiptSchema>;
export type StoredAutomationLogRecord = z.infer<typeof storedAutomationLogRecordSchema>;

/**
 * The two kinds, narrowed: the poller and the GitHub scheduler take a `StoredGithubAutomationDefinition`
 * so the poll keys are plain required fields there; the schedule runner takes the other.
 * `superRefine` above guarantees the guards hold for every definition the store hands out.
 */
export type StoredGithubAutomationDefinition = StoredAutomationDefinition & {
  kind: 'github';
  events: StoredAutomationEvent[];
  intervalSeconds: number;
  filters: NonNullable<StoredAutomationDefinition['filters']>;
};
export type StoredScheduleAutomationDefinition = StoredAutomationDefinition & {
  kind: 'schedule';
  schedule: AutomationSchedule;
};

/** A `once` schedule: the shape fires a single time, then the definition is archived. */
export type StoredOnceScheduleDefinition = StoredScheduleAutomationDefinition & {
  schedule: AutomationSchedule & { type: 'once'; at: string; timeZone: string };
};

export function storedIsOnceSchedule(definition: StoredAutomationDefinition): definition is StoredOnceScheduleDefinition {
  return storedIsScheduleAutomation(definition)
    && definition.schedule.type === 'once'
    && typeof definition.schedule.at === 'string'
    && typeof definition.schedule.timeZone === 'string';
}

export function storedIsGithubAutomation(definition: StoredAutomationDefinition): definition is StoredGithubAutomationDefinition {
  return definition.kind === 'github'
    && Array.isArray(definition.events)
    && definition.intervalSeconds !== undefined
    && definition.filters !== undefined;
}

export function storedIsScheduleAutomation(definition: StoredAutomationDefinition): definition is StoredScheduleAutomationDefinition {
  return definition.kind === 'schedule' && definition.schedule !== undefined;
}
