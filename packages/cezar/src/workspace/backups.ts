import { logPrefix } from '../home/display.ts';
import type { Home } from '../home/home.ts';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { assertSquawkHomeWriteIsSandboxed } from '../paths.ts';
import { assertHomePaths } from '../home/boundary.ts';
import { homeFileSchema } from '@open-mercato/cezar-contract/home-recovery';
import { homeFileLocation, homePathLocation } from '../home/file-location.ts';

export const BACKUP_FILES = ['config.json', 'config.json.bak', 'agent-accounts.json', 'ui-state.json', 'server.json', 'server.install.lock'] as const;
export type BackupFile = string;
export interface BackupEntry { file: BackupFile; time: string; path: string; }

export function isBackupFile(value: string): value is BackupFile {
  return homeFileSchema.safeParse(value).success;
}

/** The newest allowed backup time for `--at`; NaN when the value is not an ISO UTC time. */
export function restoreLimit(at: string | undefined): number {
  if (at === undefined) return Infinity;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at) ? Date.parse(at) : NaN;
}

/** The one parser for `backup` arguments: the command and its home entry read the same options. */
export function parseBackupArgs(argv: readonly string[]) {
  return parseArgs({ args: [...argv], allowPositionals: true, options: {
    at: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
}

/** `restore <file> [--at <time>]` with one supported file and no help; anything else is not a restore. */
export function restoreRequest({ values, positionals }: ReturnType<typeof parseBackupArgs>): { file: BackupFile; at: string | undefined } | undefined {
  const [command, file] = positionals;
  if (values.help || command !== 'restore' || positionals.length !== 2 || file === undefined || !isBackupFile(file)) return undefined;
  return { file, at: values.at };
}

/** A restore that will run: its arguments parse and its time is valid. Anything else is help or a usage error. */
export function isValidRestore(argv: readonly string[]): boolean {
  try {
    const request = restoreRequest(parseBackupArgs(argv));
    return request !== undefined && !Number.isNaN(restoreLimit(request.at));
  } catch { return false; }
}

function backupRoot(home: string | Home): string {
  return typeof home === 'string' ? join(home, 'backups') : home.backups;
}

/** Decides whether a list may read a path. A legacy fallback reads only inside its own home. */
type ReadGuard = (path: string) => boolean;
const readAny: ReadGuard = () => true;
function readInside(root: string): ReadGuard {
  return path => { try { assertHomePaths(root, [path]); return true; } catch { return false; } };
}

/** Names are sortable UTC times, with colons replaced for Windows. */
function entries(home: string | Home, file: BackupFile, directory = join(backupRoot(home), file), readable = readAny): BackupEntry[] {
  const dir = directory;
  if (!readable(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name) => {
    const match = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z)-([a-f0-9]{8})\.json$/.exec(name);
    if (!match) return [];
    const path = join(dir, name);
    if (!readable(path)) return [];
    try {
      if (createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8) !== match[2]) return [];
    } catch { return []; }
    const time = match[1]!.replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');
    return [{ file, time, path }];
  }).sort((a, b) => b.time.localeCompare(a.time) || b.path.localeCompare(a.path));
}

/** Discover backup keys even after the live file was removed. Never recurse into snapshots. */
function backupFiles(home: string | Home, readable: ReadGuard): BackupFile[] {
  const files: BackupFile[] = [...BACKUP_FILES];
  for (const family of ['remote-settings', 'server-instances']) {
    const familyRoot = typeof home === 'string' ? home : homeFileLocation(home, `${family}/config.json`).root;
    const directories = [join(backupRoot(home), family)];
    if (typeof home === 'string' || home.layout === 'legacy') directories.push(join(familyRoot, family, 'backups'));
    for (const dir of directories) {
      if (!readable(dir)) continue;
      try {
        for (const name of readdirSync(dir)) {
          const key = `${family}/${name}`;
          if (isBackupFile(key) && !files.includes(key)) files.push(key);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return files;
}

function listedEntries(home: string | Home, file: BackupFile, readable: ReadGuard): BackupEntry[] {
  const found = entries(home, file, undefined, readable);
  const root = typeof home === 'string' ? home : home.root;
  // P0/P1b used the basename under a named instance's own directory.
  if ((typeof home === 'string' || home.layout === 'legacy') && file.includes('/') && ['config.json', 'agent-accounts.json'].includes(basename(file))) {
    found.push(...entries(home, file, join(root, dirname(file), 'backups', basename(file)), readable));
  }
  found.sort((a, b) => b.time.localeCompare(a.time) || b.path.localeCompare(a.path));
  if (file === 'config.json') {
    const path = join(root, 'config.json.bak');
    if (readable(path)) try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // .bak is the newest recovery entry, including on coarse filesystem clocks.
        const time = new Date(Math.max(statSync(path).mtimeMs, found[0] ? Date.parse(found[0].time) + 1 : 0)).toISOString();
        found.unshift({ file, path, time });
      }
    } catch { /* The loader also ignores an unreadable or corrupt recovery snapshot. */ }
  }
  return found;
}

/** `contained` lists a home this command does not own: every read must stay inside its root. */
export function listBackups(file: BackupFile | undefined, home: string | Home, { contained = false } = {}): BackupEntry[] {
  if (file !== undefined && !isBackupFile(file)) throw new Error(`Unsupported backup file: ${file}`);
  const readable = contained ? readInside(typeof home === 'string' ? home : home.root) : readAny;
  return (file ? [file] : backupFiles(home, readable)).flatMap((name) => listedEntries(home, name, readable));
}

function prune(home: string | Home, file: BackupFile, now: Date): void {
  const days = new Set<string>();
  const cutoff = now.getTime() - 30 * 86_400_000;
  for (const [index, entry] of entries(home, file).entries()) {
    const day = entry.time.slice(0, 10);
    const daily = Date.parse(entry.time) >= cutoff && !days.has(day);
    days.add(day);
    if (index < 20 || daily) continue;
    assertSquawkHomeWriteIsSandboxed(entry.path);
    unlinkSync(entry.path);
  }
}

/** An install lock holds only the pid of a running installer: no data to recover, so no new snapshot. */
const isInstallLock = (file: BackupFile) => file.endsWith('.install.lock');

const warned = new Set<string>();
/** Best effort before replacement or removal. Older raw lock snapshots stay listed and byte-for-byte restorable. */
export function backupBeforeWrite(path: string, next: unknown, options: { home?: Home | string; unavailable?: unknown; required?: boolean | undefined } = {}): void {
  // The optional fallback preserves the exported P0 helper for root-file callers.
  const home = options.home ?? dirname(path);
  const root = typeof home === 'string' ? home : home.state;
  const file = homePathLocation(home, path).file;
  if (!isBackupFile(file)) throw new Error(`Unsupported backup file: ${file}`);
  if (isInstallLock(file)) return;
  let raw: Buffer;
  try { raw = readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    backupUnavailable(path, error, options.required);
    return;
  }
  const bytes = next === null || Buffer.isBuffer(next) ? next : Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  if (bytes !== null && raw.equals(bytes)) return;
  if (options.unavailable !== undefined) { backupUnavailable(path, options.unavailable, options.required); return; }
  try {
    const backups = backupRoot(home);
    const dir = join(backups, file);
    assertHomePaths(root, [dir]);
    const now = new Date();
    const latest = entries(home, file)[0];
    const timestamp = new Date(Math.max(now.getTime(), latest ? Date.parse(latest.time) + 1 : 0));
    const sha = createHash('sha256').update(raw).digest('hex').slice(0, 8);
    for (const directory of [backups, dir]) {
      assertSquawkHomeWriteIsSandboxed(directory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    writeSnapshot(dir, timestamp, sha, raw);
    prune(home, file, now);
  } catch (error) { backupUnavailable(path, error, options.required); }
}

function backupUnavailable(path: string, error: unknown, required = false): void {
  if (required) throw new Error(`Import refused: backup of ${path} is unavailable. Ignore this change or repair backups before importing.`, { cause: error });
  warn(path, error);
}

/** Keep serialized writes ordered even with a coarse or adjusted clock. */
function writeSnapshot(dir: string, timestamp: Date, sha: string, raw: Buffer): void {
  const stage = join(dir, `${randomUUID()}.tmp`);
  assertSquawkHomeWriteIsSandboxed(stage);
  try {
    writeFileSync(stage, raw, { mode: 0o600, flag: 'wx' });
    for (;;) {
      const target = join(dir, `${timestamp.toISOString().replaceAll(':', '-')}-${sha}.json`);
      assertSquawkHomeWriteIsSandboxed(target);
      try {
        // A hard link publishes complete bytes atomically and refuses an existing target.
        linkSync(stage, target);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        timestamp.setTime(timestamp.getTime() + 1);
      }
    }
  } finally {
    assertSquawkHomeWriteIsSandboxed(stage);
    try { unlinkSync(stage); } catch {
      // Cleanup is best effort; a leftover staging name is never listed or restored.
    }
  }
}

function warn(path: string, error: unknown): void {
  if (warned.has(path)) return;
  warned.add(path);
  const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : 'unavailable');
  console.warn(`${logPrefix()} backups for ${path} are unavailable (${code}); continuing the write`);
}
