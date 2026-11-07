import type { Home } from '../home/home.ts';
import { readFileSync } from 'node:fs';
import { homeFileLocation } from '../home/file-location.ts';
import { HomeStore } from '../home/store.ts';
import { parseArgs } from 'node:util';
import { isBackupFile, listBackups, type BackupFile } from './backups.ts';
import { storeSchema } from './agent-accounts.ts';
import { workspaceConfigSchema } from './config.ts';

const HELP = `usage:
  cez backup list [<file>]
  cez backup restore <file> [--at <time>]

Restore the newest backup, or the newest at or before an ISO UTC time.
Use a home-relative file, such as config.json or remote-settings/4321.json.
Account config directories are not restored.`;

export async function restoreBackup(file: BackupFile, at: string | undefined, home: Home): Promise<string> {
  if (!isBackupFile(file)) throw new Error(`Unsupported backup file: ${file}`);
  const utc = at === undefined || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at);
  const limit = at === undefined ? Infinity : utc ? Date.parse(at) : NaN;
  if (Number.isNaN(limit)) throw new Error('Invalid --at time; use an ISO UTC time');
  const store = new HomeStore(home);
  if (at === undefined) {
    const recovered = restorePinnedRecovery(file, home);
    if (recovered) return recovered;
  }
  const entry = listBackups(file, home).find((item) => Date.parse(item.time) <= limit);
  if (!entry) throw new Error(`No backup for ${file}${at ? ` at or before ${at}` : ''}`);
  const bytes = readFileSync(entry.path);
  const restored = restoreBytes(file, bytes);
  store.restoreFile(homeFileLocation(home, file).path, restored);
  if (file === 'config.json') refreshSnapshot(store, home);
  return entry.time;
}

/** Cockpit recovery never falls back to a rotation when another cockpit already resolved it. */
export function restorePinnedRecovery(file: BackupFile, home: Home, detectedAt?: string): string | undefined {
  if (!isBackupFile(file)) throw new Error(`Unsupported backup file: ${file}`);
  const store = new HomeStore(home);
  const recovered = store.restoreRecovery(homeFileLocation(home, file).path, detectedAt);
  if (recovered && file === 'config.json') refreshSnapshot(store, home);
  return recovered;
}

const warnedSnapshots = new Set<string>();

/** A failed auxiliary snapshot never changes the result of the committed primary restore. */
function refreshSnapshot(store: HomeStore, home: Home): void {
  try {
    let bytes: Buffer;
    try { bytes = readFileSync(home.workspaceConfig); } catch (error) {
      // Restoring an absent pinned HEAD must not recreate it from a stale snapshot.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    store.replace(`${home.workspaceConfig}.bak`, bytes);
  } catch (error) {
    if (warnedSnapshots.has(home.workspaceConfig)) return;
    warnedSnapshots.add(home.workspaceConfig);
    console.warn(`[cez] workspace backup unavailable after restore (${error instanceof Error ? error.message : String(error)})`);
  }
}

function restoreBytes(file: BackupFile, bytes: Buffer): Buffer {
  if (file !== 'config.json' && file !== 'agent-accounts.json') return bytes;
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Backup must contain a JSON object');
  let restored: unknown;
  if (file === 'config.json') {
    const config = workspaceConfigSchema.parse(raw);
    warnDroppedEntries(raw, 'projects', config.projects.length);
    restored = config;
  } else {
    const accounts = storeSchema.parse(raw);
    warnDroppedEntries(raw, 'accounts', accounts.accounts.length);
    restored = accounts;
  }
  return Buffer.from(`${JSON.stringify(restored, null, 2)}\n`);
}

function warnDroppedEntries(raw: object, key: 'projects' | 'accounts', kept: number): void {
  const original: unknown = (raw as Record<string, unknown>)[key];
  if (Array.isArray(original) && original.length > kept) {
    console.warn(`[cez] restore dropped ${original.length - kept} invalid ${key} entries from the snapshot`);
  }
}

export async function runBackupCommand(argv: string[], _env: NodeJS.ProcessEnv, home: Home): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      at: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { console.log(HELP); return 0; }
    const [command, file] = positionals;
    if (file !== undefined && !isBackupFile(file)) throw new Error('File must be a supported home-relative HomeStore file');
    if (command === 'list' && positionals.length <= 2 && values.at === undefined) {
      console.log(JSON.stringify(listBackups(file as BackupFile | undefined, home), null, 2));
      return 0;
    }
    if (command === 'restore' && file && positionals.length === 2) {
      const time = await restoreBackup(file as BackupFile, values.at, home);
      console.log(`Restored ${file} from ${time}. Only the home file was restored.`);
      return 0;
    }
    throw new Error(HELP);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
