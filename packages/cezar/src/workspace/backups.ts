import type { Home } from '../home/home.ts';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import { assertHomePaths } from '../home/boundary.ts';
import { homeFileSchema } from '@open-mercato/cezar-contract/home-recovery';
import { homeFileLocation, homePathLocation } from '../home/file-location.ts';

export const BACKUP_FILES = ['config.json', 'config.json.bak', 'agent-accounts.json', 'ui-state.json', 'server.json', 'server.install.lock'] as const;
export type BackupFile = string;
export interface BackupEntry { file: BackupFile; time: string; path: string; }

export function isBackupFile(value: string): value is BackupFile {
  return homeFileSchema.safeParse(value).success;
}

function backupRoot(home: string | Home): string {
  return typeof home === 'string' ? join(home, 'backups') : home.backups;
}

/** Names are sortable UTC times, with colons replaced for Windows. */
function entries(home: string | Home, file: BackupFile, directory = join(backupRoot(home), file)): BackupEntry[] {
  const dir = directory;
  let names: string[];
  try { names = readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name) => {
    const match = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z)-([a-f0-9]{8})\.json$/.exec(name);
    if (!match) return [];
    const path = join(dir, name);
    try {
      if (createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8) !== match[2]) return [];
    } catch { return []; }
    const time = match[1]!.replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');
    return [{ file, time, path }];
  }).sort((a, b) => b.time.localeCompare(a.time) || b.path.localeCompare(a.path));
}

/** Discover backup keys even after the live file was removed. Never recurse into snapshots. */
function backupFiles(home: string | Home): BackupFile[] {
  const files: BackupFile[] = [...BACKUP_FILES];
  for (const family of ['remote-settings', 'server-instances']) {
    const familyRoot = typeof home === 'string' ? home : homeFileLocation(home, `${family}/config.json`).root;
    const directories = [join(backupRoot(home), family)];
    if (typeof home === 'string' || home.layout === 'legacy') directories.push(join(familyRoot, family, 'backups'));
    for (const dir of directories) {
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

function listedEntries(home: string | Home, file: BackupFile): BackupEntry[] {
  const found = entries(home, file);
  const root = typeof home === 'string' ? home : home.root;
  // P0/P1b used the basename under a named instance's own directory.
  if ((typeof home === 'string' || home.layout === 'legacy') && file.includes('/') && ['config.json', 'agent-accounts.json'].includes(basename(file))) {
    found.push(...entries(home, file, join(root, dirname(file), 'backups', basename(file))));
  }
  found.sort((a, b) => b.time.localeCompare(a.time) || b.path.localeCompare(a.path));
  if (file === 'config.json') {
    const path = join(root, 'config.json.bak');
    try {
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

export function listBackups(file: BackupFile | undefined, home: string | Home): BackupEntry[] {
  if (file !== undefined && !isBackupFile(file)) throw new Error(`Unsupported backup file: ${file}`);
  return (file ? [file] : backupFiles(home)).flatMap((name) => listedEntries(home, name));
}

function prune(home: string | Home, file: BackupFile, now: Date): void {
  const days = new Set<string>();
  const cutoff = now.getTime() - 30 * 86_400_000;
  for (const [index, entry] of entries(home, file).entries()) {
    const day = entry.time.slice(0, 10);
    const daily = Date.parse(entry.time) >= cutoff && !days.has(day);
    days.add(day);
    if (index < 20 || daily) continue;
    assertCezarHomeWriteIsSandboxed(entry.path);
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
      assertCezarHomeWriteIsSandboxed(directory);
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
  assertCezarHomeWriteIsSandboxed(stage);
  try {
    writeFileSync(stage, raw, { mode: 0o600, flag: 'wx' });
    for (;;) {
      const target = join(dir, `${timestamp.toISOString().replaceAll(':', '-')}-${sha}.json`);
      assertCezarHomeWriteIsSandboxed(target);
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
    assertCezarHomeWriteIsSandboxed(stage);
    try { unlinkSync(stage); } catch {
      // Cleanup is best effort; a leftover staging name is never listed or restored.
    }
  }
}

function warn(path: string, error: unknown): void {
  if (warned.has(path)) return;
  warned.add(path);
  const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : 'unavailable');
  console.warn(`[cez] backups for ${path} are unavailable (${code}); continuing the write`);
}
