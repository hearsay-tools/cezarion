import { z } from 'zod';
import { runStatusSchema } from './runs.ts';

export const REPORTS_QUERY_MAX = 1000;
const cursorSchema = z.string().min(1).max(1024);

export const reportsQuerySchema = z.object({
  q: z.string().max(REPORTS_QUERY_MAX).optional(),
  before: cursorSchema.optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number).optional(),
}).strict();
export const reportSchema = z.object({
  id: z.uuid(), runId: z.uuid(), name: z.string(), title: z.string(),
  createdAt: z.iso.datetime(), size: z.number().int().nonnegative(),
  taskTitle: z.string(), taskStatus: runStatusSchema,
}).strict();
export const reportsResponseSchema = z.object({
  reports: z.array(reportSchema), nextCursor: cursorSchema.nullable(),
  // Counts all matching cached rows with readable source summaries before page content checks.
  // A missing-content row dropped while filling this page can lower total on the next request.
  total: z.number().int().nonnegative(),
}).strict();
export type Report = z.infer<typeof reportSchema>;
export type ReportsResponse = z.infer<typeof reportsResponseSchema>;
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;
