import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expandTilde } from '../paths.ts';
import { AGENT_ACCOUNT_ID_RE } from '../workspace/agent-accounts.ts';
import type { Home } from './home.ts';
import { insideDirectory } from './migration-files.ts';
import type { MigrationRecord } from './migration-record.ts';

function accountRows(value: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(value.accounts) ? value.accounts as Record<string, unknown>[] : [];
}

/** Only entries changed in the old home are imported. Keep step-7 credential isolation. */
export function preserveAccountRelocations(home: Home, record: MigrationRecord, base: Record<string, unknown>,
  legacy: Record<string, unknown>, merged: Record<string, unknown>): void {
  if (!Array.isArray(merged.accounts) || isDeepStrictEqual(base.accounts, legacy.accounts)) return;
  const previous = new Map(accountRows(base).map(account => [account.id, account]));
  const imported = new Map(accountRows(legacy).filter(account => !isDeepStrictEqual(previous.get(account.id), account))
    .map(account => [account.id, account]));
  merged.accounts = accountRows(merged).map(account => {
    const source = imported.get(account.id);
    if (!source || typeof source.configDir !== 'string' || !insideDirectory(record.legacyRoot, expandTilde(source.configDir))) return account;
    const id = String(account.id);
    if (!AGENT_ACCOUNT_ID_RE.test(id)) throw new Error(`Cannot import account ${id}: invalid account ID.`);
    if (record.notMoved.some(entry => entry.id === id && entry.configDir === source.configDir
      && entry.reason === 'omp-profile-root-inside-legacy-home') && source.provider === 'omp') return account;
    const before = previous.get(id);
    const destination = join(home.data, 'accounts', id);
    const sameSource = typeof before?.configDir === 'string' && resolve(expandTilde(before.configDir)) === resolve(expandTilde(source.configDir));
    const relocated = record.files.some(entry => entry.target?.kind === 'data' && entry.target.path.startsWith(`accounts/${id}/`));
    // Empty account directories have no file mapping. Their migration-created destination,
    // original registry entry, and absence from deferredAccounts prove the same relocation.
    if (sameSource && !record.deferredAccounts.some(entry => entry.id === id) && (relocated || existsSync(destination))) {
      return { ...account, configDir: destination };
    }
    throw new Error(`Cannot import account ${id}: its configDir is inside the old home and has no completed relocation. Ignore this change or migrate the account first.`);
  });
}
