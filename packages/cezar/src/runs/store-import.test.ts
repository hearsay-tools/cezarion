import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { processStartToken } from '../delegation/process-liveness.ts';
import { RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunDatabase, RunDatabaseDiskFullError } from './run-database.ts';
import { blockRunWrites, readPersistedRuns, runIds } from './run-store.testkit.ts';
import { LEGACY_INDEX_BACKUP_FILE, RunStore, __setLegacyImportHookForTests } from './store.ts';
import { RunStoreOpenError } from './store-open-error.ts';

/** Import and recovery hardening of the run database (#779, plan step 4). */

const STORE_MODULE = fileURLToPath(new URL('./store.ts', import.meta.url));

const step = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, ...over,
});
/** A stored record as JSON: on purpose not a `RunRecord`, since tests store what this schema does not know. */
const record = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `run ${id}`, workflow: 'quick-task', task: `task ${id}`, status: 'done',
  createdAt: `2026-09-0${Math.min(id.length, 9)}T00:00:00.000Z`, tokensUsed: 0, archived: false, steps: [] as unknown[],
  ...over,
});
/** `count` finished runs with some weight to them, so parsing them takes a moment. */
const manyRecords = (count: number) => Array.from({ length: count }, (_, index) =>
  record(`run-${String(index).padStart(5, '0')}`, { task: 'x'.repeat(2_000), createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }));

let dataDir: string;
let scratch: string;
const children: ChildProcess[] = [];
const stores: RunStore[] = [];
const open = (opts?: { keepLive?: boolean; retryBusy?: boolean }) => {
  const store = RunStore.open(dataDir, opts);
  stores.push(store);
  return store;
};
/** What `open` throws: a test fails loudly if it opened instead. */
const openFailure = (opts?: { keepLive?: boolean; retryBusy?: boolean }): RunStoreOpenError => {
  try {
    open(opts);
  } catch (error) {
    expect(error).toBeInstanceOf(RunStoreOpenError);
    return error as RunStoreOpenError;
  }
  throw new Error('the store opened');
};
const persisted = (id: string) => readPersistedRuns(dataDir).find((run) => run.id === id);
/** Every pre-import backup in the data directory, temp files included. */
const backups = () => readdirSync(dataDir).filter((name) => name.startsWith('runs.json.pre-sqlite')).sort();
const importMeta = (): Record<string, unknown> | undefined => {
  const db = RunDatabase.openReadOnly(join(dataDir, RUNS_DB_FILE));
  if (!db) return undefined;
  try {
    const value = db.getMeta(RUNS_IMPORT_COMPLETE_KEY);
    return value === undefined ? undefined : JSON.parse(value);
  } finally {
    db.close();
  }
};
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** Every file in the data directory with its sha256, so a test can assert nothing changed. */
const snapshot = (names: string[]) => Object.fromEntries(names.map((name) => [name, existsSync(join(dataDir, name)) ? sha256(readFileSync(join(dataDir, name))) : 'missing']));

/** Another process, running `body` (TypeScript, with `RunStore` and the hook setter imported). */
function runChild(name: string, body: string, args: string[] = []): ChildProcess {
  const script = join(scratch, `${name}.mts`);
  writeFileSync(script, `
    import { RunStore, __setLegacyImportHookForTests } from ${JSON.stringify(STORE_MODULE)};
    import { existsSync, writeFileSync } from 'node:fs';
    const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const waitFor = (path: string) => { while (!existsSync(path)) sleep(10); };
    void RunStore; void __setLegacyImportHookForTests; void writeFileSync; void waitFor;
    ${body}
  `);
  const child = spawn(process.execPath, ['--import', 'tsx', script, dataDir, scratch, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function exitOf(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk) => { stdout += chunk; });
  child.stderr!.on('data', (chunk) => { stderr += chunk; });
  const [code] = (child.exitCode !== null ? [child.exitCode] : await once(child, 'exit')) as [number | null];
  return { code, stdout, stderr };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-store-import-'));
  scratch = mkdtempSync(join(tmpdir(), 'cez-store-import-scratch-'));
});

