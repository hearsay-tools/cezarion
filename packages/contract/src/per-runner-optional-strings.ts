import { z } from 'zod';

/** Optional string values keyed by the six runners, each independently optional. */
export function perRunnerOptionalStrings() {
  return z.object({
    claude: z.string().optional(),
    codex: z.string().optional(),
    opencode: z.string().optional(),
    pi: z.string().optional(),
    cursor: z.string().optional(),
    omp: z.string().optional(),
  });
}
