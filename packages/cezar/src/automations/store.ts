import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { collectSecretValues, redactDeep } from '../core/secret-redaction.ts';
import { join, resolve } from 'node:path';
import {
  automationDefinitionSchema,
  automationDefinitionsFileSchema,
  automationLogRecordSchema,
  automationReceiptSchema,
  automationStateFileSchema,
  type AutomationDefinition,
  type AutomationLogRecord,
  type AutomationReceipt,
  type AutomationRuntimeState,
} from './types.ts';
import type { GithubCandidate } from './github-poller.ts';

const DEFINITIONS = 'automations.json';
const STATE = 'automation-state.json';
const RECEIPTS = 'automation-receipts.ndjson';
const LOG = 'automation-log.ndjson';
const LOG_LOCK = 'automation-log.lock';
const LOG_RECLAIM = 'automation-log.reclaim';
const POLL_LOCK = 'automation-poll.lock';
const POLL_RECLAIM = 'automation-poll.reclaim';
/**
 * Write locks for the two read-modify-write JSON files, one per file. Held only across one
 * read+write (milliseconds), so a holder older than `WRITE_LOCK_STALE_MS` is abandoned whatever
 * its pid says; the bounded wait outlasts that age, so a stale holder always clears in time.
 * Never confused with the #651 polling lease: nothing acquires that lease while holding these.
 */
const DEFINITIONS_LOCK = 'automations.lock';
const DEFINITIONS_RECLAIM = 'automations.reclaim';
const STATE_LOCK = 'automation-state.lock';
const STATE_RECLAIM = 'automation-state.reclaim';
const WRITE_LOCK_STALE_MS = 5_000;
const WRITE_LOCK_TIMEOUT_MS = 10_000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * Reservations THIS process wrote and has not settled yet, per data directory. A `reserved`
 * receipt on disk is ambiguous: a crash leftover, or a launch still running here. Only this
 * process can tell, and reconciliation must leave the second kind alone — a lazily built
 * project context reconciles while the timer's launch that triggered the build is in flight.
 * Process-wide rather than per store, so a second store opened on the same directory agrees.
 */
const inFlightReservations = new Map<string, Set<string>>();
const LEASE_RECLAIM_ATTEMPTS = 1;

type DefinitionsFile = ReturnType<typeof automationDefinitionsFileSchema.parse>;
type StateFile = ReturnType<typeof automationStateFileSchema.parse>;

export interface AutomationStoreOptions {
  warn?: (message: string) => void;
  now?: () => Date;
  processAlive?: (pid: number) => boolean;
  /** How long a definitions/state write waits for the other process's write lock. Tests only. */
  writeLockTimeoutMs?: number;
}

export class AutomationStore {
  private definitionsFile: DefinitionsFile = { version: 1, automations: [] };
  private stateFile: StateFile = { version: 1, states: {} };
  private definitions = new Map<string, AutomationDefinition>();
  private warned = new Set<string>();
  /** What `definitions`/`stateFile` were read from: see `reloadIfChanged`. */
  private seen = '';
  private readonly now: () => Date;
  private readonly secrets = collectSecretValues();

  static open(dataDir: string, options: AutomationStoreOptions = {}): AutomationStore {
    const store = new AutomationStore(dataDir, options);
    store.load();
    return store;
  }

  private constructor(
    readonly dataDir: string,
    private readonly options: AutomationStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  list(): AutomationDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): AutomationDefinition | undefined {
    return this.definitions.get(id);
  }

  create(
    input: Omit<AutomationDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
    id: string = randomUUID(),
  ): AutomationDefinition {
    return this.withWriteLock(DEFINITIONS_LOCK, DEFINITIONS_RECLAIM, () => this.createLocked(input, id));
  }

