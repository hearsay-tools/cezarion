import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { readArtifact, artifactDirectory } from '../artifacts/store.ts';
import { createRunner } from '../core/runner-factory.ts';
import { removeOwnedWorkspace, verifyOwnedWorkspace } from '../delegation/workspace.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { REBRAND_SWITCH } from '../home/switch.ts';
import { RUNS_DB_FILE, RunDatabase } from '../runs/run-database.ts';
import { RunStore } from '../runs/store.ts';
import { CockpitOwnership, ProjectMigrationFencedError, projectAdmissionRefusal, type ProjectMigrationFence } from '../server/cockpit-ownership.ts';
import { fenceProjectContext, ProjectContexts } from '../server/project-context.ts';
import { SUBCOMMAND_NAMES } from '../subcommands.ts';
import { migrateProject, ProjectMigrationRefusedError, resumeProjectMigration } from './engine.ts';
import { directoriesDown, durable } from './durable.ts';
import { readProjectMigrationJournal, type ProjectMigrationJournal } from './journal.ts';
import { ProjectMigrationStepError } from './steps.ts';
import { describeProjectMigrationPlan, NOT_REWRITTEN, planProjectMigration } from './plan.ts';
import {
  buildMigrationProject, CHECKPOINTED, git, PARENT, projectSnapshot, removeMigrationProject, TASK, TRICKY, WORKER, type MigrationProject,
} from './project-migration.testkit.ts';

/**
 * The project state migration engine (hearsay-tools/cezarion#3088) on real Git repositories and a
 * real run store: moves, worktree repair, receipts, one run-store transaction, file-backed
 * evidence, crash recovery at every step boundary, the dry run and the journal's admission block.
 */

// bound: each case restores a real repository and runs Git, a worktree-lock keeper and SQLite.
const TIMEOUT = 300_000;
const none = { liveTasks: () => [], inFlight: () => 0 };
const owners: CockpitOwnership[] = [];
const disposers: Array<() => void> = [];

/** A real cleanup checkpoint: the removal stops right after writing it, with the worktree in place. */
async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

function build(linked: boolean): Promise<MigrationProject> {
  return buildMigrationProject({ linked, checkpoint });
}

/** A fence of a CLI that no cockpit serves; its release lets go of the ownership claim too, as the
 *  CLI's exit (or death) would. */
async function fence(project: MigrationProject): Promise<ProjectMigrationFence> {
  const ownership = new CockpitOwnership();
  owners.push(ownership);
  const held = await ownership.fenceProject(project.dataDir, none);
  return { ...held, release: () => ownership.releaseAll() };
}

/** A whole migration under a fence, released after, as P4b3's caller will do. */
async function migrate(project: MigrationProject, fault?: (point: string) => void) {
  const held = await fence(project);
  try { return await migrateProject({ repoRoot: project.root, fence: held, ...(fault ? { fault } : {}) }); }
  finally { held.release(); }
}

/** A process death at a fault point. The test then releases the fence, as the death would let a
 *  later claim reclaim it. */
class Crash extends Error {}
const crashAt = (point: string) => (at: string) => { if (at === point) throw new Crash(point); };

/** The durability invariant (durable.ts) checked on a recorded run: every fault point is an action
 *  that depends on the effects before it, so the syncs each effect needs must appear after the
 *  previous fault point and before it. A resumed run is checked the same way: items it finds
 *  applied still need their syncs. */
