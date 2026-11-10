import { execFile } from 'node:child_process';
import { copyFileSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { posix, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { shellQuote } from '../core/shell-env.ts';
import { ownedWorkspaceRecordFiles, readOwnedWorkspaceRecord } from '../delegation/workspace.ts';
import { pathPresent } from '../project-paths.ts';
import { LEGACY_INDEX_FILE } from '../runs/legacy-index.ts';
import { RUN_DATABASE_SCHEMA_VERSION, RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunDatabase, RunDatabaseUnsupportedSchemaError } from '../runs/run-database.ts';
import { migrationFencePaths } from '../server/cockpit-ownership.ts';
import type { PathRewrite } from './journal.ts';

/**
 * The read-only plan of a project migration, which is also its dry run: every move, every tracked
 * file left in place with the `git mv` that moves it, every worktree repair and every path rewrite,
 * plus what blocks it. Planning writes nothing: no directory, Git metadata, receipt, run record or
 * journal changes, and the run store is read so that no SQLite sidecar is created.
 */

export const LEGACY_PROJECT_DIR = '.ai/cezar';
export const MIGRATED_PROJECT_DIR = '.ai/squawk';

/** Paths that may hold the old directory but are left as they are, on purpose. */
export const NOT_REWRITTEN: readonly string[] = [
  'run_conflicts rows in runs.db: private recovery evidence, kept as each writer saw it',
  'runs.json and runs.json.pre-sqlite.bak: inert import backups of the run store',
  'run event logs, plain or compressed, and transcript facts: history of what happened where',
  'prose: task text, titles, messages, notes, errors and the agent-written parts of handoffs',
  'the claim files cockpit.lock*: they stay in .ai/cezar with the fence holder',
  'agent temp fallback directories outside the project (hearsay-tools/cezarion#3146)',
  'paths of other projects and paths outside the moved items',
];

export type MigrationMove = { from: string; to: string; kind: 'file' | 'directory' | 'symlink' | 'other' };
export type TrackedFile = { from: string; to: string };
export type WorktreeRepair = { from: string; to: string };
export type MigrationConflict = { path: string; reason: string };

export interface ProjectMigrationPlan {
  repoRoot: string;
  source: string;
  destination: string;
  journal: string;
  moves: MigrationMove[];
  tracked: TrackedFile[];
  worktrees: WorktreeRepair[];
  rewrites: PathRewrite[];
  conflicts: MigrationConflict[];
  blockers: string[];
  /** Shell commands, run from any directory, that move the tracked files for the user to commit. */
  gitMv: string[];
  notRewritten: readonly string[];
}

const execFileAsync = promisify(execFile);

/** Git in `cwd`; undefined when it fails. */
export async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try { return (await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60_000 })).stdout; }
  catch { return undefined; }
}

/** Index entries under the legacy directory, relative to the repository root with `/`. */
export async function trackedPaths(root: string): Promise<Set<string> | undefined> {
  const listed = await gitOutput(root, ['ls-files', '-z', '--cached', '--', LEGACY_PROJECT_DIR]);
  return listed === undefined ? undefined : new Set(listed.split('\0').filter(Boolean));
}

export interface PathMapping {
  /** The project root in each form stored paths may use: as registered, and its real path. */
  roots: readonly string[];
  realRoot: string;
  source: string;
  destination: string;
  moves: readonly MigrationMove[];
  /** Tracked files, relative to the root with `/`. */
  tracked: ReadonlySet<string>;
}

const inside = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);

/**
 * Where a stored path goes, in the root form it was written in; undefined when it stays. A path
 * inside a moved item follows that item. A path into the old directory that no longer exists (a
 * cleaned temp directory, a removed worktree) follows the directory, as its item would have, unless
 * a tracked file or an ownership claim holds that name. Everything else stays.
 */
export function pathMapper(mapping: PathMapping): (path: string) => string | undefined {
  const { roots, realRoot, source, destination, moves, tracked } = mapping;
  const absent = (real: string): boolean => {
    const relative = real.slice(realRoot.length + 1).split(sep).join('/');
    if (pathPresent(real) || [...tracked].some(file => file === relative || file.startsWith(`${relative}/`) || relative.startsWith(`${file}/`))) return false;
    return !real.slice(source.length + 1).split(sep)[0]!.startsWith('cockpit.lock');
  };
  return (path) => {
    for (const root of roots) {
      if (!inside(path, root)) continue;
      const real = realRoot + path.slice(root.length);
      const move = moves.find(item => inside(real, item.from));
      const to = move ? move.to + real.slice(move.from.length)
        : real !== source && inside(real, source) && absent(real) ? destination + real.slice(source.length) : undefined;
      if (to) return root + to.slice(realRoot.length);
    }
    return undefined;
  };
}