afterEach(async () => {
  __setLegacyImportHookForTests(undefined);
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const store of stores.splice(0)) store.close();
  chmodSync(dataDir, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe('fields this cezar does not know (the raw-record codec)', () => {
  it('survive import, an update and a reopen, while a removed known field stays removed', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a', {
      pinned: true, pinnedAt: '2026-09-01T00:00:00.000Z',
      fromNewerCezar: { nested: ['kept'] },
      steps: [step('s1', { stepFromNewerCezar: 42 }), step('s2')],
    })]));
    const store = open();
    store.updateRun('a', { title: 'renamed' });
    store.updateStep('a', 's2', { status: 'failed' });
    store.setPinned('a', false);
    store.close();

    const reopened = open();
    expect(reopened.getRun('a')?.title).toBe('renamed');
    reopened.updateStep('a', 's1', { iterations: 2 });
    reopened.close();

    const row = persisted('a');
    expect(row.title).toBe('renamed');
    expect(row.fromNewerCezar).toEqual({ nested: ['kept'] });
    expect(row.steps).toEqual([step('s1', { iterations: 2, stepFromNewerCezar: 42 }), step('s2', { status: 'failed' })]);
    expect(row).not.toHaveProperty('pinned');
    expect(row).not.toHaveProperty('pinnedAt');
  });

  it('do not include a field the salvage dropped as unreadable: that drop is the runtime\'s, as before', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a', { lastCiWait: { unreadable: true }, fromNewerCezar: 1 })]));
    const store = open();
    expect(store.getRun('a')?.lastCiWaitError).toContain('unreadable');
    store.updateRun('a', { title: 'touched' });
    store.flush();
    expect(persisted('a')).not.toHaveProperty('lastCiWait');
    expect(persisted('a')).toMatchObject({ fromNewerCezar: 1, lastCiWaitError: expect.stringContaining('unreadable') });
  });

  it('are stored as runs.json held them until the run is first written', () => {
    const original = record('a', { fromNewerCezar: 1, runner: 'claude-cli' });
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([original]));
    expect(open().getRun('a')?.runner).toBe('claude');
    expect(persisted('a')).toEqual(original);
  });

  it('survive an optimistic write and a durable commit of a run read cold', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a', { fromNewerCezar: 'kept' }), record('bb', { fromNewerCezar: 'kept too' })]));
    const store = open();
    store.setArchived('a', true);
    store.flush();
    store.commitDelegation([{ id: 'bb', delegation: { role: 'invalid' } }]);
    expect(persisted('a')).toMatchObject({ archived: true, fromNewerCezar: 'kept' });
    expect(persisted('bb')).toMatchObject({ delegation: { role: 'invalid' }, fromNewerCezar: 'kept too' });
  });
});

