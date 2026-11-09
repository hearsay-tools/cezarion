import { RUN_DATABASE_READABLE_FROM, RUN_DATABASE_SCHEMA_VERSION } from './run-database-version.ts';
import { claimOwnerLive } from './run-claims.ts';
import { warnFallbackRunSource } from './project-run-sources.ts';
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { pathPresent } from '../project-paths.ts';
import type { RunRowInput } from './run-database.ts';
import { toRunBindings } from './run-database-row.ts';

type RunChanges = { upserts: readonly RunRowInput[]; deletes: readonly string[]; adoptFallback?: readonly string[] };

/** A write reached a run that is still read only under `.ai/squawk/`. The store refuses such
 *  writes first, so this error means a caller bypassed it. */
export class FallbackWriteRefusedError extends Error {
  constructor(readonly runId: string, source: string) {
    super(`Refused an automatic write to read-only run ${runId} from ${dirname(source)}. Use the binary that migrated the project.`);
    this.name = 'FallbackWriteRefusedError';
  }
}

/** A read projection over two stores. All writes still address main's real tables.
 * Prepared handles follow a deferred connection when an explicit write opens disk.
 * Normal one-directory connections never use this adapter. */
export class ProjectRunConnection {
  readonly connection: DatabaseSync;
  private current: DatabaseSync;
  private deferred: boolean;
  private copied: string[] = [];
  private attached = false;
  private sourceTable = 'project_json';

  constructor(initial: DatabaseSync, readonly target: string, readonly source: string,
    private readonly openDisk: () => DatabaseSync, private readonly jsonRows: readonly RunRowInput[] | undefined, deferred: boolean) {
    this.current = initial;
    this.deferred = deferred;
    this.configure(initial);
    this.connection = new Proxy(initial, { get: (_target, key) => {
      if (key === 'prepare') return (sql: string) => this.prepare(sql);
      const value = Reflect.get(this.current, key, this.current);
      return typeof value === 'function' ? value.bind(this.current) : value;
    } });
  }

  /** Called only before a run write or a family claim, never a query/cache read. */
  writable(): void {
    if (this.deferred) {
      mkdirSync(dirname(this.target), { recursive: true });
      this.switchToDisk();
    }
    mkdirSync(join(dirname(this.target), 'runs'), { recursive: true });
    this.current.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('import-complete', 'project-write')").run();
  }

  private switchToDisk(): void {
    const disk = this.openDisk();
    try { this.configure(disk); }
    catch (error) { disk.close(); throw error; }
    this.current.close();
    this.current = disk;
    this.deferred = false;
  }

  private refresh(): void {
    if (this.deferred && !this.current.isTransaction && pathPresent(this.target)) this.switchToDisk();
  }

  isFallback(id: string): boolean {
    this.refresh();
    return !this.current.prepare('SELECT 1 FROM main.runs WHERE id = ?').get(id) &&
      Boolean(this.current.prepare('SELECT 1 FROM project_runs WHERE id = ?').get(id));
  }

  hasFallback(id: string): boolean {
    this.refresh();
    return Boolean(this.current.prepare(`SELECT 1 FROM ${this.sourceTable} WHERE id = ?`).get(id));
  }

  /** A family is read only while any member's winning row is a fallback row. */
  familyHasFallback(family: string): boolean {
    this.refresh();
    return Boolean(this.current.prepare(`SELECT 1 FROM ${this.sourceTable} source WHERE (source.id = ? OR source.parent_run_id = ?)
      AND NOT EXISTS (SELECT 1 FROM main.runs legacy WHERE legacy.id = source.id) LIMIT 1`).get(family, family));
  }

  /**
   * The database half of the fallback rule: no upsert of a row whose winning copy is a fallback row,
   * and no delete of an ID that has any fallback copy (rule A), unless the transaction adopts its
   * family. Family policy (mixed families, claims, held runs) stays in the store; this guard only
   * catches a store bypass. Checked here only while no legacy database exists, so a refused write
   * cannot create one; otherwise inside the transaction, after the fence (`preserveFamilies`).
   */
  beforeWrite(changes: RunChanges): ReadonlySet<string> {
    const adopted = new Set(changes.adoptFallback ?? []);
    this.assertAdoptable(adopted);
    if (this.deferred) this.assertWritable(changes, adopted);
    if (changes.upserts.length || changes.deletes.length || adopted.size) this.writable();
    return adopted;
  }

