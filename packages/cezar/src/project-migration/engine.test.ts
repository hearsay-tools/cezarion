import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { readArtifact, artifactDirectory } from '../artifacts/store.ts';
import { verifyOwnedWorkspace } from '../delegation/workspace.ts';
import { removeOwnedWorkspace } from '../delegation/workspace-removal.ts';
import { REBRAND_SWITCH } from '../home/switch.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { RunStore } from '../runs/store.ts';
import { projectAdmissionRefusal } from '../server/cockpit-ownership.ts';
import { SUBCOMMAND_NAMES } from '../subcommands.ts';
import { migrateProject, ProjectMigrationRefusedError, resumeProjectMigration } from './engine.ts';
import { migrate, moved, rows, TIMEOUT } from './engine.testkit.ts';
import { describeProjectMigrationPlan, NOT_REWRITTEN, planProjectMigration } from './plan.ts';
import {
  buildMigrationProject, CHECKPOINTED, git, PARENT, projectSnapshot, removeMigrationProject, TASK, TRICKY, WORKER, type MigrationProject,
} from './project-migration.testkit.ts';

/**
 * The project state migration engine (hearsay-tools/cezarion#3088) on real Git repositories, the
 * project in a main and in a linked checkout, and a real run store: moves, worktree repair,
 * receipts, one run-store transaction, file-backed evidence, the dry run and its conflicts.
 * Crash recovery, the durability invariant and the holder's duties have their own files.
 */
/** A real cleanup checkpoint: the removal stops right after writing it, with the worktree in place. */
async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

