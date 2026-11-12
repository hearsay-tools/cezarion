import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { homeFileSchema } from '@open-mercato/cezar-contract/home-recovery';
import type { Home } from './home.ts';
import { registryFiles } from './entry-authorization.ts';
import { homeFileKind } from './file-location.ts';
import { digest } from './version-log.ts';
import { insideDirectory, migrationFiles } from './migration-files.ts';
import { accountInUse, accountMigrationPolicy, migrationAccountInventory, type MigrationAccount } from './migration-accounts.ts';
import { migrationRoots, type MigrationFile, type MigrationRecord } from './migration-record.ts';

export interface MigrationPlan {
  legacyRoot: string; roots: MigrationRecord['roots']; files: MigrationFile[];
  accounts: MigrationAccount[]; notMoved: MigrationRecord['notMoved'];
  deferredAccounts: MigrationRecord['deferredAccounts'];
  managedInstall: boolean; backup: string; empty: boolean;
}

const ignored = /^(?:install\.json(?:\.failed)?|MOVED\.json|\.locks|\.versions|\.migrating|tmp|dry-cache|dry-prefix)(?:\/|$)|(?:^|\/)[^/]*\.install\.lock$/;
export const archiveExcludes = /^(?:versions|bin|dry-cache|dry-prefix|tmp|\.locks|\.migrating)(?:\/|$)/;

/** Parse live cezar-owned JSON only. Historical snapshots and vendor trees are opaque bytes. */
export function isSquawkMigrationJson(path: string): boolean {
  if (path.split('/').includes('backups')) return false;
  return ['config.json', 'config.json.bak', 'agent-accounts.json', 'ui-state.json', 'server.json', 'migration.json'].includes(path)
    || /^(?:remote-settings|tracker-connections|server-instances|application-updates)\/.+\.json(?:\.bak)?$/.test(path);
}

function destination(path: string): MigrationFile['target'] {
  if (path.endsWith('.install.lock')) return null;
  if (homeFileSchema.safeParse(path).success) return { kind: homeFileKind(path), path };
  const nestedBackup = /^(remote-settings|server-instances)\/backups\/(.+)$/.exec(path);
  if (nestedBackup) return { kind: 'state', path: `backups/${nestedBackup[1]}/${nestedBackup[2]}` };
  if (/^(?:remote-settings|tracker-connections)\//.test(path)) return { kind: 'config', path };
  if (/^(?:backups|application-updates)\//.test(path)) return { kind: 'state', path };
  if (path.startsWith('versions/')) return { kind: 'data', path };
  return null;
}

/** The dry-run and real migration share this filesystem-only planner. It never creates journals. */
export function planLegacyMigration(legacy: Home, target: Home): MigrationPlan {
  if (target.layout !== 'split') throw new Error('Legacy migration requires an explicit split target');
  const legacyRoot = resolve(legacy.root);
  if (resolve(target.config) === legacyRoot) throw new Error('Migration target must differ from the legacy root');
  const { accounts, notMoved } = migrationAccountInventory(legacy, target);
  const targetRoots = Object.values(migrationRoots(target)).map(path => resolve(path));
  const keys = migrationFiles(legacy.root, key => ignored.test(key)
    || targetRoots.some(root => insideDirectory(legacyRoot, root) && insideDirectory(root, join(legacyRoot, key))));
  const files = keys.map(path => {
    const from = join(legacy.root, path), stat = lstatSync(from);
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(from)) : readFileSync(from);
    let mapped = destination(path);
    if (!mapped) {
      const account = accounts.find(account => accountMigrationPolicy(account) === 'copy' && insideDirectory(account.source, from));
      if (account) mapped = { kind: 'data', path: `accounts/${account.id}/${relative(account.source, from).split(sep).join('/')}` };
    }
    return { path, hash: digest(bytes), mtimeMs: stat.mtimeMs, target: mapped };
  });
  return { legacyRoot, roots: migrationRoots(target), files, accounts,
    deferredAccounts: accounts.filter(account => accountMigrationPolicy(account) === 'copy' && accountInUse(legacy, account.id))
      .map(account => ({ id: account.id, configDir: account.configDir })),
    notMoved: [...notMoved, ...accounts.filter(account => accountMigrationPolicy(account) === 'keep')
      .map(account => ({ id: account.id, configDir: account.configDir, reason: 'omp-profile-root-inside-legacy-home' as const }))],
    managedInstall: existsSync(legacy.versions),
    backup: join(target.backups, `legacy-cezar-home-${new Date().toISOString().replaceAll(':', '-')}.tar.gz`),
    empty: !registryFiles(legacy).some(path => existsSync(path)) && !existsSync(legacy.backups)
      && !existsSync(join(legacy.remoteSettings, 'backups')) && !existsSync(join(legacy.serverInstances, 'backups')) };
}

export function migrationRecordFor(plan: MigrationPlan): MigrationRecord {
  return { version: 1, legacyRoot: plan.legacyRoot, roots: plan.roots, files: plan.files,
    backup: plan.backup, createdAt: new Date().toISOString(), deferredAccounts: plan.deferredAccounts, notMoved: plan.notMoved };
}
