import { logPrefix } from '../home/display.ts';
import { commandText } from '../home/command.ts';
import type { Home } from '../home/home.ts';
import { readFileSync } from 'node:fs';
import { homeFileLocation } from '../home/file-location.ts';
import { HomeStore } from '../home/store.ts';
import { isBackupFile, listBackups, parseBackupArgs, restoreLimit, restoreRequest, type BackupFile } from './backups.ts';
import { storeSchema } from './agent-accounts.ts';
import { workspaceConfigSchema } from './config.ts';
import { resolveLegacyRecovery } from '../home/legacy-recovery.ts';

const HELP = commandText(`usage:
  cez backup list [<file>]
  cez backup restore <file> [--at <time>]

Restore the newest backup, or the newest at or before an ISO UTC time.
Use a home-relative file, such as config.json or remote-settings/4321.json.
Account config directories are not restored.`);

const BACKUP_HELP = HELP + commandText(`\n\nLegacy home changes:
  cez backup import <file>   merge changes from the old home
  cez backup ignore <file>   keep the live file and clear the old-home incident
Import requires a successful backup. Deleted legacy files can only be ignored.`);

/** Host CLI actions share the recovery writer; grant files remain blocked in HTTP. */
function resolveLegacyCommand(command: string | undefined, file: string | undefined, validArgs: boolean, home: Home): boolean {
  if (command !== 'import' && command !== 'ignore') return false;
  if (!file || !validArgs) throw new Error(BACKUP_HELP);
  resolveLegacyRecovery(home, file, undefined, command);
  console.log(`Resolved legacy home change for ${file} with ${command}.`);
  return true;
}

export async function restoreBackup(file: BackupFile, at: string | undefined, home: Home): Promise<string> {
  if (!isBackupFile(file)) throw new Error(`Unsupported backup file: ${file}`);
  const limit = restoreLimit(at);
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
    console.warn(`${logPrefix()} workspace backup unavailable after restore (${error instanceof Error ? error.message : String(error)})`);
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
    console.warn(`${logPrefix()} restore dropped ${original.length - kept} invalid ${key} entries from the snapshot`);
  }
}

/** `contained` marks a legacy home listed before migration: the list reads nothing outside it. */
export async function runBackupCommand(argv: string[], _env: NodeJS.ProcessEnv, home: Home, { contained = false } = {}): Promise<number> {
  try {
    const args = parseBackupArgs(argv);
    const { values, positionals } = args;
    if (values.help) { console.log(BACKUP_HELP); return 0; }
    const [command, file] = positionals;
    if (file !== undefined && !isBackupFile(file)) throw new Error('File must be a supported home-relative HomeStore file');
    if (resolveLegacyCommand(command, file, positionals.length === 2 && values.at === undefined, home)) return 0;
    if (command === 'list' && positionals.length <= 2 && values.at === undefined) {
      console.log(JSON.stringify(listBackups(file as BackupFile | undefined, home, { contained }), null, 2));
      return 0;
    }
    const restore = restoreRequest(args);
    if (restore) {
      const time = await restoreBackup(restore.file, restore.at, home);
      console.log(`Restored ${restore.file} from ${time}. Only the home file was restored.`);
      return 0;
    }
    throw new Error(BACKUP_HELP);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
