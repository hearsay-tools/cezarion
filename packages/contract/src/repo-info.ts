import { z } from 'zod';

/**
 * Git facts about the project root, or `null` when it is not a repository. Health and the Repo
 * view serve the same record. This module imports only zod, so `repo.ts` does not load
 * `health.ts` (hearsay-tools/cezarion#3241); `health.ts` re-exports both names.
 */
export const repoInfoSchema = z.object({
  root: z.string(),
  branch: z.string(),
  remote: z.string().optional(),
});
export type RepoInfo = z.infer<typeof repoInfoSchema>;