/** `git mv` for each tracked file, from the repository root, creating each new parent first. */
export function gitMvCommands(root: string, tracked: readonly TrackedFile[]): string[] {
  if (tracked.length === 0) return [];
  const parents = [...new Set(tracked.map(file => posix.dirname(file.to)))];
  return [`cd -- ${shellQuote(root)}`, ...parents.map(parent => `mkdir -p -- ${shellQuote(parent)}`),
    ...tracked.map(file => `git mv -- ${shellQuote(file.from)} ${shellQuote(file.to)}`)];
}

type JsonField = string[];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function valueAt(value: unknown, field: readonly string[]): unknown {
  return field.reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);
}

/** The fields of a list at `list` whose element field is `leaf`, as concrete paths. */
function listFields(value: unknown, list: readonly string[], leaf: readonly string[]): JsonField[] {
  const items = valueAt(value, list);
  return Array.isArray(items) ? items.map((_, index) => [...list, String(index), ...leaf]) : [];
}

/** Every stored path field of a run record that a migration rewrites. */
export function runRecordPathFields(record: unknown): JsonField[] {
  return [['worktreePath'], ['delegation', 'workspace', 'path'], ['workflowDef', 'path'],
    ...listFields(record, ['delegation', 'context', 'inputs'], ['path']),
    ...listFields(record, ['waits'], ['exitFile']), ...listFields(record, ['lastWaits'], ['exitFile']),
    ...listFields(record, ['waitRegistrations'], ['wait', 'exitFile'])];
}

const WORKER_RESULT_FIELDS = (value: unknown): JsonField[] => [['result', 'workspace', 'path'], ['result', 'diff', 'path'],
  ...listFields(value, ['result', 'artifacts', 'items'], ['path'])];

/** File-backed evidence under the moved `runs/` directory and its path fields. */
function evidenceKind(relativeToRuns: string): { kind: Extract<PathRewrite, { field: string[] }>['kind']; fields: (value: unknown) => JsonField[] } | 'handoff' | undefined {
  const parts = relativeToRuns.split(sep);
  const [first, second, third] = parts;
  if (parts.length === 1 && first!.endsWith('.execution.json')) return { kind: 'worker-execution', fields: () => [['scratchCleanup', 'path']] };
  if (parts.length === 1 && first!.endsWith('.autosave-cleanup.json')) return { kind: 'autosave-cleanup', fields: () => [['cwd']] };
  if (parts.length === 1 && first!.endsWith('.handoff.md')) return 'handoff';
  if (parts.length === 2 && first!.endsWith('-worker-results') && second!.endsWith('.json')) return { kind: 'worker-result', fields: WORKER_RESULT_FIELDS };
  if (parts.length === 3 && first!.endsWith('-artifacts') && third === 'metadata.json') return { kind: 'artifact-metadata', fields: () => [['sourcePath']] };
  return undefined;
}

const HANDOFF_WORKTREE = '**Worktree:** ';

/**
 * The index of the worktree line `seedHandoffFile` wrote: the header's title, a blank line,
 * `**Task id:**`, `**Workflow:**`, an optional `**Branch:**`, then `**Worktree:**`. Only that
 * position counts, with LF or CRLF endings; a line anywhere else is the agent's prose.
 */
function handoffWorktreeIndex(lines: readonly string[]): number {
  const bare = (index: number) => (lines[index] ?? '').replace(/\r$/, '');
  if (!bare(0).startsWith('# Handoff') || bare(1) !== '' || !bare(2).startsWith('**Task id:** ') || !bare(3).startsWith('**Workflow:** ')) return -1;
  const at = bare(4).startsWith('**Branch:** ') ? 5 : 4;
  return bare(at).startsWith(HANDOFF_WORKTREE) ? at : -1;
}

export function handoffWorktreeLine(text: string): string | undefined {
  const lines = text.split('\n');
  const index = handoffWorktreeIndex(lines);
  return index < 0 ? undefined : lines[index]!.replace(/\r$/, '').slice(HANDOFF_WORKTREE.length);
}

