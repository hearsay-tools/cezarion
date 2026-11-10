import { z } from 'zod';

/**
 * `POST /api/v1/projects/:projectId/migration` (hearsay-tools/cezarion#3089): the CLI's
 * `migrate-project` asks the cockpit that owns the project to migrate it (or plan the migration)
 * itself. The route answers 404 until the P5 gate turns the command on.
 */
export const projectMigrationRequestSchema = z.object({ dryRun: z.boolean() }).strict();
export type ProjectMigrationRequest = z.infer<typeof projectMigrationRequestSchema>;

export const projectMigrationResponseSchema = z.object({
  dryRun: z.boolean(),
  /** Whether an unfinished migration journal was finished first. */
  resumed: z.boolean(),
  /** The plan as the CLI prints it (`describeProjectMigrationPlan`); empty when only a journal finished. */
  report: z.string(),
  /** `git mv` commands for the tracked files the migration leaves in place, for the user to run. */
  gitMv: z.array(z.string()),
});
export type ProjectMigrationResponse = z.infer<typeof projectMigrationResponseSchema>;

/** A task that keeps the project from being migrated (`ProjectMigrationBusyError`). */
export const projectMigrationLiveTaskSchema = z.object({ id: z.string(), title: z.string(), state: z.string() });

export const projectMigrationErrorSchema = z.object({
  error: z.string(),
  /** Present when live tasks refused the migration, or kept the drain from ending. */
  liveTasks: z.array(projectMigrationLiveTaskSchema).optional(),
});
export type ProjectMigrationError = z.infer<typeof projectMigrationErrorSchema>;