function assertDurableOrder(events: readonly string[], journal: ProjectMigrationJournal, label: string): void {
  const root = dirname(journal.destination);
  const chain = (path: string) => directoriesDown(root, path).map(directory => `dir:${directory}`);
  const admin = (worktree: string) => resolve(worktree, readFileSync(join(worktree, '.git'), 'utf8').replace(/^gitdir: /, '').trim());
  const files = (kinds: readonly string[]) => [...new Set(journal.rewrites.flatMap(rewrite => 'file' in rewrite && kinds.includes(rewrite.kind) ? [rewrite.file] : []))];
  const receipts = files(['receipt', 'cleanup-checkpoint']);
  const evidence = files(['worker-execution', 'autosave-cleanup', 'worker-result', 'artifact-metadata', 'handoff']);
  const required = (point: string): string[] => {
    const [step, kind, at] = point.split(':');
    const index = Number(at);
    if (step === 'move' && kind === 'item') return [...chain(dirname(journal.moves[index]!.to)), ...chain(dirname(journal.moves[index]!.from))];
    if (step === 'lock-worktrees' && kind === 'item') return [`dir:${admin(journal.worktrees[index]!.to)}`];
    if (step === 'repair-worktrees' && kind === 'unlock') {
      const worktree = journal.worktrees[index]!.to;
      return [`file:${join(worktree, '.git')}`, `dir:${worktree}`, `file:${join(admin(worktree), 'gitdir')}`, `dir:${admin(worktree)}`];
    }
    if (step === 'repair-worktrees' && kind === 'item') return [`dir:${admin(journal.worktrees[index]!.to)}`];
    if (step === 'receipts' && kind === 'item') return [`file:${receipts[index]!}`, `dir:${dirname(receipts[index]!)}`];
    if (step === 'run-files' && kind === 'item') return [`file:${evidence[index]!}`, ...chain(dirname(evidence[index]!))];
    if (point === 'run-store:after' && journal.rewrites.some(rewrite => rewrite.kind === 'run-row')) return [`file:${join(journal.destination, RUNS_DB_FILE)}`, ...chain(journal.destination)];
    if (kind === 'marked' || point === 'journal:written') return [`file:${join(root, 'squawk-migration.json')}`, `dir:${root}`];
    return [];
  };
  let window: string[] = [];
  for (const event of events) {
    if (event.startsWith('dir:') || event.startsWith('file:')) { window.push(event); continue; }
    for (const sync of required(event)) expect(window, `${label}: ${event} needs ${sync}`).toContain(sync);
    window = [];
  }
  expect(window, `${label}: the journal removal`).toContain(`dir:${root}`);
}

/** Run `work` recording each durable call and each fault point, in order. */
async function recording(work: (fault: (point: string) => void) => Promise<unknown>): Promise<string[]> {
  const events: string[] = [];
  const directory = vi.spyOn(durable, 'directory').mockImplementation((path) => { events.push(`dir:${path}`); });
  const file = vi.spyOn(durable, 'file').mockImplementation((path) => { events.push(`file:${path}`); });
  try { await work(point => { events.push(point); }); } finally { directory.mockRestore(); file.mockRestore(); }
  return events;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const ownership of owners.splice(0)) ownership.releaseAll();
});

function rows(path: string) {
  const db = RunDatabase.openReadOnly(path)!;
  try { return db.listAll().map(({ id, revision, worktreePath, data, summary }) => ({ id, revision, worktreePath, data, summary })); }
  finally { db.close(); }
}

const moved = (project: MigrationProject, path: string) => path.replace(project.dataDir, project.newDir);