/** `text` with its seeded worktree line naming `to`, when it still names `from`; else unchanged. */
export function rewriteHandoffWorktreeLine(text: string, from: string, to: string): string {
  const lines = text.split('\n');
  const index = handoffWorktreeIndex(lines);
  if (index < 0 || lines[index]!.replace(/\r$/, '') !== HANDOFF_WORKTREE + from) return text;
  lines[index] = HANDOFF_WORKTREE + to + (lines[index]!.endsWith('\r') ? '\r' : '');
  return lines.join('\n');
}

function moveKind(entry: Dirent): MigrationMove['kind'] {
  return entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
}

function realDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/**
 * The first existing component from `base` down to `path`, both included, that is not a real
 * directory (a symlink, a file); undefined when there is none. A move never passes through one,
 * so no rename can land outside the project.
 */
export function redirectedComponent(base: string, path: string): string | undefined {
  if (!inside(path, base)) return path;
  let current = base;
  for (const part of path === base ? [''] : ['', ...path.slice(base.length + 1).split(sep)]) {
    current = part ? join(current, part) : current;
    if (pathPresent(current) && !realDirectory(current)) return current;
  }
  return undefined;
}

/** A path Git printed, in this platform's form: Git for Windows prints forward slashes. */
export function gitReportedPath(path: string, api: Pick<typeof nodePath, 'normalize'> = nodePath): string {
  return api.normalize(path);
}

