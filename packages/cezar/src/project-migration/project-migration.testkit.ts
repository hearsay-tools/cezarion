import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeProcessWait, makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { artifactDirectory, publishArtifact } from '../artifacts/store.ts';
import { retainAutosaveCleanup } from '../autosave-cleanup.ts';
import { ensureDataGitignore } from '../data-gitignore.ts';
import { createOwnedWorkspace } from '../delegation/workspace.ts';
import { copyWorkspaceSeed } from '../delegation/workspace-seed.testkit.ts';
import { createWorktree } from '../git-worktree.ts';
import { seedHandoffFile } from '../handoff.ts';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { PROJECT_MIGRATION_STEPS, writeProjectMigrationJournal } from './journal.ts';

/**
 * A real project for the migration engine: a Git repository (the project root is the main checkout
 * or a linked one), tracked workflows, skills and `context.yaml`, a task worktree, two owned worker
 * workspaces with receipts (one with a cleanup checkpoint), a run store, and every kind of
 * file-backed evidence. Built once at a fixed path and restored byte for byte (`cp -a`) for each
 * case, so absolute paths, ids, commits and reflogs are the same in every copy. Every task is
 * archived, so a move carries all of it; a case that keeps a task's items unarchives it.
 */

export const PARENT = '10000000-0000-4000-8000-000000000001';
export const TASK = '20000000-0000-4000-8000-000000000002';
export const WORKER = '30000000-0000-4000-8000-000000000003';
export const CHECKPOINTED = '40000000-0000-4000-8000-000000000004';
export const OTHER = '50000000-0000-4000-8000-000000000005';
export const SNAPSHOT = '60000000-0000-4000-8000-000000000006';
/** A tracked file name that needs quoting: an apostrophe, a command substitution, backticks, spaces. */
export const TRICKY = "it's $(touch pwned) `touch pwned2` a.yaml";

const DATES = { GIT_AUTHOR_DATE: '2026-11-10T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-10T00:00:00Z' };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...DATES } }).trim();
}

export interface MigrationProject {
  base: string;
  /** The project root: the main checkout, or a linked checkout of `repo`. */
  root: string;
  repo: string;
  dataDir: string;
  newDir: string;
  taskPath: string;
  worker: WorkerWorkspace;
  checkpointed: WorkerWorkspace;
  /** In a linked layout: an owned workspace of the main checkout's own project, sharing the receipt directory. */
  other?: WorkerWorkspace;
  artifactId: string;
  restore(): void;
}

function workerRecord(workspace: WorkerWorkspace, extra: Record<string, unknown> = {}) {
  return makeRunRecord({ id: workspace.ownerRunId, status: RUN_STATUS.done, archived: true, worktreePath: workspace.path, branch: workspace.branch,
    delegation: { role: 'worker', parentRunId: PARENT, permissions: [], workspace }, ...extra } as never);
}

