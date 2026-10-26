import { z } from 'zod';
import { automationKindSchema, automationLogResultSchema, automationEventSchema } from './automations.ts';
import { storedAutomationFiltersSchema as automationFiltersSchema, storedAutomationTaskSchema as automationTaskSchema } from './automation-storage.ts';
import { automationScheduleSchema } from './automation-schedule.ts';
import { singleRunVariantsSchema } from './runs.ts';

/**
 * The editable body of both kinds. Every kind-specific key is optional here because which ones a
 * body must (or must not) carry depends on the kind, and on `PUT` the kind is the STORED one when
 * the body omits it — the service's `resolveAutomationKind` owns those rules.
 */
export const automationEditableSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    enabled: z.boolean().optional(),
    kind: automationKindSchema.optional(),
    events: z.array(automationEventSchema).min(1).max(4).optional(),
    intervalSeconds: z.number().int().min(60).max(86_400).optional(),
    filters: automationFiltersSchema.optional(),
    schedule: automationScheduleSchema.optional(),
    task: automationTaskSchema.safeExtend({ variants: singleRunVariantsSchema }),
  })
  .strict();
export type AutomationEditable = z.infer<typeof automationEditableSchema>;
export const automationCreateSchema = automationEditableSchema.extend({ enable: z.boolean().optional() });
export const automationUpdateSchema = automationEditableSchema.extend({ expectedRevision: z.number().int().positive() });

export const automationCheckRequestSchema = z.object({ mode: z.enum(['preview', 'execute']) }).strict();

export const automationLogQuerySchema = z.object({
  automationId: z.string().optional(),
  result: automationLogResultSchema.optional(),
  event: automationEventSchema.optional(),
  since: z.string().datetime().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  // Optional, not `.default(100)`: `AutomationStore.logs` already clamps `limit ?? 100` into
  // 1..100, so the default here was a second copy of it — and a defaulted key is REQUIRED in the
  // request type `queryZodValidator` publishes (see validators.ts on why the request side falls
  // back to the schema's output), which would have made every caller send a `?limit=` this route
  // never needed.
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
