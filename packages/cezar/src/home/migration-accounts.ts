import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { expandTilde } from '../paths.ts';
import { loadWorkspaceConfigSync } from '../workspace/config.ts';
import { recordedProcessLive } from '../delegation/process-liveness.ts';
import type { Home } from './home.ts';
import { copyPrivateTree, insideDirectory, migrationPrivacy } from './migration-files.ts';
import { HomeStore } from './store.ts';
import { VersionLog } from './version-log.ts';
import { readMigrationRecord, writeMigrationRecord, type MigrationRecord } from './migration-record.ts';
import { withHomeLock } from './write-lock.ts';

const accountSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), configDir: z.string(), provider: z.string() }).passthrough();
export interface MigrationAccount { id: string; configDir: string; source: string; target: string; provider: string }

export function migrationAccounts(legacy: Home, target: Home): MigrationAccount[] {
  if (!existsSync(legacy.agentAccounts)) return [];
  const store = z.object({ accounts: z.array(z.unknown()).optional() }).parse(JSON.parse(readFileSync(legacy.agentAccounts, 'utf8')));
  const accounts: MigrationAccount[] = [];
  for (const row of store.accounts ?? []) {
    const result = accountSchema.safeParse(row);
    if (!result.success) continue; // Preserve unsalvageable rows byte for byte in the copied store.
    const account = result.data;
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
  return accounts;
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
  record.notMoved = [];
  const rewrites = new Map<string, string>();
  for (const account of accounts) {
    if (accountMigrationPolicy(account) === 'keep') {
      record.notMoved.push({ id: account.id, configDir: account.configDir, reason: 'omp-profile-root-inside-legacy-home' });
      console.warn(`[cez] account ${account.id} stays at ${account.configDir}; move omp's root (PI_CONFIG_DIR) outside ${legacy.root}`);
    } else if (accountInUse(legacy, account.id)) record.deferredAccounts.push({ id: account.id, configDir: account.configDir });
    else {
      copyPrivateTree(account.source, account.target);
      rewrites.set(account.id, account.target);
    }
  }
  if (!rewrites.size) return;
  const value = JSON.parse(readFileSync(target.agentAccounts, 'utf8')) as { accounts: unknown[] };
  value.accounts = value.accounts.map(row => {
    const account = accountSchema.safeParse(row);
    return account.success && rewrites.has(account.data.id) ? { ...account.data, configDir: rewrites.get(account.data.id) } : row;
  });
  new VersionLog(target.config, 'agent-accounts.json', migrationPrivacy).replace(target.agentAccounts, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
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
      const account = accounts.find(account => account.id === deferred.id && account.configDir === deferred.configDir);
      if (!account || accountInUse(legacy, deferred.id)) { pending.push(deferred); continue; }
      copyPrivateTree(account.source, account.target);
      store.transaction(() => {
        const value = JSON.parse(store.read(target.agentAccounts)) as { accounts: unknown[] };
        value.accounts = value.accounts.map(row => {
          const parsed = accountSchema.safeParse(row);
          return parsed.success && parsed.data.id === account.id && parsed.data.configDir === deferred.configDir
            ? { ...parsed.data, configDir: account.target } : row;
        });
        store.writeJson(target.agentAccounts, value);
      }, [target.agentAccounts]);
    }
    writeMigrationRecord(target, { ...record, deferredAccounts: pending });
  }));
}
