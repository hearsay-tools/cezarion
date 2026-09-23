import { z } from 'zod';

/** Safe, CORS-readable progress for an explicit local application update. */
export const applicationUpdateStateSchema = z.object({
  status: z.enum(['idle', 'preparing', 'ready', 'restarting', 'error']),
  supported: z.boolean(),
  targetVersion: z.string().optional(),
  message: z.string().optional(),
});
export type ApplicationUpdateState = z.infer<typeof applicationUpdateStateSchema>;

/** The target and executable are always selected by the server. */
export const applicationUpdateInputSchema = z.record(z.string(), z.never());
export const applicationUpdateResponseSchema = z.object({ state: applicationUpdateStateSchema });
export type ApplicationUpdateResponse = z.infer<typeof applicationUpdateResponseSchema>;
