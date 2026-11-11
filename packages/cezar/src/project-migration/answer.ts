import type { ProjectMigrationResult } from './engine.ts';
import { projectKeptRunIds } from './live.ts';
import { describeProjectMigrationPlan, gitMvCommands, NOT_REWRITTEN, planProjectMigration } from './plan.ts';

/** What `migrate-project` reports. */
export interface ProjectMigrationAnswer {
  dryRun: boolean;
  /** Whether the plan has blockers or conflicts. */
  blocked: boolean;
  /** Whether an unfinished migration journal was finished first. */
  resumed: boolean;
  /** What a journal finished first moved and rewrote, when one was; a dry run reports it too. */
  recovered?: string;
  /** The plan as printed (`describeProjectMigrationPlan`). */
  report: string;
  /** `git mv` commands for the tracked files the migration leaves in place, for the user to run. */
  gitMv: string[];
  /** The project was already moved: nothing changed. */
  alreadyMoved: boolean;
  /** The unarchived tasks whose own items stay in `.ai/cezar/` until they are archived. */
  leftovers: string[];
}

/** A finished journal as the plan text: what it moved, repaired and rewrote. */
function journalReport(result: ProjectMigrationResult): string {
  const { journal } = result;
  return describeProjectMigrationPlan({
    ...journal, journal: '', conflicts: [], blockers: [], gitMv: gitMvCommands(journal.repoRoot, journal.tracked), notRewritten: NOT_REWRITTEN,
    alreadyMoved: result.alreadyMoved, leftovers: journal.leftovers ?? [],
  });
}

/** A dry run: the engine's whole plan, after any unfinished journal it had to finish first. */
export async function dryRunAnswer(repoRoot: string, recovered: ProjectMigrationResult | undefined): Promise<ProjectMigrationAnswer> {
  const plan = await planProjectMigration(repoRoot, { keep: projectKeptRunIds(repoRoot) });
  return { dryRun: true, blocked: plan.blockers.length > 0 || plan.conflicts.length > 0, resumed: recovered !== undefined, ...(recovered ? { recovered: journalReport(recovered) } : {}),
    report: describeProjectMigrationPlan(plan), gitMv: plan.gitMv, alreadyMoved: plan.alreadyMoved, leftovers: plan.leftovers };
}

/** A finished migration (its journal removed): what it moved, repaired and rewrote. */
export function migrationAnswer(result: ProjectMigrationResult): ProjectMigrationAnswer {
  return { dryRun: false, blocked: false, resumed: result.resumed, report: journalReport(result), gitMv: result.gitMv, alreadyMoved: result.alreadyMoved,
    leftovers: result.journal.leftovers ?? [] };
}

/** The answer as the CLI prints it: what a finished journal did, the report, then what happened. */
export function migrationAnswerText(answer: ProjectMigrationAnswer): string {
  const lines = answer.recovered
    ? ['An interrupted migration was found and completed first. It did this:', answer.recovered, 'The dry run of what remains:']
    : [];
  lines.push(answer.report);
  if (answer.resumed && !answer.recovered) lines.push('An unfinished migration was finished first.');
  const next = answer.gitMv.length ? ' Run the git mv commands above and commit them.' : '';
  if (answer.alreadyMoved && !answer.dryRun) lines.push(`The project was already moved; nothing changed.${next}`);
  else if (answer.dryRun) lines.push(answer.recovered ? 'Dry run: planning changed nothing; the completed migration above did.' : 'Dry run: nothing was moved or rewritten.');
  else lines.push(`Migration complete.${answer.leftovers.length ? ` The tasks listed above keep their files in .ai/cezar/; a later migration moves them once they are archived.` : ''}${next}`);
  return lines.join('\n');
}
