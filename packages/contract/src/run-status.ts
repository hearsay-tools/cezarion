import { z } from 'zod';

/**
 * The lifecycle enums a run, a step, and a step kind can hold. This module imports only zod:
 * activity.ts and the testkit need the enums without the run record
 * (hearsay-tools/cezarion#3369). `runs.ts` re-exports the names.
 */
export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const stepStatusSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
  'skipped',
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const stepKindSchema = z.enum(['agent', 'check']);
export type StepKind = z.infer<typeof stepKindSchema>;