describe('the import marker is checked inside the import transaction', () => {
  it('a store that read "not imported" before another store imported writes nothing', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a'), record('bb')]));
    let first = true;
    // The second store reaches its transaction only after the first one imported and wrote a change.
    __setLegacyImportHookForTests({
      beforeTransaction: () => {
        if (!first) return;
        first = false;
        const other = RunStore.open(dataDir);
        other.updateRun('a', { title: 'changed after the import' });
        other.close();
      },
    });
    const imported = importMetaAfter(() => open());
    expect(imported.store.getRun('a')?.title).toBe('changed after the import');
    expect(persisted('a').title).toBe('changed after the import');
    expect(imported.meta).toEqual(importMeta());
  });

  it('a second process that read "not imported" before this one imported writes nothing', async () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a'), record('bb')]));
    const child = runChild('late-importer', `
      const [dataDir, scratch] = process.argv.slice(2);
      __setLegacyImportHookForTests({ beforeTransaction: () => { writeFileSync(scratch + '/ready', ''); waitFor(scratch + '/go'); } });
      const store = RunStore.open(dataDir);
      process.stdout.write(JSON.stringify(store.getRun('a')?.title));
      store.close();
    `);
    const exited = exitOf(child);
    await waitForFile(join(scratch, 'ready'));
    const store = open();
    store.updateRun('a', { title: 'changed after the import' });
    store.close();
    const meta = importMeta();
    writeFileSync(join(scratch, 'go'), '');

    const { code, stdout, stderr } = await exited;
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toBe('changed after the import');
    expect(persisted('a').title).toBe('changed after the import');
    expect(importMeta()).toEqual(meta);
  });

  it('two processes opening a never-imported project at once import it exactly once', async () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify(manyRecords(1_500)));
    const opener = (name: string) => runChild(name, `
      const [dataDir, scratch, name] = process.argv.slice(2);
      __setLegacyImportHookForTests({
        // Neither asks for the write lock before both have read "not imported": the race itself,
        // whatever the host's speed, rather than a hope that the two opens overlap.
        beforeTransaction: () => {
          writeFileSync(scratch + '/read-' + name, '');
          waitFor(scratch + '/read-one');
          waitFor(scratch + '/read-two');
        },
        beforeCommit: () => writeFileSync(scratch + '/imported-' + name, ''),
      });
      writeFileSync(scratch + '/ready-' + name, '');
      waitFor(scratch + '/go');
      const store = RunStore.open(dataDir, { retryBusy: true });
      process.stdout.write(String(store.listRunSummaries().runs.length));
      store.close();
    `, [name]);
    const results = Promise.all([exitOf(opener('one')), exitOf(opener('two'))]);
    // Both are past their startup before either opens.
    await Promise.all([waitForFile(join(scratch, 'ready-one')), waitForFile(join(scratch, 'ready-two'))]);
    writeFileSync(join(scratch, 'go'), '');
    for (const { code, stdout, stderr } of await results) {
      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(stdout).toBe('1500');
    }
    expect(readdirSync(scratch).filter((name) => name.startsWith('read-'))).toHaveLength(2);
    expect(readdirSync(scratch).filter((name) => name.startsWith('imported-'))).toHaveLength(1);
  });
});

function importMetaAfter(fn: () => RunStore): { store: RunStore; meta: Record<string, unknown> | undefined } {
  const store = fn();
  return { store, meta: importMeta() };
}

describe('an import that does not complete', () => {
  it('is imported again, whole, by the next open after a crash inside its transaction', async () => {
    const bytes = JSON.stringify(manyRecords(200));
    writeFileSync(join(dataDir, 'runs.json'), bytes);
    const child = runChild('crashes-mid-import', `
      const [dataDir, scratch] = process.argv.slice(2);
      __setLegacyImportHookForTests({ beforeCommit: () => { writeFileSync(scratch + '/in-transaction', ''); for (;;) sleep(1_000); } });
      RunStore.open(dataDir);
    `);
    const exited = once(child, 'exit');
    await waitForFile(join(scratch, 'in-transaction'));
    child.kill('SIGKILL');
    await exited;
    // Every row was written inside the transaction; none of it, nor the marker, committed.
    expect(readPersistedRuns(dataDir)).toEqual([]);
    expect(importMeta()).toBeUndefined();

    expect(runIds(open())).toHaveLength(200);
    expect(readFileSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE), 'utf8')).toBe(bytes);
    expect(importMeta()).toMatchObject({ source: 'runs.json', records: 200, sha256: sha256(bytes), backup: LEGACY_INDEX_BACKUP_FILE });
  });

  it('is imported again by the next open after a failure inside its transaction', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a'), record('bb')]));
    __setLegacyImportHookForTests({ beforeCommit: () => { throw new RunDatabaseDiskFullError('disk-full', 'runs database: database or disk is full'); } });
    const failure = openFailure();
    expect(failure.kind).toBe('disk-full');
    expect(failure.message).toMatch(/^No space is left to write .*runs\.db .*Free some disk space, then restart cezar\.$/);
    expect(importMeta()).toBeUndefined();
    __setLegacyImportHookForTests(undefined);
    expect(runIds(open())).toEqual(['bb', 'a']);
  });

  it('once complete is never imported again, whatever runs.json says later', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a')]));
    open().close();
    const meta = importMeta();
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a', { title: 'written by an older cezar' }), record('zz')]));
    const store = open();
    expect(store.getRun('a')?.title).toBe('run a');
    expect(store.getRun('zz')).toBeUndefined();
    expect(importMeta()).toEqual(meta);
  });
});

