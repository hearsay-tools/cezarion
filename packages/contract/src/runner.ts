import { z } from 'zod';

/**
 * The agent backends a run can be dispatched to. This module imports only zod: most contract
 * modules import the roster, and a schema module behind it would load in nearly every test
 * (hearsay-tools/cezarion#3241). `health.ts` re-exports both names.
 */
export const runnerSchema = z.enum(['claude', 'codex', 'opencode', 'pi', 'cursor', 'omp']);
export type Runner = z.infer<typeof runnerSchema>;