describe.each([{ linked: false }, { linked: true }])('a project migration (linked checkout: $linked)', { timeout: TIMEOUT }, ({ linked }) => {
  let project: MigrationProject;
  beforeAll(async () => { project = await buildMigrationProject({ linked, checkpoint }); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  it('repairs worktrees, rewrites receipts, checkpoints, rows, artifacts and handoffs, and leaves tracked files and other projects alone', async () => {
    project.restore();
    const receiptDir = join(git(project.root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'cezar-owned-workspaces');
    const receiptsBefore = Object.fromEntries(readdirSync(receiptDir).map(name => [name, readFileSync(join(receiptDir, name), 'utf8')]));
    const trackedBefore = Object.fromEntries(git(project.root, 'ls-files', '-z', '--', '.ai/cezar').split('\0').filter(Boolean)
      .map(path => [path, readFileSync(join(project.root, path), 'utf8')]));
    const result = await migrate(project);

    // Git sees every moved worktree at its new path, from the main and from a linked project checkout.
    const listed = git(project.root, 'worktree', 'list', '--porcelain');
    for (const path of [project.taskPath, project.worker.path, project.checkpointed.path]) {
      expect(listed).toContain(`worktree ${moved(project, path)}\n`);
      expect(git(moved(project, path), 'rev-parse', '--show-toplevel')).toBe(moved(project, path));
    }
    // Receipts and the cleanup checkpoint: only workspace.path changed; another project's receipt is untouched.
    expect(Object.keys(receiptsBefore).some(name => name.endsWith('.cleanup.json'))).toBe(true);
    for (const [name, text] of Object.entries(receiptsBefore)) {
      const owner = JSON.parse(text).workspace.path as string;
      const after = readFileSync(join(receiptDir, name), 'utf8');
      expect(after).toBe(project.other?.path === owner ? text : text.replaceAll(owner, moved(project, owner)));
    }
    if (project.other) expect(listed).toContain(`worktree ${project.other.path}\n`);

    // The run store moved and every path field changed in one commit; unknown fields and prose stayed.
    const after = rows(join(project.newDir, RUNS_DB_FILE));
    const task = after.find(row => row.id === TASK)!;
    expect(task.worktreePath).toBe(moved(project, project.taskPath));
    expect(JSON.parse(task.summary).worktreePath).toBe(moved(project, project.taskPath));
    const data = JSON.parse(task.data);
    expect(data).toMatchObject({ futureField: { kept: true }, task: `Work in ${project.taskPath} and keep this prose`,
      workflowDef: { path: join(project.newDir, 'workflows/local.yaml') } });
    expect(data.lastWaits[0]).toMatchObject({ exitFile: join(project.newDir, 't', TASK.slice(0, 8), 'exit'), unknownWaitField: 1 });
    const worker = JSON.parse(after.find(row => row.id === WORKER)!.data);
    expect(worker.delegation.workspace.path).toBe(moved(project, project.worker.path));
    expect(worker.delegation.context.inputs[0].path).toBe(join(moved(project, project.worker.path), 'tracked.txt'));
    expect(new Set(after.filter(row => row.id !== PARENT).map(row => row.revision)).size).toBe(1);

    // A store opened on the project reads the moved rows, artifacts, handoffs and receipts, and the
    // emptied legacy directory neither shadows them nor gains a run store.
    const store = RunStore.open(REBRAND_SWITCH ? project.newDir : project.dataDir);
    try {
      expect(store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath));
      expect(store.sourceDataDir(TASK)).toBe(project.newDir);
      const artifact = await readArtifact(artifactDirectory(store.sourceDataDir(TASK), TASK), TASK, project.artifactId);
      expect(artifact?.bytes.toString()).toBe('<title>Report</title>report');
      expect(artifact?.metadata.sourcePath).toBe(join(moved(project, project.taskPath), 'report.html'));
      const handoff = readFileSync(join(project.newDir, 'runs', `${TASK}.handoff.md`), 'utf8');
      expect(handoff).toContain(`**Worktree:** ${moved(project, project.taskPath)}\n`);
      expect(handoff).toContain(`Prose naming ${project.taskPath} stays`);
      await expect(verifyOwnedWorkspace(project.root, store.getRun(WORKER)!)).resolves.toMatchObject({ path: moved(project, project.worker.path) });
      await expect(verifyOwnedWorkspace(project.root, store.getRun(CHECKPOINTED)!)).resolves.toMatchObject({ path: moved(project, project.checkpointed.path) });
    } finally { store.close(); }
    expect(existsSync(join(project.dataDir, RUNS_DB_FILE))).toBe(false);
    const cleanup = JSON.parse(readFileSync(join(receiptDir, `${project.checkpointed.resourceId}.cleanup.json`), 'utf8'));
    expect(cleanup.workspace).toEqual(JSON.parse(readFileSync(join(receiptDir, `${project.checkpointed.resourceId}.json`), 'utf8')).workspace);
    const runs = join(project.newDir, 'runs');
    expect(JSON.parse(readFileSync(join(runs, `${WORKER}.execution.json`), 'utf8')).scratchCleanup.path).toBe(moved(project, project.worker.path));
    expect(JSON.parse(readFileSync(join(runs, `${TASK}.autosave-cleanup.json`), 'utf8')).cwd).toBe(moved(project, project.taskPath));
    const results = join(runs, `${PARENT}-worker-results`);
    const resultFile = join(results, readdirSync(results)[0]!);
    const workerResult = JSON.parse(readFileSync(resultFile, 'utf8'));
    expect(workerResult).toMatchObject({ unknown: 'kept', result: { workspace: { path: moved(project, project.worker.path) }, diff: { path: resultFile } } });
    expect(workerResult.result.artifacts.items[0].path.startsWith(`${runs}/`)).toBe(true);

    // Tracked files stayed byte-identical in place; the legacy directory keeps only them and the claim.
    for (const [path, text] of Object.entries(trackedBefore)) expect(readFileSync(join(project.root, path), 'utf8')).toBe(text);
    expect(readdirSync(project.dataDir).filter(name => !name.startsWith('cockpit.lock')).sort()).toEqual(['context.yaml', 'skills', 'workflows']);
    expect(readdirSync(join(project.dataDir, 'workflows')).sort()).toEqual(['flow.yaml', TRICKY].sort());
    expect(existsSync(join(project.newDir, 'workflows/local.yaml'))).toBe(true);
    expect(result.resumed).toBe(false);
    expect(existsSync(join(project.root, '.ai/squawk-migration.json'))).toBe(false);
    expect(projectAdmissionRefusal(project.dataDir)).toBeUndefined();

    // The printed commands move the tracked files with Git; nothing in a file name runs.
    execFileSync('sh', ['-ec', result.gitMv.join('\n')]);
    expect(git(project.root, 'status', '--porcelain')).toMatch(/^R {2}\.ai\/cezar\/context\.yaml -> \.ai\/squawk\/context\.yaml$/m);
    expect(existsSync(join(project.newDir, 'workflows', TRICKY))).toBe(true);
    expect(readFileSync(join(project.newDir, 'skills/review/SKILL.md'), 'utf8')).toBe('# Review\n');
    expect(existsSync(join(project.root, 'pwned')) || existsSync(join(project.root, 'pwned2'))).toBe(false);
  });

  it('a dry run lists every move and rewrite, changes nothing, and reports destination conflicts', async () => {
    project.restore();
    const untouched = projectSnapshot(project, { databaseBytes: true });
    const plan = await planProjectMigration(project.root);
    expect(projectSnapshot(project, { databaseBytes: true })).toEqual(untouched);
    expect(plan.blockers).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.moves.map(move => relative(project.root, move.from)).sort()).toEqual(['.ai/cezar/.gitignore', '.ai/cezar/runs', '.ai/cezar/runs.db',
      '.ai/cezar/skills/review/local.txt', '.ai/cezar/workflows/local.yaml', '.ai/cezar/worktrees'].sort());
    expect(plan.worktrees.map(item => item.to).sort()).toEqual([project.taskPath, project.worker.path, project.checkpointed.path].map(path => moved(project, path)).sort());
    expect([...new Set(plan.rewrites.map(rewrite => rewrite.kind))].sort()).toEqual(['artifact-metadata', 'autosave-cleanup', 'cleanup-checkpoint',
      'handoff', 'receipt', 'run-row', 'worker-execution', 'worker-result']);
    expect(plan.tracked.map(file => file.from).sort()).toEqual(['.ai/cezar/context.yaml', '.ai/cezar/skills/review/SKILL.md',
      '.ai/cezar/workflows/flow.yaml', `.ai/cezar/workflows/${TRICKY}`].sort());
    const text = describeProjectMigrationPlan(plan);
    for (const line of [...plan.moves.map(move => move.from), ...plan.rewrites.map(rewrite => rewrite.from), ...plan.gitMv, ...NOT_REWRITTEN]) expect(text).toContain(line);

    // Items already under .ai/squawk are conflicts; a real migration refuses and writes nothing.
    mkdirSync(join(project.newDir, 'runs'), { recursive: true });
    // As private as their source directories, so only the two items conflict.
    for (const path of ['', 'runs']) chmodSync(join(project.newDir, path), statSync(join(project.dataDir, path)).mode & 0o777);
    writeFileSync(join(project.newDir, RUNS_DB_FILE), 'not a run store');
    writeFileSync(join(project.newDir, 'runs', `${TASK}.handoff.md`), 'another handoff');
    const blocked = projectSnapshot(project, { databaseBytes: true });
    const conflicted = await planProjectMigration(project.root);
    expect(conflicted.conflicts.map(conflict => conflict.path).sort()).toEqual([join(project.newDir, RUNS_DB_FILE),
      join(project.newDir, 'runs', `${TASK}.handoff.md`)].sort());
    await expect(migrate(project)).rejects.toBeInstanceOf(ProjectMigrationRefusedError);
    expect(projectSnapshot(project, { databaseBytes: true })).toEqual(blocked);
    expect(projectAdmissionRefusal(project.dataDir)).toBeUndefined();
  });
});


describe('without a release', () => {
  it('registers migration only behind the release switch, and refuses to run without the fence held by this process', async () => {
    for (const name of ['migrate', 'server-migrate', 'migrate-project']) {
      expect(SUBCOMMAND_NAMES.includes(name)).toBe(REBRAND_SWITCH);
    }
    const src = join(import.meta.dirname, '..');
    const sources = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter(path => path.endsWith('.ts') && !/\.(?:test|testkit)\.ts$/.test(path) && !path.startsWith('project-migration'))
      .map(path => ({ path, text: readFileSync(join(src, path), 'utf8') }));
    // P4b3 (hearsay-tools/cezarion#3089): early recovery at each entry, and the switch-gated starts.
    expect(sources.filter(({ text }) => /project-migration\//.test(text)).map(({ path }) => path).sort()).toEqual([
      'artifacts/cli.ts', 'cli-dispatch.ts', 'project-commands.ts', 'serve-command.ts', 'server/project-context.ts',
      'server/server.ts', 'server/start-server.ts', 'server/workspace-projects.ts', 'subcommands.ts']);
    // The command, and the cockpit's prepare step (recovery, then the automatic move), each move behind the release switch.
    expect(sources.filter(({ text }) => /\bmigrateProject(?:Offline)?\(|\bmoveProjectWhenIdle\(|\bprepare(?:Project|Projects|BeforeTicks)\(|project-migration\/cli\.ts/.test(text))
      .map(({ path }) => path).sort()).toEqual(['serve-command.ts', 'server/project-context.ts', 'server/server.ts', 'server/start-server.ts', 'subcommands.ts']);
    const root = join(import.meta.dirname, 'nowhere');
    const unheld = { lock: join(root, '.ai/squawk-migration.lock'), journal: join(root, '.ai/squawk-migration.json'), release: () => undefined };
    await expect(migrateProject({ repoRoot: root, fence: unheld })).rejects.toThrow(/needs the project's migration fence/);
    await expect(resumeProjectMigration({ repoRoot: root, fence: unheld })).rejects.toThrow(/needs the project's migration fence/);
  });
});