describe('the pre-import backup', () => {
  it('records the bytes it kept: size, sha256 and the file that holds them', () => {
    const bytes = JSON.stringify([record('a')], null, 2);
    writeFileSync(join(dataDir, 'runs.json'), bytes);
    open();
    expect(readFileSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE), 'utf8')).toBe(bytes);
    expect(importMeta()).toMatchObject({ bytes: Buffer.byteLength(bytes), sha256: sha256(bytes), backup: LEGACY_INDEX_BACKUP_FILE });
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('trusts an existing backup only when it holds the same bytes, and never touches one that does not', () => {
    const bytes = JSON.stringify(manyRecords(20));
    writeFileSync(join(dataDir, 'runs.json'), bytes);
    // What a crash in the middle of copying used to leave behind.
    const cutShort = bytes.slice(0, 1_000);
    writeFileSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE), cutShort);

    expect(runIds(open())).toHaveLength(20);
    const kept = `runs.json.pre-sqlite.${sha256(bytes).slice(0, 12)}.bak`;
    expect(readFileSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE), 'utf8')).toBe(cutShort);
    expect(readFileSync(join(dataDir, kept), 'utf8')).toBe(bytes);
    expect(importMeta()).toMatchObject({ sha256: sha256(bytes), backup: kept });
  });

  it('reuses an existing backup that holds the same bytes', () => {
    const bytes = JSON.stringify([record('a')]);
    writeFileSync(join(dataDir, 'runs.json'), bytes);
    writeFileSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE), bytes);
    open();
    expect(readdirSync(dataDir).filter((name) => name.startsWith('runs.json.pre-sqlite'))).toEqual([LEGACY_INDEX_BACKUP_FILE]);
    expect(importMeta()).toMatchObject({ backup: LEGACY_INDEX_BACKUP_FILE });
  });
});

