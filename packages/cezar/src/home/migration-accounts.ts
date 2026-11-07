import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { expandTilde } from '../paths.ts';
import { loadWorkspaceConfigSync } from '../workspace/config.ts';
import { parseAgentAccountEntries, readAgentAccountSource, type AgentAccount } from '../workspace/agent-accounts.ts';
import { recordedProcessLive } from '../delegation/process-liveness.ts';
import type { Home } from './home.ts';
import { replacePrivateTree, insideDirectory, migrationPrivacy } from './migration-files.ts';
import { HomeStore } from './store.ts';
import { VersionLog } from './version-log.ts';
import { readMigrationRecord, writeMigrationRecord, type MigrationRecord } from './migration-record.ts';
import { withHomeLock } from './write-lock.ts';

export interface MigrationAccount { id: string; configDir: string; source: string; target: string; provider: string }

/** Plain reads: inventory and pending rewrites never create journals in either home. */
const readUtf8 = (path: string) => readFileSync(path, 'utf8');

/** Accounts come from the loader's own source and salvage, including the config.json import. */
export function migrationAccountInventory(legacy: Home, target: Home): { accounts: MigrationAccount[]; notMoved: MigrationRecord['notMoved'] } {
  const parsed = parseAgentAccountEntries(readAgentAccountSource(legacy, readUtf8).rows);
  const accounts: MigrationAccount[] = [];
  for (const account of parsed.accounts) {
    let source: string;
    try { source = realpathSync(expandTilde(account.configDir)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!insideDirectory(realpathSync(legacy.root), source)) continue;
    if (insideDirectory(source, target.config) || insideDirectory(source, target.data)) {
      throw new Error(`Account ${account.id} contains the migration target: ${source}`);
    }
    accounts.push({ id: account.id, configDir: account.configDir, provider: account.provider, source,
      target: join(target.data, 'accounts', account.id) });
  }
  return { accounts, notMoved: parsed.duplicates.map(account => ({ id: account.id, configDir: account.configDir, reason: 'duplicate-account-id' })) };
}

/** Rewrite configDir on the rows the loader selects; every other row and key stays as written. */
function rewriteConfigDirs(value: Record<string, unknown>, rewrite: (account: AgentAccount) => string | undefined): Record<string, unknown> | undefined {
  if (!Array.isArray(value.accounts)) return undefined;
  const rows: unknown[] = value.accounts;
  const parsed = parseAgentAccountEntries(rows);
  const selected = new Map(parsed.selectedIndices.map((index, position) => [index, parsed.accounts[position]!]));
  let changed = false;
  const accounts = rows.map((row, index) => {
    const account = selected.get(index);
    const configDir = account && rewrite(account);
    if (!configDir) return row;
    changed = true;
    return { ...(row as object), configDir };
  });
  return changed ? { ...value, accounts } : undefined;
}

export function migrationAccounts(legacy: Home, target: Home): MigrationAccount[] {
  return migrationAccountInventory(legacy, target).accounts;
}

/** omp redirects by profile name, not configDir. Copying it cannot redirect the vendor CLI. */
export function accountMigrationPolicy(account: MigrationAccount): 'copy' | 'keep' {
  return account.provider === 'omp' ? 'keep' : 'copy';
}

/** Read-only query: do not open RunStore, recover runs, or claim a family's execution. */
export function accountInUse(home: Home, id: string): boolean {
  const config = loadWorkspaceConfigSync(home.workspaceConfig, undefined, path => readFileSync(path, 'utf8'));
  return config.projects.some(project => {
    const path = join(project.root, '.ai', 'cezar', 'runs.db');
    if (!existsSync(path)) return false;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare(`SELECT r.data, c.pid, c.start_token FROM runs r
        JOIN run_claims c ON c.family = COALESCE(r.parent_run_id, r.id) WHERE r.live = 1`).all();
      return rows.some(row => {
        const process = { pid: Number(row.pid), ...(typeof row.start_token === 'string' ? { startToken: row.start_token } : {}) };
        if (!recordedProcessLive(process)) return false;
        const run = z.object({ agentProfile: z.string().optional(), steps: z.unknown().optional() }).parse(JSON.parse(String(row.data)));
        // An unspecified account may come from a workspace/project/workflow default. Keep it
        // in place until that live owner ends, rather than guess the session's effective account.
        return run.agentProfile === undefined || run.agentProfile === id || JSON.stringify(run.steps ?? {}).includes(`"${id}"`);
      });
    } catch { return true; } // Unreadable live-session evidence cannot authorize moving credentials.
    finally { db?.close(); }
  });
}

/** Coordinator-approved step-7 mechanism: pending HomeStore stays absolutely read-only. */
export function copyMigrationAccounts(legacy: Home, target: Home, accounts: MigrationAccount[], record: MigrationRecord): void {
  record.deferredAccounts = [];
  record.notMoved = record.notMoved.filter(account => account.reason === 'duplicate-account-id');
  const rewrites = new Map<string, string>();
  for (const account of accounts) {
    if (accountMigrationPolicy(account) === 'keep') {
      record.notMoved.push({ id: account.id, configDir: account.configDir, reason: 'omp-profile-root-inside-legacy-home' });
      console.warn(`[cez] account ${account.id} stays at ${account.configDir}; move omp's root (PI_CONFIG_DIR) outside ${legacy.root}`);
    } else if (accountInUse(legacy, account.id)) record.deferredAccounts.push({ id: account.id, configDir: account.configDir });
    else {
      replacePrivateTree(account.source, account.target);
      rewrites.set(account.id, account.target);
    }
  }
  if (!rewrites.size) return;
  // The copy, or the store the loader would import from the copied config.json.
  const source = readAgentAccountSource(target, readUtf8).value;
  const value = source && rewriteConfigDirs(source, account => rewrites.get(account.id));
  if (value) new VersionLog(target.config, 'agent-accounts.json', migrationPrivacy).replace(target.agentAccounts, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

/** Only boot calls this, before it starts any sessions. Normal committed writes use HomeStore. */
export function finishDeferredAccounts(legacy: Home, target: Home): void {
  const record = readMigrationRecord(target);
  if (!record?.deferredAccounts.length) return;
  withHomeLock(target.config, () => withHomeLock(target.state, () => {
    const store = new HomeStore(target);
    const accounts = migrationAccounts(legacy, target);
    const pending: MigrationRecord['deferredAccounts'] = [];
    for (const deferred of record.deferredAccounts) {
      const current = parseAgentAccountEntries(readAgentAccountSource(target).rows).accounts.find(account => account.id === deferred.id);
      const destination = join(target.data, 'accounts', deferred.id);
      // The registry rewrite commits before the record. A crash in between must never recopy
      // over credentials that a later session may already have updated in the migrated profile.
      if (current && resolve(expandTilde(current.configDir)) === resolve(destination)) continue;
      if (!current || current.configDir !== deferred.configDir) { pending.push(deferred); continue; }
      const account = accounts.find(account => account.id === deferred.id && account.configDir === deferred.configDir);
      if (!account || accountInUse(legacy, deferred.id)) { pending.push(deferred); continue; }
      replacePrivateTree(account.source, account.target);
      store.transaction(() => {
        const source = readAgentAccountSource(target).value;
        const value = source && rewriteConfigDirs(source, row => row.id === account.id && row.configDir === deferred.configDir ? account.target : undefined);
        if (value) store.writeJson(target.agentAccounts, value);
      }, [target.agentAccounts]);
    }
    writeMigrationRecord(target, { ...record, deferredAccounts: pending });
  }));
}
