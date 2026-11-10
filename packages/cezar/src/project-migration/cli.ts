import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { projectMigrationErrorSchema, projectMigrationResponseSchema, type ProjectMigrationResponse } from '@open-mercato/cezar-contract/project-migration';
import { projectsResponseSchema } from '@open-mercato/cezar-contract/projects';
import { commandText } from '../home/command.ts';
import { projectPaths } from '../project-paths.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { RunStore } from '../runs/store.ts';
import { anotherCockpitOwner, assertProjectAdmitted, CockpitOwnership } from '../server/cockpit-ownership.ts';
import { getRepoInfo } from '../server/git.ts';
import { projectLiveTasks } from '../server/project-context.ts';
import { dryRunAnswer, migrationAnswer, migrationAnswerText } from './answer.ts';
import { migrateProject } from './engine.ts';
import { recoverProjectMigration } from './recovery.ts';
import type { MigrationFault } from './steps.ts';

/**
 * `migrate-project [--dry-run]` (hearsay-tools/cezarion#3089), registered only behind the P5 gate
 * (`PROJECT_MIGRATION_SWITCH`). A cockpit that owns the project migrates it itself: the CLI asks
 * it over HTTP and touches no project file. With no owner the CLI takes the project's
 * `cockpit.lock` and its migration fence (P4b1) itself, so no cockpit starts on the project
 * meanwhile, and runs the engine (P4b2). Either way an unfinished journal finishes first.
 */

const HELP = commandText(`Usage: cez migrate-project [--dry-run] [--repo <dir>]
Move this project's runtime state from .ai/cezar/ to .ai/squawk/. The cockpit that
serves the project runs the migration itself; with no cockpit, this command locks
the project. Every live task must be finished or cancelled first. Tracked files
are never moved: the command prints the git mv commands to run and commit.

    --dry-run     print every move, repair and rewrite; change nothing
    --repo <dir>  the project (default: the current directory)
-h, --help        show this help`);

export interface MigrateProjectDeps {
  fetch: typeof fetch;
  /** The live cockpit that owns the project, other than this process. */
  owner: typeof anotherCockpitOwner;
  /** Test seam: the engine's fault points (`MigrationFault`). */
  fault?: MigrationFault;
  getRepoInfo: typeof getRepoInfo;
  cwd: () => string;
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultDeps: MigrateProjectDeps = {
  fetch: (...args) => fetch(...args), owner: anotherCockpitOwner, getRepoInfo, cwd: () => process.cwd(), log: line => console.log(line), error: line => console.error(line),
};

export async function runMigrateProjectCommand(argv: string[], _env: NodeJS.ProcessEnv, deps: MigrateProjectDeps = defaultDeps): Promise<number> {
  let values: { 'dry-run'?: boolean; repo?: string; help?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' }, repo: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }));
  } catch (error) {
    deps.error(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 1;
  }
  if (values.help) { deps.log(HELP); return 0; }
  const cwd = resolve(values.repo ?? deps.cwd());
  const root = realpathSync((await deps.getRepoInfo(cwd))?.root ?? cwd);
  const dryRun = values['dry-run'] === true;
  try {
    const owner = deps.owner(projectPaths(root).write);
    const answer = owner ? await askOwner(root, owner, dryRun, deps) : await migrateWithoutOwner(root, dryRun, deps.fault);
    deps.log(migrationAnswerText(answer));
    return 0;
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** The owning cockpit migrates: find the project's id in its registry, then ask its route. */
async function askOwner(root: string, owner: { pid: number; url?: string }, dryRun: boolean, deps: MigrateProjectDeps): Promise<ProjectMigrationResponse> {
  if (!owner.url) throw new Error(`A cockpit (pid ${owner.pid}) owns ${root} and is still starting; retry shortly`);
  const listed = await deps.fetch(new URL('/api/v1/projects', owner.url));
  if (!listed.ok) throw new Error(`The cockpit at ${owner.url} did not list its projects (HTTP ${listed.status})`);
  const project = projectsResponseSchema.parse(await listed.json()).projects.find(entry => entry.root === root);
  if (!project) throw new Error(`The cockpit at ${owner.url} owns ${root} but does not list it; open the project there, then retry`);
  const response = await deps.fetch(new URL(`/api/v1/projects/${encodeURIComponent(project.id)}/migration`, owner.url), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) return projectMigrationResponseSchema.parse(body);
  const failure = projectMigrationErrorSchema.safeParse(body);
  throw new Error(failure.success ? failure.data.error : `The cockpit at ${owner.url} answered HTTP ${response.status}`);
}

/** No cockpit owns the project: this process takes `cockpit.lock` and the fence, then releases both. */
async function migrateWithoutOwner(root: string, dryRun: boolean, fault: MigrationFault | undefined): Promise<ProjectMigrationResponse> {
  const dataDir = projectPaths(root).write;
  const ownership = new CockpitOwnership();
  let store: RunStore | undefined;
  try {
    const recovered = await recoverProjectMigration(root, { ownership, keep: true });
    assertProjectAdmitted(dataDir);
    if (dryRun) return await dryRunAnswer(root, recovered !== undefined);
    // The unfinished migration was this migration: it is complete now.
    if (recovered) return migrationAnswer(recovered);
    const fence = await ownership.fenceProject(dataDir, {
      liveTasks: () => { store ??= openRunStore(root); return store ? projectLiveTasks(store) : []; },
      inFlight: () => 0,
    });
    try {
      const result = await migrateProject({ repoRoot: root, fence, closeProject: () => { store?.close(); store = undefined; }, ...(fault ? { fault } : {}) });
      return migrationAnswer(result);
    } finally { fence.release(); }
  } finally {
    store?.close();
    ownership.releaseAll();
  }
}

/** The project's run store, opened for reading only its live tasks; none when it has no runs. */
function openRunStore(root: string): RunStore | undefined {
  if (!projectPaths(root).reads.some(directory => existsSync(join(directory, RUNS_DB_FILE)) || existsSync(join(directory, 'runs.json')))) return undefined;
  return RunStore.open(projectPaths(root).write, { keepLive: true, maintenance: true });
}
