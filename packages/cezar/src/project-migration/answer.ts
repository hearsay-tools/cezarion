import type { ProjectMigrationResponse } from '@open-mercato/cezar-contract/project-migration';
import type { ProjectMigrationResult } from './engine.ts';
import { describeProjectMigrationPlan, gitMvCommands, NOT_REWRITTEN, planProjectMigration } from './plan.ts';

/** The answer of `migrate-project`, the same from the CLI and from the owning cockpit's route. */

/** A dry run: the engine's whole plan, nothing moved or rewritten. */
export async function dryRunAnswer(repoRoot: string, resumed: boolean): Promise<ProjectMigrationResponse> {
  const plan = await planProjectMigration(repoRoot);
  return { dryRun: true, resumed, report: describeProjectMigrationPlan(plan), gitMv: plan.gitMv };
}

/** A finished migration (its journal removed): what it moved, repaired and rewrote. */
export function migrationAnswer(result: ProjectMigrationResult): ProjectMigrationResponse {
  const { journal } = result;
  const report = describeProjectMigrationPlan({
    ...journal, journal: '', conflicts: [], blockers: [], gitMv: gitMvCommands(journal.repoRoot, journal.tracked), notRewritten: NOT_REWRITTEN,
  });
  return { dryRun: false, resumed: result.resumed, report, gitMv: result.gitMv };
}

/** The answer as the CLI prints it: the report, then what happened. */
export function migrationAnswerText(answer: ProjectMigrationResponse): string {
  const lines = [answer.report];
  if (answer.resumed) lines.push('An unfinished migration was finished first.');
  if (answer.dryRun) lines.push('Dry run: nothing was moved or rewritten.');
  else lines.push(`Migration complete.${answer.gitMv.length ? ' Run the git mv commands above and commit them.' : ''}`);
  return lines.join('\n');
}