  /** A family with a fallback member is never claimed here; adoption copies it first. */
  claimable<T extends { family: string }>(take: readonly T[]): readonly T[] {
    const kept = take.filter(({ family }) => !this.familyHasFallback(family));
    if (kept.length) this.writable();
    return kept;
  }

  assertWritable(changes: RunChanges, adopted: ReadonlySet<string>): void {
    for (const row of changes.upserts) {
      if (!adopted.has(row.parentRunId ?? row.id) && this.isFallback(row.id)) throw new FallbackWriteRefusedError(row.id, this.source);
    }
    for (const id of changes.deletes) if (this.hasFallback(id)) throw new FallbackWriteRefusedError(id, this.source);
  }

  private configure(db: DatabaseSync): void {
    let table: string;
    let attached = false;
    try { table = this.jsonRows ? this.jsonTable(db) : this.attach(db); attached = !this.jsonRows; }
    catch (error) {
      try { db.exec('DETACH DATABASE project_fallback'); } catch { /* attach may have failed before publication */ }
      warnFallbackRunSource(this.source, error); table = this.jsonTable(db);
    }
    const columns = db.prepare('PRAGMA main.table_info(runs)').all();
    const sourceNames = new Set(db.prepare(`PRAGMA ${attached ? 'project_fallback' : 'temp'}.table_info(${attached ? 'runs' : 'project_json'})`).all().map(row => row.name));
    // Negative source sequences preserve insertion order and never collide with main's rowids.
    const sourceColumns = columns.map(({ name, dflt_value }) => name === 'seq' ? 'seq - 9007199254740991 AS seq' :
      sourceNames.has(name) ? String(name) : `${dflt_value ?? 'NULL'} AS ${name}`).join(', ');
    db.exec(`CREATE TEMP VIEW project_runs AS SELECT * FROM main.runs UNION ALL
      SELECT ${sourceColumns} FROM ${table} source WHERE NOT EXISTS (SELECT 1 FROM main.runs legacy WHERE legacy.id = source.id)`);
    this.attached = attached;
    this.sourceTable = table;
    const claims = attached ? 'SELECT * FROM project_fallback.run_claims' : 'SELECT * FROM main.run_claims WHERE 0';
    db.exec(`CREATE TEMP VIEW project_claims AS SELECT * FROM main.run_claims UNION ALL
      SELECT * FROM (${claims}) source WHERE NOT EXISTS (SELECT 1 FROM main.run_claims legacy WHERE legacy.family = source.family)`);
  }

  private attach(db: DatabaseSync): string {
    const url = pathToFileURL(this.source);
    url.searchParams.set('mode', 'ro');
    db.prepare('ATTACH DATABASE ? AS project_fallback').run(url.href);
    const version = Number(db.prepare('PRAGMA project_fallback.user_version').get()!.user_version);
    if (version < RUN_DATABASE_READABLE_FROM || version > RUN_DATABASE_SCHEMA_VERSION) throw new Error(`Unsupported fallback run schema: ${version}`);
    db.prepare('SELECT 1 FROM project_fallback.run_claims LIMIT 1').get();
    return 'project_fallback.runs';
  }

  private jsonTable(db: DatabaseSync): string {
    db.exec('CREATE TEMP TABLE project_json AS SELECT * FROM main.runs WHERE 0');
    const insert = db.prepare(`INSERT INTO project_json
      (seq, id, created_at, finished_at, status, archived, live, parent_run_id, client_request_id,
       group_id, worktree_path, branch, base_branch, revision, data, summary)
      VALUES (:seq, :id, :createdAt, :finishedAt, :status, :archived, :live, :parentRunId,
       :clientRequestId, :groupId, :worktreePath, :branch, :baseBranch, :revision, :data, :summary)`);
    this.jsonRows?.forEach((row, index) => insert.run({ ...toRunBindings(row, 1), seq: index + 1 }));
    return 'project_json';
  }

