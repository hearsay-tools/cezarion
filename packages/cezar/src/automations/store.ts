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
import { join } from 'node:path';
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
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const LEASE_RECLAIM_ATTEMPTS = 1;

type DefinitionsFile = ReturnType<typeof automationDefinitionsFileSchema.parse>;
type StateFile = ReturnType<typeof automationStateFileSchema.parse>;

export interface AutomationStoreOptions {
  warn?: (message: string) => void;
  now?: () => Date;
  processAlive?: (pid: number) => boolean;
}

export class AutomationStore {
  private definitionsFile: DefinitionsFile = { version: 1, automations: [] };
  private stateFile: StateFile = { version: 1, states: {} };
  private definitions = new Map<string, AutomationDefinition>();
  private warned = new Set<string>();
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
    const state = this.state(id);
    if (state) this.setState(id, { ...state, revision: definition.revision });
    this.persistDefinitions();
    return definition;
  }

  delete(id: string): boolean {
    if (!this.definitions.delete(id)) return false;
    this.definitionsFile.tombstones = {
      ...this.definitionsFile.tombstones,
      [id]: this.now().toISOString(),
    };
    this.persistDefinitions();
    return true;
  }

  state(id: string): AutomationRuntimeState | undefined {
    return this.stateFile.states[id];
  }

  setState(id: string, state: AutomationRuntimeState): void {
    this.stateFile.states = { ...this.stateFile.states, [id]: state };
    this.atomicJson(STATE, this.stateFile);
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
  }

  reserveReceipt(input: {
    automationId: string;
    revision: number;
    eventId: string;
    candidate?: GithubCandidate;
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
    this.loadDefinitions();
    this.stateFile = this.readJson(STATE, automationStateFileSchema, {
      version: 1,
      states: {},
    });
  }

  private loadDefinitions(): void {
    this.definitionsFile = this.readJson(DEFINITIONS, automationDefinitionsFileSchema, {
      version: 1,
      automations: [],
    });
    for (const raw of this.definitionsFile.automations) {
      const parsed = automationDefinitionSchema.safeParse(raw);
      if (parsed.success) this.definitions.set(parsed.data.id, parsed.data);
      else this.warnOnce('definitions', 'Ignored an invalid GitHub automation definition.');
    }
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
