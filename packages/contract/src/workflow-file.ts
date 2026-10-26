import { z } from 'zod';
import { workflowStepDefSchema as workflowStepSchema } from './workflows.ts';

/**
 * A workflow file names either full `steps` or the portable `skills` shorthand
 * (spec 012 — what the builder exports): an ordered list of skill names, each
 * becoming one agent step that applies that skill to `{{task}}`.
 */
export const workflowFileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    steps: z.array(workflowStepSchema).min(1).optional(),
    skills: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .refine((d) => Boolean(d.steps) !== Boolean(d.skills), {
    message: 'a workflow lists either "steps" or "skills", not both',
  });

export type WorkflowDoc = z.infer<typeof workflowFileSchema>;