describe('an older cezar still writing runs.json', () => {
  /** A live process holding cockpit.lock for `dataDir`, as an older cockpit does, until it exits
   *  by itself after `lifetimeMs` (open is synchronous: nothing in this process can stop it).
   *  `saving`: it also saves runs.json every 50 ms, by temp file and rename, as one at work does. */
  async function olderCockpit(lifetimeMs = 60_000, saving = false): Promise<ChildProcess> {
    const child = runChild('older-cockpit', `
      const [dataDir] = process.argv.slice(2);
      const { renameSync } = await import('node:fs');
      if (${saving}) {
        let saves = 0;
        setInterval(() => {
          saves++;
          writeFileSync(dataDir + '/runs.json.tmp', JSON.stringify([{ id: 'a', title: 'save ' + saves, workflow: 'w', task: 't', status: 'running', createdAt: '2026-09-01T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [] }]));
          renameSync(dataDir + '/runs.json.tmp', dataDir + '/runs.json');
        }, 50);
      }
      setTimeout(() => process.exit(0), ${lifetimeMs});
    `);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const startToken = processStartToken(child.pid!);
    writeFileSync(join(dataDir, 'cockpit.lock'), JSON.stringify({
      pid: child.pid, token: '7d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a0f', url: 'http://127.0.0.1:4321', ...(startToken ? { startToken } : {}),
    }));
    return child;
  }

  it('holding cockpit.lock: nothing is imported, the user is told to stop it, and the next open imports', async () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a')]));
    const cockpit = await olderCockpit();
    const failure = openFailure();
    expect(failure.kind).toBe('legacy-writer');
    expect(failure.message).toBe(`An older cezar (pid ${cockpit.pid} at http://127.0.0.1:4321) still serves this project and writes runs.json. Stop it, then restart cezar: runs.json is imported once, while nothing else writes it.`);
    expect(importMeta()).toBeUndefined();
    expect(readPersistedRuns(dataDir)).toEqual([]);

    const exited = once(cockpit, 'exit');
    cockpit.kill('SIGKILL');
    await exited;
    expect(runIds(open())).toEqual(['a']);
  });

  it.skipIf(process.getuid?.() === 0)('holding cockpit.lock: the refused open reads, parses and backs up nothing', async () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify(manyRecords(50)));
    // Unreadable, so an open that read it would fail as a permission error instead.
    chmodSync(join(dataDir, 'runs.json'), 0o000);
    let reachedTransaction = 0;
    __setLegacyImportHookForTests({ beforeTransaction: () => { reachedTransaction++; } });
    await olderCockpit();
    try {
      expect(openFailure().kind).toBe('legacy-writer');
    } finally {
      chmodSync(join(dataDir, 'runs.json'), 0o600);
    }
    expect(reachedTransaction).toBe(0);
    expect(backups()).toEqual([]);
  });

  it('holding cockpit.lock and saving at boot: every refused retry is cheap and leaves no backup', async () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a')]));
    let reachedTransaction = 0;
    __setLegacyImportHookForTests({ beforeTransaction: () => { reachedTransaction++; } });
    await olderCockpit(60_000, true);
    const started = performance.now();
    expect(openFailure({ retryBusy: true }).kind).toBe('legacy-writer');
    // The pauses between attempts, and nothing more: no attempt imports anything.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(reachedTransaction).toBe(0);
    expect(backups()).toEqual([]);
  }, 15_000);

  it('saving runs.json during every attempt: no refused attempt leaves a backup, and the import that commits leaves one', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a')]));
    let saves = 0;
    __setLegacyImportHookForTests({
      beforeCommit: () => {
        saves++;
        writeFileSync(join(dataDir, 'runs.json.tmp'), JSON.stringify([record('a', { title: `save ${saves}` })]));
        renameSync(join(dataDir, 'runs.json.tmp'), join(dataDir, 'runs.json'));
      },
    });
    for (let attempt = 0; attempt < 5; attempt++) expect(openFailure().kind).toBe('legacy-writer');
    expect(backups()).toEqual([]);
    __setLegacyImportHookForTests(undefined);
    expect(open().getRun('a')?.title).toBe('save 5');
    expect(backups()).toEqual([LEGACY_INDEX_BACKUP_FILE]);
    expect(readFileSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE), 'utf8')).toBe(readFileSync(join(dataDir, 'runs.json'), 'utf8'));
  });

  it('holding cockpit.lock at boot: the open waits for it to go before it gives up', async () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a')]));
    const cockpit = await olderCockpit(800);
    expect(runIds(open({ retryBusy: true }))).toEqual(['a']);
    expect((await exitOf(cockpit)).code).toBe(0);
  });

  it('saving runs.json during the import: nothing is imported, and the next open imports what it saved', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a')]));
    // An older cezar saves by temp file and rename.
    __setLegacyImportHookForTests({
      beforeCommit: () => {
        writeFileSync(join(dataDir, 'runs.json.tmp'), JSON.stringify([record('a'), record('saved-meanwhile')]));
        renameSync(join(dataDir, 'runs.json.tmp'), join(dataDir, 'runs.json'));
      },
    });
    const failure = openFailure();
    expect(failure.kind).toBe('legacy-writer');
    expect(failure.message).toBe('runs.json changed while cezar was importing it: an older cezar process still writes it. Stop every older cezar process for this project, then restart cezar.');
    expect(importMeta()).toBeUndefined();
    __setLegacyImportHookForTests(undefined);
    expect(runIds(open())).toEqual(['saved-meanwhile', 'a']);
  });

  it('creating runs.json during an import of nothing: nothing is imported', () => {
    __setLegacyImportHookForTests({ beforeCommit: () => writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a')])) });
    expect(openFailure().kind).toBe('legacy-writer');
    __setLegacyImportHookForTests(undefined);
    expect(runIds(open())).toEqual(['a']);
  });
});

