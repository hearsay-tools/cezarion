import { z } from 'zod';


// Session commit (redesign R5 — §"Git/session API additions").
export const gitCommitSchema = z.object({
  message: z.string().trim().min(1, 'must not be empty').max(5_000),
});

export const reclaimBodySchema = z.object({}).passthrough();

// Repo view branch actions: switch to an existing branch, or create one
// (from `from` or HEAD) and switch. Predictable git failures — invalid
// name, unknown `from`, dirty-tree checkout conflict — are 409 + reason.
export const repoBranchSchema = z.object({
    name: z.string().trim().min(1).max(200),
    from: z.string().trim().min(1).max(200).optional(),
  });

export const reclaimRunParamsSchema = z.object({ runId: z.string().min(1) });
