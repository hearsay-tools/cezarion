import { z } from 'zod';
// `StartTodoResponse` embeds a whole run record, which belongs to the runs slice.
import { runRecordSchema } from './runs.ts';

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

// Defined in a leaf module so `workspace.ts` can use it without importing `runs.ts` (an import cycle).
export { teamSkillRefSchema, type TeamSkillRef } from './team-skill-ref.ts';

/**
 * A team skill from `GET /skills/importable`, whether or not the project switched it off. The
 * full definition lets the Skills catalog preview it before it is switched on.
 */
export const importableSkillSchema = skillSchema;
export type ImportableSkill = z.infer<typeof importableSkillSchema>;

// ---- follow-up inbox / todos (spec 007) ---------------------------------------------------

/** One entry of `.ai/cezar/todos.json`, as `GET /todos` serves it (ids are backfilled on read). */
export const todoItemSchema = z.object({
  id: z.string(),
  ts: z.string().optional(),
  taskId: z.string().optional(),
  summary: z.string().min(1),
  action: z.string().optional(),
  prUrl: z.string().optional(),
  suggestedSkill: z.string().optional(),
  suggestedArgs: z.string().optional(),
  suggestedPrompt: z.string().optional(),
  /** Explicit intent; missing infers from suggestedSkill/suggestedPrompt for old files. */
  runnable: z.boolean().optional(),
  /** Set once a task was started from this entry — it then leaves the inbox and stays as
   *  the audit trail. A later launch never overwrites the first. */
  startedTaskId: z.string().optional(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/**
 * `DELETE /todos/:id` — Dismiss checks the entry off.
 *
 * `removed` is the LITERAL `true`: a miss is a 404 `{ error }`, never `{ removed: false }`.
 * The hand-written DTO said `boolean`, which was wider than the route.
 */
export const removeTodoResponseSchema = z.object({
  removed: z.literal(true),
});
export type RemoveTodoResponse = z.infer<typeof removeTodoResponseSchema>;

/** `POST /todos/:id/start` — 201 with the run the entry became. */
export const startTodoResponseSchema = z.object({
  run: runRecordSchema,
});
export type StartTodoResponse = z.infer<typeof startTodoResponseSchema>;
