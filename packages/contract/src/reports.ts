import { z } from 'zod';
import { runStatusSchema } from './runs.ts';

export const reportsQuerySchema = z.object({
  q: z.string().max(1000).optional(),
  before: z.string().min(1).max(1024).optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number).optional(),
}).strict();
export const reportSchema = z.object({
  id: z.uuid(), runId: z.uuid(), name: z.string(), title: z.string(),
  createdAt: z.iso.datetime(), size: z.number().int().nonnegative(),
  taskTitle: z.string(), taskStatus: runStatusSchema,
}).strict();
export const reportsResponseSchema = z.object({
  reports: z.array(reportSchema), nextCursor: z.string().nullable(), total: z.number().int().nonnegative(),
}).strict();
export type Report = z.infer<typeof reportSchema>;
export type ReportsResponse = z.infer<typeof reportsResponseSchema>;
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;