describe.each([{ linked: false }, { linked: true }])('a project migration (linked checkout: $linked)', { timeout: TIMEOUT }, ({ linked }) => {
  let project: MigrationProject;
  beforeAll(async () => { project = await build(linked); }, TIMEOUT);
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
    const store = RunStore.open(project.dataDir);
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

describe('crash recovery', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  let reference: Record<string, string>;
  const points: string[] = [];
  beforeAll(async () => {
    project = await build(false);
    await migrate(project, point => { points.push(point); });
    reference = projectSnapshot(project);
  }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  it('offers a fault point before and after every step effect and mark', () => {
    for (const step of ['move', 'repair-worktrees', 'receipts', 'run-store', 'run-files']) {
      expect(points).toEqual(expect.arrayContaining([`${step}:before`, `${step}:after`, `${step}:marked`]));
    }
    expect(points).toEqual(expect.arrayContaining(['journal:before', 'journal:written', 'lock-worktrees:item:0', 'move:prepared:0', 'move:renamed:0', 'move:item:0',
      'repair-worktrees:unlock:0', 'repair-worktrees:item:0', 'receipts:item:0', 'run-store:commit', 'run-files:item:0']));
  });

  it('completes the same result with no duplicate rewrite after a crash at any fault point', async () => {
    for (const point of points) {
      project.restore();
      const crashed = await fence(project);
      await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt(point) }), point).rejects.toThrow(point);
      crashed.release();
      // The journal blocks every ordinary reader until the recovery completes under a fence.
      expect(projectAdmissionRefusal(project.dataDir)?.reason, point).toBe(point === 'journal:before' ? undefined : 'journal');
      const recovery = await fence(project);
      try {
        const resumed = await resumeProjectMigration({ repoRoot: project.root, fence: recovery });
        expect(resumed?.resumed, point).toBe(point === 'journal:before' ? undefined : true);
        if (!resumed) await migrateProject({ repoRoot: project.root, fence: recovery });
      } finally { recovery.release(); }
      // Same files, Git metadata, receipts, rows, revisions and commit sequence: no rewrite ran twice.
      expect(projectSnapshot(project), point).toEqual(reference);
    }
  });

  it('keeps every moved worktree registered when another checkout prunes between the move and the repair', async () => {
    for (const point of ['move:item:0', 'move:after', 'move:marked']) {
      project.restore();
      const crashed = await fence(project);
      await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt(point) }), point).rejects.toThrow(point);
      crashed.release();
      // Git's own prune, as any checkout sharing this Git directory runs it: it ignores cezar's receipts.
      git(project.repo, 'worktree', 'prune');
      const recovery = await fence(project);
      try { await resumeProjectMigration({ repoRoot: project.root, fence: recovery }); } finally { recovery.release(); }
      expect(projectSnapshot(project), point).toEqual(reference);
      expect(git(project.root, 'worktree', 'list', '--porcelain')).not.toMatch(/^locked/m);
    }
  });

  it('settles every effect before each action that depends on it, on the first run and on a resume from every fault point', async () => {
    project.restore();
    let journal: ProjectMigrationJournal | undefined;
    const first = await recording(async fault => { journal = (await migrate(project, fault)).journal; });
    assertDurableOrder(first, journal!, 'first run');
    for (const point of points) {
      project.restore();
      const crashed = await fence(project);
      await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt(point) }), point).rejects.toThrow(point);
      crashed.release();
      const saved = readProjectMigrationJournal(join(project.root, '.ai/squawk-migration.json'));
      if (!saved) continue;
      const recovery = await fence(project);
      try {
        const resumed = await recording(fault => resumeProjectMigration({ repoRoot: project.root, fence: recovery, fault }));
        assertDurableOrder(resumed, saved, `resume after ${point}`);
      } finally { recovery.release(); }
    }
  });

  it('rolls back every row when the one run-store transaction fails, and a resume finishes it', async () => {
    project.restore();
    const original = rows(join(project.dataDir, RUNS_DB_FILE));
    const held = await fence(project);
    await expect(migrateProject({ repoRoot: project.root, fence: held, fault: crashAt('run-store:commit') })).rejects.toThrow('run-store:commit');
    held.release();
    expect(rows(join(project.newDir, RUNS_DB_FILE))).toEqual(original);
    expect(readProjectMigrationJournal(join(project.root, '.ai/squawk-migration.json'))?.done).toEqual(['lock-worktrees', 'move', 'repair-worktrees', 'receipts']);
    const recovery = await fence(project);
    try { await resumeProjectMigration({ repoRoot: project.root, fence: recovery }); } finally { recovery.release(); }
    expect(projectSnapshot(project)).toEqual(reference);
  });

  it('keeps ordinary project reads out while a journal is unfinished, and admits them after recovery', async () => {
    project.restore();
    const crashed = await fence(project);
    await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt('receipts:after') })).rejects.toThrow(Crash);
    crashed.release();
    const ownership = new CockpitOwnership();
    owners.push(ownership);
    const contexts = new ProjectContexts({ createRunner, home: testHome(), ownership,
      listProjects: async () => [{ id: 'p', root: project.root, status: 'not-git' as const }] });
    disposers.push(() => contexts.disposeAll());
    await expect(contexts.context('p')).rejects.toBeInstanceOf(ProjectMigrationFencedError);
    await expect(ownership.acquire(project.newDir)).rejects.toBeInstanceOf(ProjectMigrationFencedError);
    expect(projectAdmissionRefusal(project.newDir)?.reason).toBe('journal');
    const recovery = await fence(project);
    try { await resumeProjectMigration({ repoRoot: project.root, fence: recovery }); } finally { recovery.release(); }
    const context = await contexts.context('p');
    await context.store.reports.idle();
    expect(context.store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath));
    expect(existsSync(join(project.dataDir, RUNS_DB_FILE))).toBe(false);
  });
});