describe('a store that cannot be opened is never an empty one', () => {
  it('a database that is not a database: every file stays byte-identical and nothing is created', () => {
    const files = { [RUNS_DB_FILE]: 'corrupt '.repeat(600), [`${RUNS_DB_FILE}-wal`]: 'wal '.repeat(300), [`${RUNS_DB_FILE}-shm`]: 'shm '.repeat(300), 'runs.json': JSON.stringify([record('a')]) };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dataDir, name), text);
    const failure = openFailure({ retryBusy: true });
    expect(failure.kind).toBe('corrupt');
    expect(failure.message).toMatch(/runs\.db is damaged \(.*\)\. cezar left it and its -wal and -shm files exactly as they are: restore them from a backup, or rebuild them from runs\.json\.pre-sqlite\.bak as BACKWARD_COMPATIBILITY\.md §3 "Recovering run history" describes, then restart cezar\.$/);
    for (const [name, text] of Object.entries(files)) expect(readFileSync(join(dataDir, name), 'utf8')).toBe(text);
    expect(readdirSync(dataDir).sort()).toEqual([...Object.keys(files), 'runs'].sort());
  });

  it('a malformed page with a WAL beside it: the database, its WAL and its SHM stay byte-identical', async () => {
    const store = open();
    for (let index = 0; index < 50; index++) store.createRun({ title: `run ${index}`, workflow: 'w', task: 'x'.repeat(500), steps: [] });
    store.close();
    // A process that committed more and died without closing: those commits exist only in the WAL.
    const writer = runChild('dies-with-a-wal', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[2] + '/runs.db');
      db.exec('PRAGMA wal_autocheckpoint = 0');
      const insert = db.prepare("INSERT INTO runs (id, created_at, status, archived, live, revision, data, summary) VALUES (?, '2026-10-01', 'done', 0, 0, 1, '{}', '{}')");
      for (let index = 0; index < 50; index++) insert.run('wal-only-' + index);
      process.exit(0);
    `);
    expect((await exitOf(writer)).code).toBe(0);
    corruptPage(join(dataDir, RUNS_DB_FILE), 'meta');
    const names = [RUNS_DB_FILE, `${RUNS_DB_FILE}-wal`, `${RUNS_DB_FILE}-shm`];
    const before = snapshot(names);
    expect(before[`${RUNS_DB_FILE}-wal`]).not.toBe('missing');

    expect(openFailure().kind).toBe('corrupt');
    expect(snapshot(names)).toEqual(before);
  });

  it('a busy database fails within about one busy timeout, imports nothing, and the next open imports', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a'), record('bb')]));
    RunDatabase.open(join(dataDir, RUNS_DB_FILE)).close();
    const release = blockRunWrites(dataDir);
    let failure: RunStoreOpenError;
    const started = performance.now();
    try {
      failure = openFailure();
    } finally {
      release();
    }
    // A lazy project context opens on a live cockpit's event loop: one attempt, never a backoff.
    expect(performance.now() - started).toBeLessThan(400);
    expect(failure.kind).toBe('busy');
    expect(failure.message).toMatch(/runs\.db is busy: another cezar process has held its write lock\. Wait for it to finish, then restart cezar\.$/);
    expect(importMeta()).toBeUndefined();
    expect(readPersistedRuns(dataDir)).toEqual([]);
    expect(runIds(open())).toEqual(['bb', 'a']);
  });

  it('a busy database at boot is waited out with growing pauses', async () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a'), record('bb')]));
    RunDatabase.open(join(dataDir, RUNS_DB_FILE)).close();
    const holder = runChild('holds-the-write-lock', `
      import { DatabaseSync } from 'node:sqlite';
      const [dataDir, scratch] = process.argv.slice(2);
      const db = new DatabaseSync(dataDir + '/runs.db');
      db.exec('BEGIN IMMEDIATE');
      writeFileSync(scratch + '/locked', '');
      sleep(600);
      db.exec('ROLLBACK');
      db.close();
    `);
    await waitForFile(join(scratch, 'locked'));
    expect(runIds(open({ retryBusy: true }))).toEqual(['bb', 'a']);
    expect((await exitOf(holder)).code).toBe(0);
  });

  it('a database still busy after the boot wait says how long it waited', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a')]));
    RunDatabase.open(join(dataDir, RUNS_DB_FILE)).close();
    const release = blockRunWrites(dataDir);
    try {
      const failure = openFailure({ retryBusy: true });
      expect(failure.kind).toBe('busy');
      expect(failure.message).toMatch(/has held its write lock for over 3\.\d s\./);
    } finally {
      release();
    }
  }, 10_000);

  it.skipIf(process.getuid?.() === 0)('a directory this user cannot write: a permission error naming it', () => {
    chmodSync(dataDir, 0o500);
    const failure = openFailure();
    expect(failure.kind).toBe('permission');
    expect(failure.message).toContain(`Give your user read and write access to ${dataDir}, then restart cezar.`);
  });

  it('a database written by a newer cezar: refused, left as it is', () => {
    open().close();
    const raw = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    const before = snapshot([RUNS_DB_FILE]);
    const failure = openFailure();
    expect(failure.kind).toBe('unsupported-schema');
    expect(failure.message).toMatch(/runs\.db was written by a newer cezar \(schema 99; this cezar reads schema 2\)\. Upgrade cezar to open this project's runs\.$/);
    expect(snapshot([RUNS_DB_FILE])).toEqual(before);
  });
});

describe('RunStore.unavailable', () => {
  it('refuses to create or save a run and schedules nothing', () => {
    const failure = new RunStoreOpenError('corrupt', join(dataDir, RUNS_DB_FILE), 'runs.db is damaged');
    const store = RunStore.unavailable(dataDir, failure);
    stores.push(store);
    vi.useFakeTimers();
    try {
      expect(store.unavailable).toBe(failure);
      expect(() => store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] })).toThrow(failure);
      expect(store.listRunSummaries().runs).toEqual([]);
      store.flush();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    store.close();
    expect(readdirSync(dataDir)).toEqual([]);
  });
});

/** Overwrite the first page of table `table` in the database file with garbage, keeping the
 *  file's header intact: a malformed page SQLite only finds when it reads that table. */
function corruptPage(path: string, table: string): void {
  const raw = new DatabaseSync(path, { readOnly: true });
  let root: number;
  let size: number;
  try {
    root = raw.prepare('SELECT rootpage FROM sqlite_master WHERE name = ?').get(table)!.rootpage as number;
    size = raw.prepare('PRAGMA page_size').get()!.page_size as number;
  } finally {
    raw.close();
  }
  const bytes = readFileSync(path);
  bytes.fill(0xab, (root - 1) * size, root * size);
  writeFileSync(path, bytes);
}

describe('what a failed open leaves behind', () => {
  it('in a fresh data directory, only the runs/ directory beside the damaged file', () => {
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, RUNS_DB_FILE), 'not a database at all, and long enough');
    expect(openFailure().kind).toBe('corrupt');
    expect(readdirSync(dataDir).sort()).toEqual(['runs', RUNS_DB_FILE]);
  });
});