  private createLocked(
    input: Omit<AutomationDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
    id: string,
  ): AutomationDefinition {
    this.refreshDefinitions();
    if (this.definitions.has(id) || this.isTombstoned(id)) throw new Error('automation id unavailable');
    const now = this.now().toISOString();
    const definition = automationDefinitionSchema.parse({
      ...input,
      id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.definitions.set(id, definition);
    this.persistDefinitions();
    return definition;
  }

  update(
    id: string,
    expectedRevision: number,
    input: Omit<AutomationDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
  ): AutomationDefinition {
    // Lock order is always definitions -> state (the `setState` below); nothing takes them reversed.
    return this.withWriteLock(DEFINITIONS_LOCK, DEFINITIONS_RECLAIM, () => this.updateLocked(id, expectedRevision, input));
  }

  private updateLocked(
    id: string,
    expectedRevision: number,
    input: Omit<AutomationDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>,
  ): AutomationDefinition {
    this.refreshDefinitions();
    const current = this.definitions.get(id);
    if (!current) throw new Error('automation not found');
    if (current.revision !== expectedRevision) throw new Error('automation revision conflict');
    const definition = automationDefinitionSchema.parse({
      ...current,
      ...input,
      id,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString(),
    });
    this.definitions.set(id, definition);
    if (this.state(id)) this.setState(id, (current) => ({ ...current, revision: definition.revision }));
    this.persistDefinitions();
    return definition;
  }

  delete(id: string): boolean {
    return this.withWriteLock(DEFINITIONS_LOCK, DEFINITIONS_RECLAIM, () => this.deleteLocked(id));
  }

  private deleteLocked(id: string): boolean {
    this.refreshDefinitions();
    if (!this.definitions.delete(id)) return false;
    this.definitionsFile.tombstones = {
      ...this.definitionsFile.tombstones,
      [id]: this.now().toISOString(),
    };
    this.persistDefinitions();
    return true;
  }

  /**
   * Re-reads the definitions and state files from disk. Another cockpit on this project may have
   * paused, edited or deleted a definition since this process loaded it; a schedule fire calls
   * this under the lease so it never launches a definition that no longer exists on disk. An
   * unreadable file keeps this process's last good view, as `setState` does.
   */
  reload(): void {
    // Stat before reading: a write landing in between leaves a signature older than the content,
    // which costs one extra reload later, never a missed change.
    this.seen = this.signature();
    this.refreshDefinitions();
    this.stateFile = this.readJson(STATE, automationStateFileSchema, this.stateFile);
  }

  /**
   * `reload`, but only when either file changed on disk since this store last read both. The
   * workspace timer calls it on every wake for every known store, so another cockpit's create,
   * edit, enable or pause reaches this process within one timer cap — even after that cockpit
   * exited — at the price of two `stat`s. Every write here is a tmp+rename, so the inode changes
   * on each one; mtime and size back that up. Returns whether it reloaded.
   */
  reloadIfChanged(): boolean {
    if (this.signature() === this.seen) return false;
    this.reload();
    return true;
  }

  /** Whether this project carries the optional definitions file at all. */
  hasDefinitionsFile(): boolean {
    return existsSync(join(this.dataDir, DEFINITIONS));
  }

  private signature(): string {
    return [DEFINITIONS, STATE].map((filename) => {
      try {
        const stat = statSync(join(this.dataDir, filename));
        return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return '-';
      }
    }).join('|');
  }

  state(id: string): AutomationRuntimeState | undefined {
    return this.stateFile.states[id];
  }

  /**
   * Read-modify-write: two cockpits on one project each hold their own in-memory copy of the
   * state file, and a write from memory alone would clobber the other's cursor or `nextRunAt`.
   * Re-reading first merges this ONE id over whatever is on disk, so the two converge.
   *
   * The write for THIS id is also computed from the fresh read, not from the caller's possibly
   * stale snapshot: `update` receives the on-disk record (or `{}` when none exists) and returns
   * the full next record. Never close over a state read from before this call.
   *
   * Re-reading alone still loses a write when two PROCESSES read the same file before either
   * renames, so the read and the write happen under the state write lock (`withWriteLock`).
   */
  setState(id: string, update: (current: AutomationRuntimeState) => AutomationRuntimeState): AutomationRuntimeState {
    return this.withWriteLock(STATE_LOCK, STATE_RECLAIM, () => this.setStateLocked(id, update));
  }

  private setStateLocked(id: string, update: (current: AutomationRuntimeState) => AutomationRuntimeState): AutomationRuntimeState {
    // An unreadable file falls back to this process's last good view, never to an empty one:
    // writing `{ [id]: next }` alone would erase every other automation's cursor and baseline.
    const onDisk = this.readJson(STATE, automationStateFileSchema, this.stateFile);
    const next = update(onDisk.states[id] ?? {});
    this.stateFile = { ...onDisk, states: { ...onDisk.states, [id]: next } };
    this.atomicJson(STATE, this.stateFile);
    return next;
  }

  receipts(): AutomationReceipt[] {
    return this.readNdjson(RECEIPTS, automationReceiptSchema);
  }

  latestReceipts(): Map<string, AutomationReceipt> {
    const latest = new Map<string, AutomationReceipt>();
    for (const row of this.receipts()) latest.set(row.receiptKey, row);
    return latest;
  }

  appendReceipt(receipt: AutomationReceipt): void {
    this.appendNdjson(RECEIPTS, redactDeep(automationReceiptSchema.parse(receipt), this.secrets));
    const key = resolve(this.dataDir);
    const pending = inFlightReservations.get(key) ?? new Set<string>();
    if (receipt.status === 'reserved') pending.add(receipt.receiptId);
    else pending.delete(receipt.receiptId);
    if (pending.size) inFlightReservations.set(key, pending);
    else inFlightReservations.delete(key);
  }

  /** This process reserved the receipt and its launch has not settled (see `inFlightReservations`). */
  isReservationInFlight(receiptId: string): boolean {
    return inFlightReservations.get(resolve(this.dataDir))?.has(receiptId) ?? false;
  }

  reserveReceipt(input: {
    automationId: string;
    revision: number;
    eventId: string;
    candidate?: GithubCandidate;
    /** schedule kind: the occurrence being reserved. */
    occurrenceAt?: string;
  }): AutomationReceipt | undefined {
    const receiptKey = `${input.automationId}:${input.eventId}`;
    if (this.latestReceipts().has(receiptKey)) return undefined;
    const now = this.now().toISOString();
    const receipt = automationReceiptSchema.parse({
      ...input,
      receiptKey,
      receiptId: randomUUID(),
      status: 'reserved',
      observedAt: now,
      updatedAt: now,
    });
    this.appendReceipt(receipt);
    return receipt;
  }

  appendLog(
    record: Omit<AutomationLogRecord, 'seq' | 'ts'> & Partial<Pick<AutomationLogRecord, 'ts'>>,
  ): Promise<AutomationLogRecord> {
    return this.withLogLease(() => {
      const seq = this.readNdjson(LOG, automationLogRecordSchema)
        .reduce((highest, row) => Math.max(highest, row.seq), 0) + 1;
      const parsed = automationLogRecordSchema.parse({
        ...record,
        seq,
        ts: record.ts ?? this.now().toISOString(),
      });
      this.appendNdjson(LOG, redactDeep(parsed, this.secrets));
      return parsed;
    });
  }

  logs(options: { automationId?: string; result?: AutomationLogRecord['result']; event?: AutomationLogRecord['event']; since?: string; cursor?: number; limit?: number } = {}): AutomationLogRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    return this.readNdjson(LOG, automationLogRecordSchema)
      .filter((row) => !options.automationId || row.automationId === options.automationId)
      .filter((row) => !options.result || row.result === options.result)
      .filter((row) => !options.event || row.event === options.event)
      .filter((row) => !options.since || row.ts >= options.since)
      .filter((row) => !options.cursor || row.seq < options.cursor)
      .slice(-limit)
      .reverse();
  }

  async compact(): Promise<void> {
    const cutoff = this.now().getTime() - RETENTION_MS;
    const latest = [...this.latestReceipts().values()].filter(
      (row) => Date.parse(row.updatedAt) >= cutoff,
    );
    this.rewriteNdjson(RECEIPTS, latest);
    await this.withLogLease(() => {
      const logs = this.readNdjson(LOG, automationLogRecordSchema);
      this.rewriteNdjson(LOG, logs.slice(-10_000));
    });
  }

  async maybeCompact(): Promise<void> {
    if (this.receipts().length > 20_000 || this.readNdjson(LOG, automationLogRecordSchema).length > 10_500) {
      await this.compact();
    }
  }

  acquireLease(staleAfterMs = 10 * 60_000): AutomationLease | undefined {
    mkdirSync(this.dataDir, { recursive: true });
    return this.tryAcquireLease(join(this.dataDir, POLL_LOCK), join(this.dataDir, POLL_RECLAIM), staleAfterMs, 0, false);
  }

  private async withLogLease<T>(operation: () => T): Promise<T> {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, LOG_LOCK);
    const guardPath = join(this.dataDir, LOG_RECLAIM);
    const deadline = Date.now() + 15_000;
    let lease: AutomationLease | undefined;
    while (!lease && Date.now() < deadline) {
      lease = this.tryAcquireLease(path, guardPath, 10 * 60_000, 0, false);
      if (!lease) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (!lease) throw new Error('automation log lock is busy; retry shortly');
    try { return operation(); }
    finally { lease.release(); }
  }

  /**
   * Synchronous sibling of `withLogLease` for the read-modify-write JSON files: the callers are
   * synchronous, so the wait sleeps the thread (`Atomics.wait`) instead of yielding. Contention is
   * one other process's millisecond write, so the wait is short in practice; past the bound it
   * throws rather than write unserialized and lose the other process's keys.
   */
  private withWriteLock<T>(lockName: string, reclaimName: string, operation: () => T): T {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, lockName);
    const guardPath = join(this.dataDir, reclaimName);
    const deadline = Date.now() + (this.options.writeLockTimeoutMs ?? WRITE_LOCK_TIMEOUT_MS);
    let lease = this.tryAcquireLease(path, guardPath, WRITE_LOCK_STALE_MS, 0, false);
    while (!lease && Date.now() < deadline) {
      Atomics.wait(SLEEP, 0, 0, 2);
      lease = this.tryAcquireLease(path, guardPath, WRITE_LOCK_STALE_MS, 0, false);
    }
    if (!lease) throw new Error(`automation ${lockName} is busy; retry shortly`);
    try { return operation(); }
    finally { lease.release(); }
  }

