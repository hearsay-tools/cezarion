import type { Home } from '../home/home.ts';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';

export const BACKUP_FILES = ['config.json', 'agent-accounts.json'] as const;
export type BackupFile = typeof BACKUP_FILES[number];
export interface BackupEntry { file: BackupFile; time: string; path: string; }

export function isBackupFile(value: string): value is BackupFile {
  return BACKUP_FILES.some((file) => file === value);
}

/** Names are sortable UTC times, with colons replaced for Windows. */
function entries(home: string | Home, file: BackupFile): BackupEntry[] {
  const dir = join(typeof home === 'string' ? join(home, 'backups') : home.backups, file);
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

export function listBackups(file: BackupFile | undefined, home: string | Home): BackupEntry[] {
  return (file ? [file] : BACKUP_FILES).flatMap((name) => entries(home, name));
}

function prune(home: string, file: BackupFile, now: Date): void {
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

const warned = new Set<string>();
/** Best effort, before replacement. Only the two registry writers call this; ui-state does not. */
export function backupBeforeWrite(path: string, next: unknown, options: { unavailable?: unknown } = {}): void {
  const file = basename(path);
  if (!isBackupFile(file)) throw new Error(`Unsupported backup file: ${file}`);
  let raw: Buffer;
  try { raw = readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    warn(path, error);
    return;
  }
  if (raw.equals(Buffer.from(`${JSON.stringify(next, null, 2)}\n`))) return;
  if (options.unavailable !== undefined) { warn(path, options.unavailable); return; }
  try {
    const home = dirname(path);
    const root = join(home, 'backups');
    const dir = join(root, file);
    const now = new Date();
    const latest = entries(home, file)[0];
    const timestamp = new Date(Math.max(now.getTime(), latest ? Date.parse(latest.time) + 1 : 0));
    const sha = createHash('sha256').update(raw).digest('hex').slice(0, 8);
    for (const directory of [root, dir]) {
      assertCezarHomeWriteIsSandboxed(directory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    writeSnapshot(dir, timestamp, sha, raw);
    prune(home, file, now);
  } catch (error) { warn(path, error); }
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
