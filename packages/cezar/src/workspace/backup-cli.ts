import type { Home } from '../home/home.ts';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isBackupFile, listBackups, type BackupFile } from './backups.ts';
import { mergeWriteAgentAccounts, storeSchema } from './agent-accounts.ts';
import { mergeWriteWorkspaceConfig, workspaceConfigSchema } from './config.ts';

const HELP = `usage:
  cez backup list [config.json|agent-accounts.json]
  cez backup restore <file> [--at <time>]

Restore the newest backup, or the newest at or before an ISO UTC time.
Only JSON is restored. Account config directories are not restored.`;

export async function restoreBackup(file: BackupFile, at?: string, home?: Home): Promise<string> {
  const utc = at === undefined || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at);
  const limit = at === undefined ? Infinity : utc ? Date.parse(at) : NaN;
  if (Number.isNaN(limit)) throw new Error('Invalid --at time; use an ISO UTC time');
  const entry = listBackups(file, home).find((item) => Date.parse(item.time) <= limit);
  if (!entry) throw new Error(`No backup for ${file}${at ? ` at or before ${at}` : ''}`);
  const raw: unknown = JSON.parse(readFileSync(entry.path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Backup must contain a JSON object');
  if (file === 'config.json') {
    const restored = workspaceConfigSchema.parse(raw);
    warnDroppedEntries(raw, 'projects', restored.projects.length);
    await mergeWriteWorkspaceConfig(() => restored);
  } else {
    const restored = storeSchema.parse(raw);
    warnDroppedEntries(raw, 'accounts', restored.accounts.length);
    await mergeWriteAgentAccounts(() => restored);
  }
  return entry.time;
}

function warnDroppedEntries(raw: object, key: 'projects' | 'accounts', kept: number): void {
  const original: unknown = (raw as Record<string, unknown>)[key];
  if (Array.isArray(original) && original.length > kept) {
    console.warn(`[cez] restore dropped ${original.length - kept} invalid ${key} entries from the snapshot`);
  }
}

export async function runBackupCommand(argv: string[], _env: NodeJS.ProcessEnv, home?: Home): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      at: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { console.log(HELP); return 0; }
    const [command, file] = positionals;
    if (file !== undefined && !isBackupFile(file)) throw new Error('File must be config.json or agent-accounts.json');
    if (command === 'list' && positionals.length <= 2 && values.at === undefined) {
      console.log(JSON.stringify(listBackups(file as BackupFile | undefined, home), null, 2));
      return 0;
    }
    if (command === 'restore' && file && positionals.length === 2) {
      const time = await restoreBackup(file as BackupFile, values.at, home);
      console.log(`Restored ${file} from ${time}. Only JSON was restored.`);
      return 0;
    }
    throw new Error(HELP);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
