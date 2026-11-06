import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';

export const BACKUP_FILES = ['config.json', 'agent-accounts.json'] as const;
export type BackupFile = typeof BACKUP_FILES[number];
export interface BackupEntry { file: BackupFile; time: string; path: string; }

export function isBackupFile(value: string): value is BackupFile {
  return BACKUP_FILES.some((file) => file === value);
}

/** Names are sortable UTC times, with colons replaced for Windows. */
function entries(home: string, file: BackupFile): BackupEntry[] {
  const dir = join(home, 'backups', file);
  let names: string[];
  try { names = readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name) => {
    const match = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z)-[a-f0-9]{8}\.json$/.exec(name);
    if (!match) return [];
    const time = match[1]!.replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');
    return [{ file, time, path: join(dir, name) }];
  }).sort((a, b) => b.time.localeCompare(a.time) || b.path.localeCompare(a.path));
}

export function listBackups(file?: BackupFile, home = cezarHomeDir()): BackupEntry[] {
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
export function backupBeforeWrite(path: string, next: unknown): void {
  const file = basename(path);
  if (!isBackupFile(file)) throw new Error(`Unsupported backup file: ${file}`);
  let raw: Buffer;
  try { raw = readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    warn(path, error);
    return;
  }
  if (raw.equals(Buffer.from(`${JSON.stringify(next, null, 2)}\n`))) return;
  try {
    const home = dirname(path);
    const root = join(home, 'backups');
    const dir = join(root, file);
    const now = new Date();
    const sha = createHash('sha256').update(raw).digest('hex').slice(0, 8);
    const target = join(dir, `${now.toISOString().replaceAll(':', '-')}-${sha}.json`);
    for (const directory of [root, dir]) {
      assertCezarHomeWriteIsSandboxed(directory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    assertCezarHomeWriteIsSandboxed(target);
    // Exclusive creation never truncates a snapshot from another writer in the same millisecond.
    try { writeFileSync(target, raw, { mode: 0o600, flag: 'wx' }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    prune(home, file, now);
  } catch (error) { warn(path, error); }
}

function warn(path: string, error: unknown): void {
  if (warned.has(path)) return;
  warned.add(path);
  const code = (error as NodeJS.ErrnoException).code ?? 'unavailable';
  console.warn(`[cez] backups for ${path} are unavailable (${code}); continuing the write`);
}
