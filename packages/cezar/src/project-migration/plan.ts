import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { dirname, posix, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { shellQuote } from '../core/shell-env.ts';
import { ownedWorkspaceRecordFiles, readOwnedWorkspaceRecord } from '../delegation/workspace.ts';
import { pathPresent, projectDestinationAvailable, projectMovedMarker, projectMoveMarked, realDirectory } from '../project-paths.ts';
import { forgetLegacyRunIds, legacyItemOwner, legacyRunIds, LegacyRunsUnreadableError } from '../legacy-runs.ts';
import { LEGACY_INDEX_FILE } from '../runs/legacy-index.ts';
import { RUN_DATABASE_SCHEMA_VERSION, RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunDatabase, RunDatabaseUnsupportedSchemaError } from '../runs/run-database.ts';
import { migrationFencePaths } from '../server/cockpit-ownership.ts';
import type { PathRewrite } from './journal.ts';

/**
 * The read-only plan of a project migration, which is also its dry run: every move, every tracked
 * file left in place with the `git mv` that moves it, every worktree repair and every path rewrite,
 * plus what blocks it. Planning writes nothing: no directory, Git metadata, receipt, run record or
 * journal changes, and the run store is read so that no SQLite sidecar is created.
 *
 * The own items of a task that can still resume at planning (`keep`: live or not archived; its
 * worktree, `runs/<id>…` files and scratch directories, `legacy-runs.ts`) stay in `.ai/cezar/`, and
 * no stored path into them is rewritten. A moved project whose `.ai/cezar/` still holds items plans
 * again: what no kept task owns now moves, so the items of a task archived or deleted since follow
 * the rest.
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
  /** A completed migration marked the project moved, and nothing is left to move or rewrite. */
  alreadyMoved: boolean;
  /** The kept tasks (live or not archived) whose own items stay in the old directory after this plan, sorted. */
  leftovers: string[];
}

