import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunDatabase, type RunRowInput } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';
import type { RunRecord } from './store.ts';

/**
 * The one way tests put runs on disk and read them back (#779). Every test that seeded or read
 * `runs.json` goes through here, so the storage format lives in one test file, not forty.
 *
 * Tests about the legacy import itself still write `runs.json`: that file is what they test.
 */

/**
 * Store `records` where `RunStore.open(dataDir)` reads them — `runs.db`, import complete —
 * replacing every run it held. Records are written as given, so a test can seed one the store
 * has to repair or reject: that is the store's job, not the seeder's. Creates `dataDir` and
 * nothing else in it, so a seeded project stays as cold as one no store has opened.
 */
export function seedRuns(dataDir: string, records: readonly unknown[]): void {
  mkdirSync(dataDir, { recursive: true });
  const rows = [...new Map(records.map((record) => {
    const row = seedRow(record as Record<string, unknown>);
    return [row.id, row] as const;
  })).values()];
  const db = RunDatabase.open(join(dataDir, RUNS_DB_FILE));
  try {
    const kept = new Set(rows.map((row) => row.id));
    db.transaction({
      upserts: rows,
      deletes: db.listRevisions().map((row) => row.id).filter((id) => !kept.has(id)),
      meta: { [RUNS_IMPORT_COMPLETE_KEY]: JSON.stringify({ source: 'test seed', records: rows.length }) },
    });
  } finally {
    db.close();
  }
}

/** The store's own row for a well-formed record; a malformed one still gets the columns a row
 *  cannot be written without. */
function seedRow(record: Record<string, unknown>): RunRowInput {
  let encoded: RunRowInput | undefined;
  try {
    encoded = encodeRunRow(record as unknown as RunRecord);
  } catch {
    // e.g. `steps` that is not an array: the store's load path is what must cope with it.
  }
  return {
    ...encoded,
    id: String(record.id),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    status: typeof record.status === 'string' ? record.status : '',
    archived: record.archived === true,
    live: encoded?.live ?? ['queued', 'running', 'waiting'].includes(String(record.status)),
    data: JSON.stringify(record),
    summary: encoded?.summary ?? '{}',
  };
}

/**
 * Every persisted record, newest first, as stored: parsed JSON, not schema-checked, so a test can
 * also corrupt one and seed it back. Empty when nothing has been written. Reads committed rows
 * only, as another process would. `any`, exactly like the `JSON.parse` of `runs.json` it replaces.
 */
export function readPersistedRuns(dataDir: string): any[] {
  return persistedRows(dataDir).map((row) => JSON.parse(row.data));
}

/** Every persisted record AND its stored summary as text — what a test searches when it asserts
 *  that something (a secret, a dropped field) never reached disk. */
export function readPersistedText(dataDir: string): string {
  return persistedRows(dataDir).map((row) => `${row.data}\n${row.summary}`).join('\n');
}

function persistedRows(dataDir: string): Array<{ data: string; summary: string }> {
  const db = RunDatabase.openReadOnly(join(dataDir, RUNS_DB_FILE));
  if (!db) return [];
  try {
    return db.listAll();
  } finally {
    db.close();
  }
}

/**
 * Make store writes fail the way an unavailable disk would, for real: another connection holds
 * the database's write lock, so each store transaction gives up as busy after its timeout and
 * writes nothing. Call the returned function to let go. The database must already exist (open a
 * store first).
 */
export function blockRunWrites(dataDir: string): () => void {
  const db = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
  db.exec('BEGIN IMMEDIATE');
  return () => {
    if (!db.isOpen) return;
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  };
}
