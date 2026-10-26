import { z } from 'zod';


export const planSchema = z.object({
  // Same bound as `createRunInputSchema.task` — this flows into `planChain` (legacy reference 429).
  task: z.string().trim().min(1).max(100_000, 'must be at most 100000 characters'),
});

export const parseWorkflowSchema = z.object({
  yaml: z.string().min(1).max(100_000),
});
