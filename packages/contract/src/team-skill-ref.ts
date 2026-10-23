import { z } from 'zod';

/**
 * One team skill the project switched off, identified by its source repo and name so the same
 * name from another source stays on. Strict: an entry with a stray key is a bad write.
 */
export const teamSkillRefSchema = z
  .object({ repo: z.string().min(1).max(500), name: z.string().min(1).max(200) })
  .strict();
export type TeamSkillRef = z.infer<typeof teamSkillRefSchema>;
