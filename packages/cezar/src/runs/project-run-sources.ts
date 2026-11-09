import { z } from 'zod';
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { dataReadDirs, fallbackProjectWriteError, isFallbackProjectPath, pathPresent } from '../project-paths.ts';
import { RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunDatabase, type RunRowInput } from './run-database.ts';

export interface ProjectRunSource {
  directory: string;
  database: string;
  jsonRows?: readonly RunRowInput[];
}

/** Validate before opening a writable primary: corruption must never leave a shadow store. */
export function fallbackRunSource(dataDir: string, parse: (bytes: Buffer) => readonly RunRowInput[] | undefined): ProjectRunSource | undefined {
  const directory = dataReadDirs(dataDir)[1];
  if (!directory) return undefined;
  const database = join(directory, RUNS_DB_FILE);
  try {
    return readFallbackSource(directory, database, parse);
  } catch (error) {
    warnFallbackRunSource(database, error);
    return { directory, database, jsonRows: [] };
  }
}

const warned = new Set<string>();
export function warnFallbackRunSource(path: string, error: unknown): void {
  if (warned.has(path)) return;
  warned.add(path);
  console.warn(`[cez] Cannot read fallback runs from ${path}; fallback runs are unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

function readFallbackSource(directory: string, database: string, parse: (bytes: Buffer) => readonly RunRowInput[] | undefined): ProjectRunSource | undefined {
  const db = RunDatabase.openReadOnly(database);
  if (!db && pathPresent(database)) throw new Error('Unsupported or uninitialized fallback run schema');
  if (db) {
    try {
      if (db.getMeta(RUNS_IMPORT_COMPLETE_KEY) !== undefined) return { directory, database };
    } finally { db.close(); }
  }
  const index = join(directory, 'runs.json');
  if (!pathPresent(index)) return pathPresent(database) ? { directory, database, jsonRows: [] } : undefined;
  const jsonRows = parse(readFileSync(index));
  if (!jsonRows) throw new Error(`Cannot read fallback run index: ${index}`);
  return { directory, database, jsonRows };
}

export function addRunSource(db: RunDatabase, dataDir: string, source: ProjectRunSource, readOnly = false): RunDatabase {
  return RunDatabase.withProjectSource(db, join(dataDir, RUNS_DB_FILE), source.database, source.jsonRows, readOnly);
}

/** Counterpart writes preserve snapshot bytes. Accept only their exact validated old path. */
export function validWorkerResultPath(dataDir: string, hasFallback: boolean, parentId: string, path: string, recorded: string): boolean {
  if (recorded === path) return true;
  const fallback = dataReadDirs(dataDir)[1];
  return Boolean(fallback && hasFallback && recorded === join(fallback, 'runs', `${parentId}-worker-results`, basename(path)));
}

export function fallbackRunDeleteError(dataDir: string, hasFallback: boolean, worktree?: string): string | undefined {
  const source = hasFallback ? dataReadDirs(dataDir)[1] :
    worktree && isFallbackProjectPath(dirname(dirname(dataDir)), worktree) ? worktree : undefined;
  return source ? fallbackProjectWriteError(source) : undefined;
}

export function workerResultsDirectory(dataDir: string, parentId: string, write: boolean): string {
  z.uuid().parse(parentId);
  const dir = join(dataDir, 'runs', `${parentId}-worker-results`);
  if (write) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync(dir) !== resolve(dir) || !lstatSync(dir).isDirectory()) throw new Error('worker result storage redirected');
  return dir;
}