function sortedEntries(path: string): Dirent[] {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

class Planner {
  readonly plan: ProjectMigrationPlan;
  private trackedFiles = new Set<string>();
  private trackedDirectories = new Set<string>();

  constructor(private readonly given: string, readonly root: string) {
    const source = join(root, ...LEGACY_PROJECT_DIR.split('/'));
    this.plan = { repoRoot: root, source, destination: join(root, ...MIGRATED_PROJECT_DIR.split('/')),
      journal: migrationFencePaths(source)!.journal, moves: [], tracked: [], worktrees: [], rewrites: [], conflicts: [],
      blockers: [], gitMv: [], notRewritten: NOT_REWRITTEN };
  }

  async build(): Promise<ProjectMigrationPlan> {
    const { plan } = this;
    if (pathPresent(plan.journal)) plan.blockers.push(`An unfinished project migration journal ${plan.journal} exists; resume it first`);
    if (!pathPresent(plan.source)) return plan;
    if (!realDirectory(plan.source) || realpathSync(plan.source) !== plan.source) { plan.blockers.push(`${plan.source} is not a directory of this project`); return plan; }
    if (pathPresent(plan.destination) && !realDirectory(plan.destination)) {
      plan.blockers.push(`${plan.destination} exists and is not a directory`);
      return plan;
    }
    const tracked = await trackedPaths(this.root);
    if (!tracked) { plan.blockers.push(`Git cannot list the tracked files of ${this.root}`); return plan; }
    this.trackedFiles = tracked;
    // The run store and run evidence are read and rewritten after the move: a tracked copy would stay behind.
    const runtime = [...tracked].filter(path => /^\.ai\/cezar\/(?:runs\.db(?:-wal|-shm)?|runs\.json|runs\/.+)$/.test(path)).sort();
    if (runtime.length > 0) {
      plan.blockers.push(`Git tracks run state the migration must move: ${runtime.join(', ')}. Remove it from the index (git rm --cached) and commit first`);
      return plan;
    }
    for (const file of tracked) {
      for (let parent = posix.dirname(file); parent !== '.' && parent !== '/'; parent = posix.dirname(parent)) this.trackedDirectories.add(parent);
    }
    this.walk(plan.source, plan.destination, LEGACY_PROJECT_DIR, true);
    plan.gitMv = gitMvCommands(this.root, plan.tracked);
    const map = pathMapper({ roots: [...new Set([resolve(this.given), this.root])], realRoot: this.root, source: plan.source,
      destination: plan.destination, moves: plan.moves, tracked: this.trackedFiles });
    await this.worktreeRepairs(map);
    await this.receiptRewrites(map);
    this.rowRewrites(map);
    this.evidenceRewrites(map);
    return plan;
  }

  private walk(from: string, to: string, relative: string, top: boolean): void {
    for (const entry of sortedEntries(from)) {
      // The fence holder's ownership claim stays where it was taken; a resume claims it there again.
      if (top && entry.name.startsWith('cockpit.lock')) continue;
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      const path = `${relative}/${entry.name}`;
      if (this.trackedFiles.has(path)) {
        this.plan.tracked.push({ from: path, to: MIGRATED_PROJECT_DIR + path.slice(LEGACY_PROJECT_DIR.length) });
        if (pathPresent(target)) this.plan.conflicts.push({ path: target, reason: `tracked file ${path} would be moved onto an existing path` });
        continue;
      }
      const kind = moveKind(entry);
      if (kind === 'directory' && this.trackedDirectories.has(path)) {
        // Untracked items move into this directory: it must be a real one, or absent.
        if (pathPresent(target) && !realDirectory(target)) this.plan.conflicts.push({ path: target, reason: `${target} is not a directory; nothing may move through it` });
        else this.walk(source, target, path, false);
        continue;
      }
      if (pathPresent(target)) {
        // Merge into an existing directory, item by item; a Git worktree is one unit.
        if (kind === 'directory' && realDirectory(target) && !pathPresent(join(source, '.git'))) { this.walk(source, target, path, false); continue; }
        this.plan.conflicts.push({ path: target, reason: `${source} would replace an existing path` });
        continue;
      }
      this.plan.moves.push({ from: source, to: target, kind });
    }
  }

  private async worktreeRepairs(map: (path: string) => string | undefined): Promise<void> {
    const listed = await gitOutput(this.root, ['worktree', 'list', '--porcelain', '-z']);
    if (listed === undefined) { this.plan.blockers.push(`Git cannot list the worktrees of ${this.root}`); return; }
    for (const entry of listed.split('\0')) {
      if (!entry.startsWith('worktree ')) continue;
      const path = gitReportedPath(entry.slice('worktree '.length));
      const to = map(path);
      // A registration whose directory is gone has nothing to carry; Git's own prune handles it.
      if (to && pathPresent(join(path, '.git'))) this.plan.worktrees.push({ from: path, to });
    }
  }

  private async receiptRewrites(map: (path: string) => string | undefined): Promise<void> {
    let files: string[];
    try { files = await ownedWorkspaceRecordFiles(this.root); }
    catch (error) { this.plan.blockers.push(`Cannot read the owned workspace receipts: ${(error as Error).message}`); return; }
    for (const file of files) {
      let from: unknown;
      try { from = valueAt(JSON.parse(await readOwnedWorkspaceRecord(file)), ['workspace', 'path']); }
      catch (error) { this.plan.blockers.push(`Cannot read the owned workspace record ${file}: ${(error as Error).message}`); continue; }
      const to = typeof from === 'string' ? map(from) : undefined;
      if (to) this.plan.rewrites.push({ kind: file.endsWith('.cleanup.json') ? 'cleanup-checkpoint' : 'receipt', file, field: ['workspace', 'path'], from: from as string, to });
    }
  }

  private rowRewrites(map: (path: string) => string | undefined): void {
    const path = join(this.plan.source, RUNS_DB_FILE);
    const legacyIndex = pathPresent(join(this.plan.source, LEGACY_INDEX_FILE));
    if (!pathPresent(path)) {
      if (legacyIndex) this.plan.blockers.push(`${join(this.plan.source, LEGACY_INDEX_FILE)} has not been imported into a run store; open the project with this build first`);
      return;
    }
    let db: RunDatabase | null = null;
    // A WAL file (a live writer, or one that crashed) is read from a private copy: even a read-only
    // connection writes shared-memory state beside the database it reads.
    const copy = pathPresent(`${path}-wal`) ? mkdtempSync(join(tmpdir(), 'cez-migration-plan-')) : undefined;
    try {
      if (copy) for (const suffix of ['', '-wal']) copyFileSync(`${path}${suffix}`, join(copy, `${RUNS_DB_FILE}${suffix}`));
      db = RunDatabase.openReadOnly(copy ? join(copy, RUNS_DB_FILE) : path, RUN_DATABASE_SCHEMA_VERSION, { quiescent: true })!;
      if (legacyIndex && db.getMeta(RUNS_IMPORT_COMPLETE_KEY) === undefined) {
        this.plan.blockers.push(`${join(this.plan.source, LEGACY_INDEX_FILE)} has not been imported into ${path}; open the project with this build first`);
        return;
      }
      for (const row of db.listAll()) {
        const data: unknown = JSON.parse(row.data);
        for (const field of runRecordPathFields(data)) this.rowField(row.id, { data: field }, valueAt(data, field), map);
        this.rowField(row.id, { summary: ['worktreePath'] }, valueAt(JSON.parse(row.summary), ['worktreePath']), map);
        this.rowField(row.id, { column: 'worktree_path' }, row.worktreePath, map);
      }
    } catch (error) {
      this.plan.blockers.push(error instanceof RunDatabaseUnsupportedSchemaError
        ? `The run store ${path} is not at this build's schema ${RUN_DATABASE_SCHEMA_VERSION}; open the project with this build first`
        : `Cannot read the run store ${path}: ${(error as Error).message}`);
    } finally {
      db?.close();
      if (copy) rmSync(copy, { recursive: true, force: true });
    }
  }

  private rowField(runId: string, field: Extract<PathRewrite, { kind: 'run-row' }>['field'], from: unknown, map: (path: string) => string | undefined): void {
    const to = typeof from === 'string' ? map(from) : undefined;
    if (to) this.plan.rewrites.push({ kind: 'run-row', runId, field, from: from as string, to });
  }

  private evidenceRewrites(map: (path: string) => string | undefined): void {
    const runs = join(this.plan.source, 'runs');
    if (!realDirectory(runs)) return;
    const visit = (directory: string, depth: number): void => {
      for (const entry of sortedEntries(directory)) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth < 2) { visit(path, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const kind = evidenceKind(path.slice(runs.length + 1));
        const file = kind && map(path);
        if (!kind || !file) continue;
        try { this.evidenceFile(path, file, kind, map); }
        catch (error) { this.plan.blockers.push(`Cannot read ${path}: ${(error as Error).message}`); }
      }
    };
    visit(runs, 0);
  }

  private evidenceFile(path: string, file: string, kind: NonNullable<ReturnType<typeof evidenceKind>>, map: (path: string) => string | undefined): void {
    const text = readFileSync(path, 'utf8');
    if (kind === 'handoff') {
      const from = handoffWorktreeLine(text);
      const to = from === undefined ? undefined : map(from);
      if (to) this.plan.rewrites.push({ kind: 'handoff', file, from: from!, to });
      return;
    }
    const value: unknown = JSON.parse(text);
    for (const field of kind.fields(value)) {
      const from = valueAt(value, field);
      const to = typeof from === 'string' ? map(from) : undefined;
      if (to) this.plan.rewrites.push({ kind: kind.kind, file, field, from: from as string, to });
    }
  }
}

/** The dry run, and the plan a real migration writes into its journal. Writes nothing. */
export async function planProjectMigration(repoRoot: string): Promise<ProjectMigrationPlan> {
  return new Planner(repoRoot, realpathSync(resolve(repoRoot))).build();
}

function rewriteLocation(rewrite: PathRewrite): string {
  if (rewrite.kind === 'run-row') {
    const field = 'data' in rewrite.field ? `data.${rewrite.field.data.join('.')}` : 'summary' in rewrite.field ? `summary.${rewrite.field.summary.join('.')}` : rewrite.field.column;
    return `run ${rewrite.runId} ${field}`;
  }
  return `${rewrite.kind} ${rewrite.file}${'field' in rewrite ? ` ${rewrite.field.join('.')}` : ' worktree line'}`;
}

/** The dry run as text: every move, repair, rewrite, tracked file and conflict, and the boundary. */
export function describeProjectMigrationPlan(plan: ProjectMigrationPlan): string {
  const section = (title: string, lines: readonly string[]) => lines.length ? [`${title}:`, ...lines.map(line => `  ${line}`)] : [`${title}: none`];
  return [
    `Project ${plan.repoRoot}: ${plan.source} -> ${plan.destination}`,
    ...section('Blockers', plan.blockers),
    ...section('Destination conflicts', plan.conflicts.map(conflict => `${conflict.path}: ${conflict.reason}`)),
    ...section('Moves', plan.moves.map(move => `${move.from} -> ${move.to}`)),
    ...section('Worktree repairs (git worktree repair)', plan.worktrees.map(worktree => `${worktree.from} -> ${worktree.to}`)),
    ...section('Path rewrites', plan.rewrites.map(rewrite => `${rewriteLocation(rewrite)}: ${rewrite.from} -> ${rewrite.to}`)),
    ...section('Tracked files left in place; run these and commit', plan.gitMv),
    ...section('Not rewritten on purpose', plan.notRewritten),
  ].join('\n');
}
