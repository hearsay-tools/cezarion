import type { ProjectMigrationResult } from './engine.ts';
import { describeProjectMigrationPlan, gitMvCommands, NOT_REWRITTEN, planProjectMigration } from './plan.ts';

/** What `migrate-project` reports. */
export interface ProjectMigrationAnswer {
  dryRun: boolean;
  /** Whether an unfinished migration journal was finished first. */
  resumed: boolean;
  /** The plan as printed (`describeProjectMigrationPlan`). */
  report: string;
  /** `git mv` commands for the tracked files the migration leaves in place, for the user to run. */
  gitMv: string[];
}

/** A dry run: the engine's whole plan, nothing moved or rewritten. */
export async function dryRunAnswer(repoRoot: string, resumed: boolean): Promise<ProjectMigrationAnswer> {
  const plan = await planProjectMigration(repoRoot);
  return { dryRun: true, resumed, report: describeProjectMigrationPlan(plan), gitMv: plan.gitMv };
}

/** A finished migration (its journal removed): what it moved, repaired and rewrote. */
export function migrationAnswer(result: ProjectMigrationResult): ProjectMigrationAnswer {
  const { journal } = result;
  const report = describeProjectMigrationPlan({
    ...journal, journal: '', conflicts: [], blockers: [], gitMv: gitMvCommands(journal.repoRoot, journal.tracked), notRewritten: NOT_REWRITTEN,
  });
  return { dryRun: false, resumed: result.resumed, report, gitMv: result.gitMv };
}

/** The answer as the CLI prints it: the report, then what happened. */
export function migrationAnswerText(answer: ProjectMigrationAnswer): string {
  const lines = [answer.report];
  if (answer.resumed) lines.push('An unfinished migration was finished first.');
  if (answer.dryRun) lines.push('Dry run: nothing was moved or rewritten.');
  else lines.push(`Migration complete.${answer.gitMv.length ? ' Run the git mv commands above and commit them.' : ''}`);
  return lines.join('\n');
}