/** `checkpoint` writes a real cleanup checkpoint for a workspace and keeps the worktree in place. */
export async function buildMigrationProject(options: { linked: boolean; checkpoint: (root: string, workspace: WorkerWorkspace) => Promise<void> }): Promise<MigrationProject> {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'cez-project-migration-'));
  const work = join(base, 'work');
  const repo = join(work, 'repo');
  await copyWorkspaceSeed(repo);
  let root = repo;
  if (options.linked) {
    git(repo, 'worktree', 'add', '-q', '-b', 'project', join(work, 'linked'));
    root = join(work, 'linked');
  }
  const dataDir = join(root, '.ai/cezar');
  mkdirSync(join(dataDir, 'workflows'), { recursive: true });
  mkdirSync(join(dataDir, 'skills/review'), { recursive: true });
  writeFileSync(join(dataDir, 'workflows/flow.yaml'), 'name: flow\n');
  writeFileSync(join(dataDir, 'workflows', TRICKY), 'name: tricky\n');
  writeFileSync(join(dataDir, 'skills/review/SKILL.md'), '# Review\n');
  writeFileSync(join(dataDir, 'context.yaml'), 'context: true\n');
  git(root, 'add', '-f', '.ai/cezar');
  git(root, 'commit', '-qm', 'project inputs');
  writeFileSync(join(dataDir, 'workflows/local.yaml'), 'name: local, untracked\n');
  // Untracked beside a tracked skill: its move creates .ai/squawk/skills/review and its parent.
  writeFileSync(join(dataDir, 'skills/review/local.txt'), 'untracked note\n');
  ensureDataGitignore(root);
  const sha = git(root, 'rev-parse', 'HEAD');

  const task = await createWorktree(root, TASK, 'HEAD');
  writeFileSync(join(task.path, 'report.html'), '<title>Report</title>report');
  const worker = await createOwnedWorkspace(root, WORKER, sha);
  const checkpointed = await createOwnedWorkspace(root, CHECKPOINTED, sha);
  await options.checkpoint(root, checkpointed);
  const other = options.linked ? await createOwnedWorkspace(repo, OTHER, sha) : undefined;

  const runs = join(dataDir, 'runs');
  const artifact = await publishArtifact(artifactDirectory(dataDir, TASK), TASK, join(task.path, 'report.html'));
  seedRuns(dataDir, [
    makeRunRecord({ id: PARENT, archived: true, delegation: { role: 'root', permissions: ['spawn'], receipts: [] } } as never),
    makeRunRecord({ id: TASK, status: RUN_STATUS.review, archived: true, worktreePath: task.path, branch: task.branch,
      task: `Work in ${task.path} and keep this prose`,
      workflowDef: { name: 'local', path: join(dataDir, 'workflows/local.yaml'), steps: [] },
      lastWaits: [{ ...makeProcessWait({ exitFile: join(dataDir, 't', TASK.slice(0, 8), 'exit') }), unknownWaitField: 1 }],
      futureField: { kept: true } } as never),
    workerRecord(worker, { delegation: { role: 'worker', parentRunId: PARENT, permissions: [], workspace: worker,
      context: { inputs: [{ source: { kind: 'baseline-file', path: 'tracked.txt' }, path: join(worker.path, 'tracked.txt'), sha256: 'a'.repeat(64), bytes: 4 }] } } }),
    workerRecord(checkpointed),
  ]);
  seedHandoffFile(dataDir, { id: TASK, title: 'task', workflow: 'quick-task', task: `Prose naming ${task.path} stays`, worktreePath: task.path });
  writeFileSync(join(runs, `${WORKER}.execution.json`), JSON.stringify({ generation: SNAPSHOT, phase: 'complete',
    scratchCleanup: { resourceId: worker.resourceId, path: worker.path } }), { mode: 0o600 });
  retainAutosaveCleanup(dataDir, TASK, task.path, 'autosave cleanup pending', { processes: [], groups: [], uncertain: false });
  const results = join(runs, `${PARENT}-worker-results`);
  mkdirSync(results, { recursive: true });
  const resultFile = join(results, `${WORKER}.${SNAPSHOT}.json`);
  writeFileSync(resultFile, JSON.stringify({ version: 1, result: { workspace: worker, diff: { path: resultFile },
    artifacts: { items: [{ id: artifact.id, path: join(runs, `${WORKER}-artifacts`, artifact.id, 'content') }] } }, unknown: 'kept' }), { mode: 0o600 });

  const template = join(base, 'template');
  execFileSync('cp', ['-a', work, template]);
  return { base, root, repo, dataDir, newDir: join(root, '.ai/squawk'), taskPath: task.path, worker, checkpointed,
    ...(other ? { other } : {}), artifactId: artifact.id,
    restore: () => { rmSync(work, { recursive: true, force: true }); execFileSync('cp', ['-a', template, work]); } };
}

/** Everything a migration may change, for exact comparison: every file under the checkouts and the
 *  Git directory (hash and mode), each symlink, each run row and metadata entry. Excludes only what
 *  is random by design: the fence holder's `cockpit.lock` claims and SQLite's own files. */
export function projectSnapshot(project: MigrationProject, options: { databaseBytes?: boolean } = {}): Record<string, string> {
  const work = join(project.base, 'work');
  const out: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = relative(work, path);
      if (entry.name.startsWith('cockpit.lock')) continue;
      if (!options.databaseBytes && /^runs\.db(?:-wal|-shm)?$/.test(entry.name)) continue;
      const mode = (lstatSync(path).mode & 0o7777).toString(8);
      if (entry.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}`;
      else if (entry.isDirectory()) { out[key] = `dir ${mode}`; walk(path); }
      else out[key] = `file ${mode} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    }
  };
  walk(work);
  for (const directory of [project.dataDir, project.newDir]) {
    const path = join(directory, 'runs.db');
    try { lstatSync(path); } catch { continue; }
    const db = new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true });
    try {
      for (const row of db.prepare('SELECT id, revision, worktree_path, data, summary FROM runs ORDER BY id').all()) out[`${path} row ${String(row.id)}`] = JSON.stringify(row);
      for (const row of db.prepare('SELECT key, value FROM meta ORDER BY key').all()) out[`${path} meta ${String(row.key)}`] = String(row.value);
    } catch {
      out[`${path} bytes`] = createHash('sha256').update(readFileSync(path)).digest('hex');
    } finally { db.close(); }
  }
  return out;
}

export function removeMigrationProject(project: MigrationProject): void {
  rmSync(project.base, { recursive: true, force: true });
}

/** An unfinished journal with every step marked done and nothing left to apply: a recovery only
 *  removes it. The cheapest journal an entry point must finish before it reads the project. */
export function writeSettledJournal(root: string): string {
  const real = realpathSync(root);
  const path = join(real, '.ai', 'squawk-migration.json');
  mkdirSync(join(real, '.ai'), { recursive: true });
  writeProjectMigrationJournal(path, { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), repoRoot: real,
    source: join(real, '.ai/cezar'), destination: join(real, '.ai/squawk'), done: [...PROJECT_MIGRATION_STEPS], moves: [], tracked: [], worktrees: [], rewrites: [] });
  return path;
}