describe('the holder', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  beforeAll(async () => { project = await build(false); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  it('stops with the journal in place when an item holds neither its old nor its new value', async () => {
    project.restore();
    const crashed = await fence(project);
    await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt('receipts:before') })).rejects.toThrow(Crash);
    crashed.release();
    const receipt = join(git(project.root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'cezar-owned-workspaces', `${project.worker.resourceId}.json`);
    const text = readFileSync(receipt, 'utf8');
    writeFileSync(receipt, text.replace(project.worker.path, '/somewhere/else'));
    const recovery = await fence(project);
    try {
      await expect(resumeProjectMigration({ repoRoot: project.root, fence: recovery })).rejects.toBeInstanceOf(ProjectMigrationStepError);
    } finally { recovery.release(); }
    expect(readProjectMigrationJournal(join(project.root, '.ai/squawk-migration.json'))?.done).toEqual(['lock-worktrees', 'move', 'repair-worktrees']);
    expect(projectAdmissionRefusal(project.dataDir)?.reason).toBe('journal');
  });

  it('refuses a symlink that appears on a destination path between the plan and the move', async () => {
    project.restore();
    const outside = join(project.base, 'outside');
    mkdirSync(outside, { recursive: true });
    const held = await fence(project);
    const plant = (at: string) => { if (at === 'move:before') { mkdirSync(project.newDir, { recursive: true }); symlinkSync(outside, join(project.newDir, 'workflows')); } };
    try {
      await expect(migrateProject({ repoRoot: project.root, fence: held, fault: plant })).rejects.toThrow(/workflows is not a directory of this project/);
    } finally { held.release(); }
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(project.dataDir, 'workflows/local.yaml'))).toBe(true);
    expect(projectAdmissionRefusal(project.dataDir)?.reason).toBe('journal');
  });

  it('creates new parents with the permission bits of their source counterparts and keeps moved items\' bits', async () => {
    project.restore();
    chmodSync(project.dataDir, 0o750);
    chmodSync(join(project.dataDir, 'workflows'), 0o700);
    chmodSync(join(project.dataDir, 'runs'), 0o700);
    await migrate(project);
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect(mode(project.newDir)).toBe(0o750);
    expect(mode(join(project.newDir, 'workflows'))).toBe(0o700);
    expect(mode(join(project.newDir, 'runs'))).toBe(0o700);
  });

  it('keeps a lock the user set, and unlocks only the worktrees the migration locked', async () => {
    project.restore();
    git(project.root, 'worktree', 'lock', '--reason', 'mine, keep it', project.taskPath);
    await migrate(project);
    const listed = git(project.root, 'worktree', 'list', '--porcelain');
    expect(listed).toContain(`worktree ${moved(project, project.taskPath)}\nHEAD`);
    expect(listed.match(/^locked.*$/gm)).toEqual(['locked mine, keep it']);
    expect(listed.split('\n\n').find(record => record.startsWith(`worktree ${moved(project, project.taskPath)}\n`))).toContain('locked mine, keep it');
  });

  it('runs in an owning cockpit after its drain: the context is disposed first, then rebuilt on the moved state', async () => {
    project.restore();
    const ownership = new CockpitOwnership();
    owners.push(ownership);
    const contexts = new ProjectContexts({ createRunner, home: testHome(), ownership,
      listProjects: async () => [{ id: 'p', root: project.root, status: 'not-git' as const }] });
    disposers.push(() => contexts.disposeAll());
    const context = await contexts.context('p');
    await context.store.reports.idle();
    const held = await fenceProjectContext(ownership, context);
    let closed = false;
    try {
      await migrateProject({ repoRoot: project.root, fence: held, closeProject: () => { closed = contexts.dispose('p', { releasePreviews: false }); } });
    } finally { held.release(); }
    expect(closed).toBe(true);
    expect(contexts.ids()).toEqual([]);
    const rebuilt = await contexts.context('p');
    await rebuilt.store.reports.idle();
    expect(rebuilt.store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath));
    expect(existsSync(join(project.dataDir, RUNS_DB_FILE))).toBe(false);
  });
});

describe('without a release', () => {
  it('keeps the switch off, registers nothing, and refuses to run without the fence held by this process', async () => {
    expect(REBRAND_SWITCH).toBe(false);
    expect(SUBCOMMAND_NAMES.some(name => /migrat/.test(name))).toBe(false);
    const src = join(import.meta.dirname, '..');
    const importers = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter(path => path.endsWith('.ts') && !/\.(?:test|testkit)\.ts$/.test(path) && !path.startsWith('project-migration'))
      .filter(path => /project-migration\//.test(readFileSync(join(src, path), 'utf8')));
    expect(importers).toEqual([]);
    const root = join(import.meta.dirname, 'nowhere');
    const unheld = { lock: join(root, '.ai/squawk-migration.lock'), journal: join(root, '.ai/squawk-migration.json'), release: () => undefined };
    await expect(migrateProject({ repoRoot: root, fence: unheld })).rejects.toThrow(/needs the project's migration fence/);
    await expect(resumeProjectMigration({ repoRoot: root, fence: unheld })).rejects.toThrow(/needs the project's migration fence/);
  });
});
