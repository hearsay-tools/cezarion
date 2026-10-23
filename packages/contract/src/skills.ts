import { z } from 'zod';

// ---- skills (`GET /skills`, `POST /skills/refresh`) ---------------------------------------

/**
 * One discovered skill: repo (`.ai/skills`, `.ai/cezar/skills`), `npx skills` install dirs
 * (project + global), or a configured team skills repo (spec 005).
 */
export const skillSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Advisory hint for untouched composer run-mode choices. */
  interactive: z.literal(true).optional(),
  body: z.string(),
  path: z.string(),
  /** `builtin`: shipped by cezar itself and listed last (#774), so a repo skill of the same name wins. */
  source: z.enum(['ai', 'cezar', 'agents', 'global', 'team', 'builtin']),
  /** Team skills only: where the definition lives in its skills repo. */
  team: z
    .object({
      repo: z.string(),
      ref: z.string(),
      path: z.string(),
      /** True for the `SKILL.md` convention — a whole directory (references/…). */
      dir: z.boolean(),
      /**
       * The exact commit `ref` resolved to when the skill was read (#428).
       *
       * The hand-written DTO omitted this field entirely — it was NARROWER than the route,
       * which has served it since #428.
       */
      commit: z.string().optional(),
    })
    .optional(),
});
export type Skill = z.infer<typeof skillSchema>;

/**
 * A skill offered by the default (vendor) repo, from `GET /skills/importable`, independent of
 * whether it is enabled. The full definition lets the Skills catalog preview it before enabling.
 */
export const importableSkillSchema = skillSchema;
export type ImportableSkill = z.infer<typeof importableSkillSchema>;