export interface ProjectMigrationPlanOptions {
  /** The tasks that can still resume at planning (live or not archived): their own items stay where they are. */
  keep?: ReadonlySet<string>;
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

/**
 * Read the run store at `path` without changing anything beside it: read-only and quiescent, and
 * from a private copy when a WAL file exists, because even a read-only connection writes
 * shared-memory state beside the database it reads.
 */
export function readQuiescentRunDatabase<T>(path: string, read: (db: RunDatabase) => T): T {
  const copy = pathPresent(`${path}-wal`) ? mkdtempSync(join(tmpdir(), 'cez-migration-plan-')) : undefined;
  let db: RunDatabase | null = null;
  try {
    if (copy) for (const suffix of ['', '-wal']) copyFileSync(`${path}${suffix}`, join(copy, `${RUNS_DB_FILE}${suffix}`));
    db = RunDatabase.openReadOnly(copy ? join(copy, RUNS_DB_FILE) : path, RUN_DATABASE_SCHEMA_VERSION, { quiescent: true })!;
    return read(db);
  } finally {
    db?.close();
    if (copy) rmSync(copy, { recursive: true, force: true });
  }
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
  /** Tasks whose own items stay: no path into one moves. */
  keep?: ReadonlySet<string>;
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
  const keep = mapping.keep ?? new Set<string>();
  const kept = (real: string) => keep.size > 0 && real !== source && inside(real, source) && legacyItemOwner(real.slice(source.length + 1).split(sep), keep) !== undefined;
  const absent = (real: string): boolean => {
    const relative = real.slice(realRoot.length + 1).split(sep).join('/');
    if (pathPresent(real) || [...tracked].some(file => file === relative || file.startsWith(`${relative}/`) || relative.startsWith(`${file}/`))) return false;
    return !real.slice(source.length + 1).split(sep)[0]!.startsWith('cockpit.lock');
  };
  return (path) => {
    for (const root of roots) {
      if (!inside(path, root)) continue;
      const real = realRoot + path.slice(root.length);
      if (kept(real)) return undefined;
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

/**
 * Whether a run record field feeds an owned worker's private identity: `workerWorkflowHash` hashes
 * the whole `workflowDef`, `workerContextHash` the whole `delegation.context`. The identity file is
 * immutable evidence, so a kept task keeps these fields as they were written.
 */
export function identityBoundField(field: readonly string[]): boolean {
  return field[0] === 'workflowDef' || (field[0] === 'delegation' && field[1] === 'context');
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

/**
 * The first existing component from `base` down to `path`, both included, that is not a real
 * directory (a symlink, a file); undefined when there is none. A move never passes through one,
 * so no rename can land outside the project.
 */
/** Why moving into the existing directory `target` from `source` would widen access, if it would. */
function broaderMode(target: string, source: string): string | undefined {
  const wanted = statSync(source).mode & 0o777;
  const found = statSync(target).mode & 0o777;
  return (found & ~wanted) === 0 ? undefined
    : `${target} has mode ${found.toString(8)}, broader than ${wanted.toString(8)} of ${source}; run chmod ${wanted.toString(8)} on it or remove it`;
}

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

function realpathOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function sortedEntries(path: string): Dirent[] {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

class Planner {
  readonly plan: ProjectMigrationPlan;
  private trackedFiles = new Set<string>();
  private trackedDirectories = new Set<string>();
  private readonly leftovers = new Set<string>();
  private marked = false;

  constructor(private readonly given: string, readonly root: string, private readonly keep: ReadonlySet<string>) {
    const source = join(root, ...LEGACY_PROJECT_DIR.split('/'));
    this.plan = { repoRoot: root, source, destination: join(root, ...MIGRATED_PROJECT_DIR.split('/')),
      journal: migrationFencePaths(source)!.journal, moves: [], tracked: [], worktrees: [], rewrites: [], conflicts: [],
      blockers: [], gitMv: [], notRewritten: NOT_REWRITTEN, alreadyMoved: false, leftovers: [] };
  }

  async build(): Promise<ProjectMigrationPlan> {
    const { plan } = this;
    if (pathPresent(plan.journal)) plan.blockers.push(`An unfinished project migration journal ${plan.journal} exists; resume it first`);
    if (projectMoveMarked(this.root)) {
      // A moved project plans again only while its old directory holds more than the ownership claims.
      if (!legacyStateLeft(plan.source, plan.destination)) return this.moved();
      this.marked = true;
    }
    // The mark-moved step writes where `projectPaths` looks; refuse before the journal when they differ.
    const common = await gitOutput(this.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const marker = projectMovedMarker(this.root);
    if (common && (!marker || dirname(dirname(marker.path)) !== realpathOrSelf(common.trim()))) {
      plan.blockers.push(`Cannot find the Git directory of ${this.root} from its .git entry, so a move could not be marked`);
    }
    if (!pathPresent(plan.source)) return plan;
    if (!realDirectory(plan.source) || realpathSync(plan.source) !== plan.source) { plan.blockers.push(`${plan.source} is not a directory of this project`); return plan; }
    if (!projectDestinationAvailable(plan.destination)) {
      plan.blockers.push(`${plan.destination} exists and is not a directory`);
      return plan;
    }
    const rootMode = pathPresent(plan.destination) ? broaderMode(plan.destination, plan.source) : undefined;
    if (rootMode) plan.conflicts.push({ path: plan.destination, reason: rootMode });
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
    await this.planItems();
    return plan;
  }

  /** Every move, kept item, repair and rewrite, once the old directory and its tracked files are known. */
  private async planItems(): Promise<void> {
    const { plan } = this;
    this.walk(plan.source, plan.destination, LEGACY_PROJECT_DIR, true);
    plan.leftovers = [...this.leftovers].sort();
    plan.gitMv = gitMvCommands(this.root, plan.tracked);
    const map = pathMapper({ roots: [...new Set([resolve(this.given), this.root])], realRoot: this.root, source: plan.source,
      destination: plan.destination, moves: plan.moves, tracked: this.trackedFiles, keep: this.keep });
    await this.worktreeRepairs(map);
    await this.receiptRewrites(map);
    this.rowRewrites(map);
    this.evidenceRewrites(map);
    // A moved project with nothing left to carry, rewrite or forget changes nothing.
    if (this.marked && plan.moves.length === 0 && plan.worktrees.length === 0 && plan.rewrites.length === 0
      && sameIds(plan.leftovers, currentLeftovers(plan.destination))) plan.alreadyMoved = true;
  }

  /** A second migration of a moved project changes nothing; it lists the tracked files still to move. */
  private async moved(): Promise<ProjectMigrationPlan> {
    const { plan } = this;
    plan.alreadyMoved = true;
    plan.leftovers = currentLeftovers(plan.destination) ?? [];
    const tracked = pathPresent(plan.source) ? await trackedPaths(this.root) : new Set<string>();
    plan.tracked = [...tracked ?? []].sort().map(from => ({ from, to: MIGRATED_PROJECT_DIR + from.slice(LEGACY_PROJECT_DIR.length) }));
    plan.gitMv = gitMvCommands(this.root, plan.tracked);
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
      // A kept task's own item stays where its agent knows it; the directory around it merges.
      const owner = legacyItemOwner(path.split('/').slice(2), this.keep);
      if (owner) { this.leftovers.add(owner); continue; }
      const holds = kind === 'directory' && top ? this.holdsKeptItem(path, source) : false;
      if (holds === 'unknown') continue;
      if (holds) { this.mergeInto(source, target, path); continue; }
      if (kind === 'directory' && this.trackedDirectories.has(path)) {
        // Untracked items move into this directory: it must be a real one, or absent.
        if (pathPresent(target) && !realDirectory(target)) this.plan.conflicts.push({ path: target, reason: `${target} is not a directory; nothing may move through it` });
        else this.mergeInto(source, target, path);
        continue;
      }
      if (pathPresent(target)) {
        // Merge into an existing directory, item by item; a Git worktree is one unit.
        if (kind === 'directory' && realDirectory(target) && !pathPresent(join(source, '.git'))) { this.mergeInto(source, target, path); continue; }
        this.plan.conflicts.push({ path: target, reason: `${source} would replace an existing path` });
        continue;
      }
      this.plan.moves.push({ from: source, to: target, kind });
    }
  }

  /**
   * Whether the top-level directory `source` (at `relative`) holds an item of a task in `keep`.
   * A directory that cannot be listed may hold one: 'unknown' blocks the plan instead of moving it whole.
   */
  private holdsKeptItem(relative: string, source: string): boolean | 'unknown' {
    if (this.keep.size === 0) return false;
    let names: string[];
    try { names = readdirSync(source); } catch (error) {
      this.plan.blockers.push(`Cannot list ${source}, which may hold a kept task's files: ${(error as Error).message}`);
      return 'unknown';
    }
    return names.some(name => legacyItemOwner([...relative.split('/').slice(2), name], this.keep) !== undefined);
  }

  /** Move items into `target`, which exists or is created with the bits of `source`: never a broader one. */
  private mergeInto(source: string, target: string, path: string): void {
    const broader = pathPresent(target) ? broaderMode(target, source) : undefined;
    if (broader) this.plan.conflicts.push({ path: target, reason: broader });
    else this.walk(source, target, path, false);
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
    // A moved project's store is already in the new directory; a later plan rewrites it there.
    const path = join(this.marked ? this.plan.destination : this.plan.source, RUNS_DB_FILE);
    const legacyIndex = pathPresent(join(this.plan.source, LEGACY_INDEX_FILE));
    if (!pathPresent(path)) {
      if (legacyIndex && !this.marked) this.plan.blockers.push(`${join(this.plan.source, LEGACY_INDEX_FILE)} has not been imported into a run store; open the project with this build first`);
      return;
    }
    try {
      readQuiescentRunDatabase(path, (db) => {
        if (legacyIndex && !this.marked && db.getMeta(RUNS_IMPORT_COMPLETE_KEY) === undefined) {
          this.plan.blockers.push(`${join(this.plan.source, LEGACY_INDEX_FILE)} has not been imported into ${path}; open the project with this build first`);
          return;
        }
        for (const row of db.listAll()) {
          const data: unknown = JSON.parse(row.data);
          for (const field of runRecordPathFields(data)) {
            // A kept task's worker identity binds these by hash: rewriting them would refuse its Continue.
            if (this.keep.has(row.id) && identityBoundField(field)) continue;
            this.rowField(row.id, { data: field }, valueAt(data, field), map);
          }
          this.rowField(row.id, { summary: ['worktreePath'] }, valueAt(JSON.parse(row.summary), ['worktreePath']), map);
          this.rowField(row.id, { column: 'worktree_path' }, row.worktreePath, map);
        }
      });
    } catch (error) {
      this.plan.blockers.push(error instanceof RunDatabaseUnsupportedSchemaError
        ? `The run store ${path} is not at this build's schema ${RUN_DATABASE_SCHEMA_VERSION}; open the project with this build first`
        : `Cannot read the run store ${path}: ${(error as Error).message}`);
    }
  }

  private rowField(runId: string, field: Extract<PathRewrite, { kind: 'run-row' }>['field'], from: unknown, map: (path: string) => string | undefined): void {
    const to = typeof from === 'string' ? map(from) : undefined;
    if (to) this.plan.rewrites.push({ kind: 'run-row', runId, field, from: from as string, to });
  }

  /**
   * Run files with stored paths: each one the move carries, rewritten at its new place, and each
   * one that stays (a kept task's own file, or a moved project's newer file) rewritten in place.
   */
  private evidenceRewrites(map: (path: string) => string | undefined): void {
    const roots = [join(this.plan.source, 'runs'), ...this.keep.size > 0 || this.marked ? [join(this.plan.destination, 'runs')] : []];
    for (const runs of roots) {
      if (!realDirectory(runs)) continue;
      const stays = runs !== roots[0];
      const visit = (directory: string, depth: number): void => {
        for (const entry of sortedEntries(directory)) {
          const path = join(directory, entry.name);
          if (entry.isDirectory() && depth < 2) { visit(path, depth + 1); continue; }
          if (!entry.isFile()) continue;
          const kind = evidenceKind(path.slice(runs.length + 1));
          const file = kind && (stays ? path : map(path) ?? (legacyItemOwner(path.slice(this.plan.source.length + 1).split(sep), this.keep) ? path : undefined));
          if (!kind || !file) continue;
          try { this.evidenceFile(path, file, kind, map); }
          catch (error) { this.plan.blockers.push(`Cannot read ${path}: ${(error as Error).message}`); }
        }
      };
      visit(runs, 0);
    }
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
export async function planProjectMigration(repoRoot: string, options: ProjectMigrationPlanOptions = {}): Promise<ProjectMigrationPlan> {
  return new Planner(repoRoot, realpathSync(resolve(repoRoot)), options.keep ?? new Set()).build();
}

/** Whether the old directory `source` holds anything but the `cockpit.lock*` ownership claims.
 *  One that cannot be listed may: the planner then reports why. */
export function legacyItemsPresent(source: string): boolean {
  if (!realDirectory(source)) return false;
  try { return readdirSync(source).some(name => !name.startsWith('cockpit.lock')); }
  catch { return true; }
}

/** Whether a moved project still has work for a move: items in the old directory `source`, or an
 *  unreadable kept-task list in `destination`, which a move rewrites from the run store. */
export function legacyStateLeft(source: string, destination: string): boolean {
  return legacyItemsPresent(source) || currentLeftovers(destination) === undefined;
}

/** The leftover tasks the moved directory `destination` names now, read from disk; undefined
 *  when the file is present but unreadable, so the move rewrites it from the run store. */
function currentLeftovers(destination: string): string[] | undefined {
  forgetLegacyRunIds(destination);
  try { return [...legacyRunIds(destination)].sort(); } catch (error) {
    if (error instanceof LegacyRunsUnreadableError) return undefined;
    throw error;
  }
}

/** Whether `b`, a list read from disk (undefined when unreadable), names exactly `a`. */
function sameIds(a: readonly string[], b: readonly string[] | undefined): boolean {
  return b !== undefined && a.length === b.length && a.every((id, index) => id === b[index]);
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
    ...plan.alreadyMoved ? ['Already moved: a completed migration marked this project; nothing moves'] : [],
    ...section('Blockers', plan.blockers),
    ...section('Destination conflicts', plan.conflicts.map(conflict => `${conflict.path}: ${conflict.reason}`)),
    ...section('Moves', plan.moves.map(move => `${move.from} -> ${move.to}`)),
    ...section('Kept in .ai/cezar/ for tasks until they are archived', plan.leftovers),
    ...section('Worktree repairs (git worktree repair)', plan.worktrees.map(worktree => `${worktree.from} -> ${worktree.to}`)),
    ...section('Path rewrites', plan.rewrites.map(rewrite => `${rewriteLocation(rewrite)}: ${rewrite.from} -> ${rewrite.to}`)),
    ...section('Tracked files left in place; run these and commit', plan.gitMv),
    ...section('Not rewritten on purpose', plan.notRewritten),
  ].join('\n');
}