  private prepare(sql: string): StatementSync {
    const read = /^\s*(?:SELECT|WITH)\b/i.test(sql);
    const projected = read ? projectReadTables(sql) : sql;
    let owner = this.current;
    let statement = owner.prepare(projected);
    return new Proxy(statement, { get: (_target, key) => {
      this.refresh();
      if (owner !== this.current) { owner = this.current; statement = owner.prepare(projected); }
      const value = Reflect.get(statement, key, statement);
      return typeof value === 'function' ? value.bind(statement) : value;
    } });
  }

  /** A live process of the migrating binary still owns the family: adoption must wait for it. */
  assertAdoptable(families: Iterable<string>): void {
    for (const family of families) {
      const sourceClaim = this.attached ? this.current.prepare('SELECT session, pid, start_token AS startToken FROM project_fallback.run_claims WHERE family = ?').get(family) : undefined;
      if (sourceClaim && claimOwnerLive({ session: String(sourceClaim.session), pid: Number(sourceClaim.pid), startToken: sourceClaim.startToken === null ? null : String(sourceClaim.startToken) })) {
        throw new Error(`Fallback family is in use by another process: ${dirname(this.source)}`);
      }
    }
  }

  /** Explicit adoption only: inside the primary transaction, after its ownership and row fences passed. */
  preserveFamilies(families: ReadonlySet<string>, changes: RunChanges): void {
    this.assertAdoptable(families);
    for (const family of families) {
      const rows = this.current.prepare(`SELECT * FROM project_runs WHERE id = ? OR parent_run_id = ?`).all(family, family);
      for (const row of rows) {
        const id = row.id as string;
        if (!this.isFallback(id)) continue;
        this.copyRunFiles(id);
        this.current.prepare(`INSERT INTO main.meta (key, value) VALUES ('commit-seq', ?)
          ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`)
          .run(String(row.revision));
        const columns = Object.keys(row).filter(key => key !== 'seq');
        this.current.prepare(`INSERT INTO main.runs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...columns.map(key => row[key] as string | number | null));
      }
    }
    // Re-checked inside the transaction: the fallback source may have changed since `beforeWrite`.
    this.assertWritable(changes, new Set());
  }

  commitFiles(): void { this.copied = []; }
  rollbackFiles(): void {
    for (const path of this.copied) rmSync(path, { recursive: true, force: true });
    this.copied = [];
  }

  private copyRunFiles(id: string): void {
    const source = join(dirname(this.source), 'runs');
    if (!pathPresent(source)) return;
    const target = join(dirname(this.target), 'runs');
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      if (!name.startsWith(`${id}.`) && !name.startsWith(`${id}-`)) continue;
      const path = join(source, name);
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Cannot preserve redirected fallback run file: ${path}`);
      const destination = join(target, name);
      if (pathPresent(destination)) {
        if (sameRunFiles(path, destination)) continue;
        throw new Error(`Legacy run sidecar already exists without its record: ${destination}`);
      }
      this.copied.push(destination);
      cpSync(path, destination, { recursive: true, force: false, errorOnExist: true, dereference: false });
    }
  }
}

/** Match only table references. Quoted text and comments are opaque to the projection. */
function projectReadTables(sql: string): string {
  return sql.replace(/('(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/)|\b(FROM|JOIN)(\s+)(runs|run_claims)\b/gi,
    (match, quoted: string | undefined, keyword: string, space: string, table: string, offset: number) => {
      if (quoted) return match;
      const next = /^\s+(?:AS\s+)?([a-z_]\w*|"|`|\[)/i.exec(sql.slice(offset + match.length))?.[1];
      const aliased = next && !/^(WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|GROUP|ORDER|LIMIT|UNION|INTERSECT|EXCEPT|ON|USING|NOT|INDEXED)$/i.test(next);
      return `${keyword}${space}${table.toLowerCase() === 'runs' ? 'project_runs' : 'project_claims'}${aliased ? '' : ` AS ${table}`}`;
    });
}

/** A previous process may have copied a sidecar before its SQLite transaction committed. */
function sameRunFiles(source: string, target: string): boolean {
  const from = lstatSync(source), to = lstatSync(target);
  if (from.isFile() && to.isFile()) return readFileSync(source).equals(readFileSync(target));
  if (!from.isDirectory() || !to.isDirectory()) return false;
  const names = readdirSync(source).sort(), existing = readdirSync(target).sort();
  return names.length === existing.length && names.every((name, index) =>
    name === existing[index] && sameRunFiles(join(source, name), join(target, name)));
}
