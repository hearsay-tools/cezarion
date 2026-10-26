import { z } from 'zod';
import { queryValue } from './query-requests.ts';

// ---- chained family: GitHub (project-scoped) ----
// These sit ABOVE the routes rather than with the family's other schemas below it, because a
// validator argument is evaluated when the route is REGISTERED — a schema declared further down
// would be in its temporal dead zone. (The schemas below are all read inside a handler, or
// passed as a thunk, which defers them past that point.)
export const mergeNumberParams = z.object({ number: z.coerce.number().int().positive() });

export const prChangesParams = z.object({ number: z.coerce.number().int().positive().safe() });

export const prChangesQuery = z.object({ refresh: queryValue.refine((v) => v === undefined || v === '1') });

export const mergeBodySchema = z.object({
    method: z.enum(['merge', 'squash', 'rebase']),
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
    overrideRules: z.boolean().optional().default(false),
  }).strict();

export const githubChecksQuerySchema = z.object({ prs: z.string().min(1) });

export const githubRefsQuerySchema = z.object({ prs: z.string().optional(), issues: z.string().optional() });
