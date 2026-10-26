import { z } from 'zod';
import { uiStateSchema as storedUiStateSchema } from './workspace.ts';

/** Bound write-side preferences while retaining unknown future keys. */
const SKILL_USAGE_MAX_ENTRIES = 200;

const UI_STATE_MAX_KEYS = 200;

const uiStateSchema = storedUiStateSchema.extend({
    // null records a quick task with no selected skill or workflow.
    lastTask: z
      .object({
        source: z.enum(['workflow', 'skill']),
        ref: z.string().min(1).max(200),
      })
      .nullable()
      .optional(),
    // Most recent source choices, newest first.
    recentSources: z
      .array(
        z.object({
          source: z.enum(['workflow', 'skill']),
          ref: z.string().min(1).max(200),
        }),
      )
      .max(50)
      .optional(),
    skillUsage: z
      .record(z.string().min(1).max(200), z.number().int().min(0).max(1_000_000))
      .refine((usage) => Object.keys(usage).length <= SKILL_USAGE_MAX_ENTRIES, {
        message: `skillUsage must have at most ${SKILL_USAGE_MAX_ENTRIES} entries`,
      })
      .optional(),
    promptTemplates: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          label: z.string().trim().min(1).max(80),
          text: z.string().trim().min(1).max(2000),
          // Skill names this template auto-applies for. Optional and additive: templates
          // written before this key existed keep validating, and stay manual-only.
          skills: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
        }),
      )
      .max(50)
      .optional(),
  })
  .passthrough();

/** Both preference write routes enforce the same top-level key cap. */
function capUiStateKeys(data: unknown, ctx: z.RefinementCtx): void {
  if (Object.keys(data as Record<string, unknown>).length > UI_STATE_MAX_KEYS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ui-state has too many keys (max ${UI_STATE_MAX_KEYS})` });
  }
}

// Derived once per route instead of by a generic `wrap(schema)` helper called at the route: a
// generic wrapper leaves the schema type unresolved where `jsonBody` needs it, and Hono answers
// that by dropping the whole PUT from the route schema rather than erroring — both ui-state PUTs
// silently vanished from `AppType`. Concrete consts keep them visible to `hc`.
export const uiStateBody = uiStateSchema.superRefine(capUiStateKeys);