  private tryAcquireLease(path: string, guardPath: string, staleAfterMs: number, attempt: number, reclaiming: boolean): AutomationLease | undefined {
    if (!reclaiming && existsSync(guardPath)) {
      const releaseGuard = this.acquireReclaimGuard(guardPath, staleAfterMs);
      if (!releaseGuard) return undefined;
      releaseGuard();
    }
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() }));
      const lease = new AutomationLease(path, fd);
      if (!reclaiming && (existsSync(guardPath) || !lease.isCurrent())) {
        lease.release();
        return undefined;
      }
      return lease;
    } catch {
      if (attempt >= LEASE_RECLAIM_ATTEMPTS) return undefined;
      const releaseGuard = this.acquireReclaimGuard(guardPath, staleAfterMs);
      if (!releaseGuard) return undefined;
      try {
        // Keep the observed inode open: some filesystems immediately reuse an unlinked inode.
        const observedFd = openSync(path, 'r');
        try {
          const observed = fstatSync(observedFd);
          if (this.isLeaseAbandoned(path, staleAfterMs) && sameFile(observed, statSync(path))) {
            unlinkSync(path);
            return this.tryAcquireLease(path, guardPath, staleAfterMs, attempt + 1, true);
          }
        } finally {
          closeSync(observedFd);
        }
      } catch {
        // A contender removed the lock or the directory is read-only.
      } finally {
        releaseGuard();
      }
      return undefined;
    }
  }

  /** Only one process may inspect and remove an abandoned poll lock at a time. */
  private acquireReclaimGuard(path: string, staleAfterMs: number): (() => void) | undefined {
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) return undefined;
        if (!this.retireAbandonedReclaimGuard(path, staleAfterMs)) return undefined;
        continue;
      }
      const ownerPath = join(path, 'owner.json');
      try {
        writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
      } catch {
        try { rmdirSync(path); } catch { /* a crashed writer's guard ages out */ }
        return undefined;
      }
      const identity = statSync(path);
      return () => {
        try {
          if (!sameFile(identity, statSync(path)) || readLeasePid(ownerPath) !== process.pid) return;
          unlinkSync(ownerPath);
          rmdirSync(path);
        } catch { /* another process may already have retired it */ }
      };
    }
    return undefined;
  }

  /** Fresh live guards are respected; abandoned or aged-out guards are recoverable. */
  private retireAbandonedReclaimGuard(path: string, staleAfterMs: number): boolean {
    const marker = join(path, '.reaping');
    let claimedToken: string | undefined;
    try {
      const identity = statSync(path);
      const pid = readLeasePid(join(path, 'owner.json'));
      const agedOut = this.now().getTime() - identity.mtimeMs > staleAfterMs;
      if (!agedOut && (pid === undefined || pid === process.pid || (this.options.processAlive ?? isProcessAlive)(pid))) return false;
      const token = randomUUID();
      try {
        writeFileSync(marker, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
        claimedToken = token;
      } catch {
        // A reaper that crashed after claiming the guard leaves a bounded age fallback.
        if (this.now().getTime() - statSync(marker).mtimeMs > staleAfterMs) {
          unlinkSync(marker);
        }
        return false;
      }
      if (!sameFile(identity, statSync(path))) return false;
      const retired = `${path}.retired-${randomUUID()}`;
      renameSync(path, retired);
      rmSync(retired, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    } finally {
      if (claimedToken) {
        try {
          if ((JSON.parse(readFileSync(marker, 'utf8')) as { token?: string }).token === claimedToken) unlinkSync(marker);
        } catch { /* the guard moved or was retired */ }
      }
    }
  }

  private isLeaseAbandoned(path: string, staleAfterMs: number): boolean {
    if (this.now().getTime() - statSync(path).mtimeMs > staleAfterMs) return true;
    const pid = readLeasePid(path);
    if (pid === undefined || pid === process.pid) return false;
    return !(this.options.processAlive ?? isProcessAlive)(pid);
  }

  private load(): void {
    mkdirSync(this.dataDir, { recursive: true });
    this.seen = this.signature();
    this.loadDefinitions();
    this.stateFile = this.readJson(STATE, automationStateFileSchema, {
      version: 1,
      states: {},
    });
  }

  private loadDefinitions(): void {
    this.adoptDefinitions(this.readJson(DEFINITIONS, automationDefinitionsFileSchema, {
      version: 1,
      automations: [],
    }));
  }

  private adoptDefinitions(file: DefinitionsFile): void {
    const definitions = new Map<string, AutomationDefinition>();
    for (const raw of file.automations) {
      const parsed = automationDefinitionSchema.safeParse(raw);
      if (parsed.success) definitions.set(parsed.data.id, parsed.data);
      else this.warnOnce('definitions', 'Ignored an invalid GitHub automation definition.');
    }
    this.definitionsFile = file;
    this.definitions = definitions;
  }

  /**
   * The definitions half of `reload`. Every definitions write starts here: another cockpit on
   * this project may have created, edited or deleted a definition since this process read the
   * file, and writing the whole list from a stale view would revert that edit or resurrect that
   * deletion. Re-reading first makes the revision check, the not-found check and the tombstone
   * check run against disk, and the write carries every other process's definitions along.
   */
  private refreshDefinitions(): void {
    const definitions = this.readJson(DEFINITIONS, automationDefinitionsFileSchema, this.definitionsFile);
    if (definitions !== this.definitionsFile) this.adoptDefinitions(definitions);
  }

  private persistDefinitions(): void {
    this.pruneTombstones();
    this.definitionsFile.automations = [...this.definitions.values()];
    this.atomicJson(DEFINITIONS, this.definitionsFile);
  }

  private isTombstoned(id: string): boolean {
    const deletedAt = this.definitionsFile.tombstones?.[id];
    return Boolean(deletedAt && Date.parse(deletedAt) >= this.now().getTime() - RETENTION_MS);
  }

  private pruneTombstones(): void {
    const cutoff = this.now().getTime() - RETENTION_MS;
    this.definitionsFile.tombstones = Object.fromEntries(
      Object.entries(this.definitionsFile.tombstones ?? {}).filter(
        ([, timestamp]) => Date.parse(timestamp) >= cutoff,
      ),
    );
  }

  private readJson<T>(
    filename: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
    fallback: T,
  ): T {
    const path = join(this.dataDir, filename);
    if (!existsSync(path)) return fallback;
    try {
      const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) return parsed.data as T;
    } catch {
      // Warn once below.
    }
    this.warnOnce(filename, `Ignored corrupt automation state in ${filename}.`);
    return fallback;
  }

  private readNdjson<T>(
    filename: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  ): T[] {
    const path = join(this.dataDir, filename);
    if (!existsSync(path)) return [];
    const rows: T[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const parsed = schema.safeParse(JSON.parse(line));
        if (parsed.success) rows.push(parsed.data as T);
        else this.warnOnce(filename, `Skipped a malformed row in ${filename}.`);
      } catch {
        this.warnOnce(filename, `Skipped a malformed row in ${filename}.`);
      }
    }
    return rows;
  }

  private atomicJson(filename: string, value: unknown): void {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, filename);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private appendNdjson(filename: string, value: unknown): void {
    mkdirSync(this.dataDir, { recursive: true });
    const path = join(this.dataDir, filename);
    const fd = openSync(path, 'a', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
    } finally {
      closeSync(fd);
    }
  }

  private rewriteNdjson(filename: string, rows: unknown[]): void {
    const path = join(this.dataDir, filename);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), {
      mode: 0o600,
    });
    renameSync(temporary, path);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.warn?.(message);
  }
}

const SLEEP = new Int32Array(new SharedArrayBuffer(4));

function readLeasePid(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown } | null;
    const pid = parsed?.pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** An unknown probe error is treated like a live process; only ESRCH proves absence. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export class AutomationLease {
  private released = false;

  constructor(
    private readonly path: string,
    private readonly fd: number,
  ) {}

  isCurrent(): boolean {
    try { return sameFile(fstatSync(this.fd), statSync(this.path)); }
    catch { return false; }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      if (this.isCurrent()) unlinkSync(this.path);
    } catch {
      // Already removed during shutdown cleanup.
    } finally {
      closeSync(this.fd);
    }
  }
}
