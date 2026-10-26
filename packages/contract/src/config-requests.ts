import { z } from 'zod';
import { setConfigInputSchema } from './workspace.ts';

/** The request keeps the server's explicit message for the system-prompt bound. */
export const setConfigSchema = setConfigInputSchema.extend({
  systemPrompt: z.string().trim().max(20_000, 'must be at most 20000 characters').nullable().optional(),
});

export const setAgentConfigSchema = z.object({
  content: z.string().max(2_000_000),
  version: z.string().nullable(),
});
