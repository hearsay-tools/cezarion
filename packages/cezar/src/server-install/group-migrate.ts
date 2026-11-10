import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Home } from '../home/home.ts';
import { readInstallMarker } from '../home/install-marker.ts';
import { commitLegacyMigration, migrateLegacyHome, rollbackLegacyMigration } from '../home/migrate.ts';
import { planLegacyMigration } from '../home/migration-plan.ts';
import { withInstallLocks } from './engine.ts';
import { applyMigrationReport } from './migration-report.ts';
import { readServerMigrateJournal, removeServerMigrateJournal, writeServerMigrateJournal, type ServerMigrateJournal } from './migrate-journal.ts';
import { listServerInstances, loadServerState, saveServerState } from './state.ts';
import { defaultRunner } from './steps.ts';
import { supportsServerMigration } from './strategies.ts';
import type { InstallContext, PlatformMigrationReport, PlatformStrategy, Runner, ServerState, Ui } from './types.ts';

/**
 * `server-migrate` (spec 2026-11-06 §4 "Server installs"). The instances recorded in one home form
 * one group: stop all, stage the home with `migrateLegacyHome(..., { commit: false })`, move each
 * platform's resources, start and check every instance, then commit. Any failure rolls the whole
 * group back to the old units, sites and legacy home. Ledgers change only after the commit.
 */

export interface ServerMigrateOptions {
  legacy: Home;
  target: Home;
  strategy: (platform: string) => PlatformStrategy | undefined;
  dryRun: boolean;
  assumeYes: boolean;
  repoRoot: string;
  now: string;
  ui: Ui;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
}

export type ServerMigrateStatus = 'migrated' | 'unchanged' | 'planned' | 'rolled-back' | 'failed';
export interface ServerMigrateResult { status: ServerMigrateStatus; lines: string[] }

interface Member {
  instance: string;
  state: ServerState;
  strategy: Required<Pick<PlatformStrategy, 'migrate' | 'rollbackMigration' | 'stopService' | 'startService'>>;
  planned: PlatformMigrationReport;
  moved?: PlatformMigrationReport | undefined;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const pending = (target: Home) => readInstallMarker(target.config)?.state === 'pending';
const committed = (target: Home) => readInstallMarker(target.config)?.state === 'committed';

class Group {
  readonly lines: string[] = [];
  /** True once this run staged the home; its commit is then this run's to finish. */
  staged = false;
  private readonly prefs: InstallContext['prefs'] = {};
  constructor(readonly opts: ServerMigrateOptions, readonly records: Home) {}

  /** Planning cannot seed a version log or recover a journal as a side effect of reading. */
  instances() {
    return listServerInstances(this.records, this.opts.dryRun ? path => readFileSync(path, 'utf8') : undefined);
  }

  say(line: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.lines.push(line);
    this.opts.ui[level](line);
  }

  /** A migration context never saves: P2d strategies report moves and the group persists them. */
  context(instance: string, state: ServerState, dryRun = this.opts.dryRun): InstallContext {
    return { home: this.records, state: structuredClone(state), ui: this.opts.ui, runner: this.opts.runner ?? defaultRunner, instance,
      save: async () => {}, dryRun, assumeYes: this.opts.assumeYes, reconfigure: new Set(), repoRoot: this.opts.repoRoot, now: this.opts.now, prefs: this.prefs };
  }

  migratedContext(member: Member): InstallContext {
    return this.context(member.instance, applyMigrationReport(member.state, member.moved ?? member.planned), false);
  }

  member(instance: string, state: ServerState): Member['strategy'] | string {
    const strategy = this.opts.strategy(state.platform ?? '');
    if (!supportsServerMigration(strategy)) {
      return `${instance}: server-migrate does not support platform ${state.platform ?? 'unknown'}`;
    }
    return strategy;
  }
}

/** Every completed install in the records home, with its dry-run plan. Refusals change nothing. */
async function planGroup(group: Group): Promise<{ members: Member[]; errors: string[] }> {
  const members: Member[] = [];
  const errors: string[] = [];
  for (const { instance, state } of group.instances()) {
    if (!state.installed || state.dryRun) { group.say(`${instance}: not a completed install — left as is`); continue; }
    const strategy = group.member(instance, state);
    if (typeof strategy === 'string') { errors.push(strategy); continue; }
    const planned = await strategy.migrate(group.context(instance, state, true));
    errors.push(...planned.errors.map(e => `${instance}: ${e.artifact.path ?? e.artifact.name ?? e.artifact.type}: ${e.message}`));
    members.push({ instance, state, strategy, planned });
  }
  return { members, errors };
}

function describePlan(group: Group, members: Member[]): void {
  const { legacy, target } = group.opts;
  const names = members.map(m => m.instance).join(', ');
  const homeCommitted = committed(target);
  group.say(`stop: every instance that shares this home stops first (${names})`);
  if (homeCommitted) group.say(`home: already migrated to ${target.config}`);
  else {
    const plan = planLegacyMigration(legacy, target);
    group.say(`home: ${legacy.root} → config ${target.config}, state ${target.state}, data ${target.data} (${plan.files.length} files copied; the legacy home stays)`);
  }
  for (const { instance, planned } of members) {
    // A platform's details name each of its moves; the raw moves print only when it gives none.
    const lines = planned.details?.length ? planned.details : planned.moved.map(({ stepId, from, to }) => `${stepId} ${from.path ?? from.name} → ${to.path ?? to.name}`);
    for (const line of lines) group.say(`${instance}: ${line}`);
  }
  group.say(`group: ${names} succeed or fail together. Each instance starts under its new name and passes its health check before the group commits.`);
  if (!homeCommitted) group.say(`marker: ${join(target.config, 'install.json')} stays pending (the new home is read-only) until every instance passes, then commits.`);
  group.say(`rollback: any failure restores every old unit and site, starts the old services${homeCommitted ? '' : ' and renames the marker to install.json.failed; the legacy home stays in use'}.`);
}

function journalFor(group: Group, members: Member[], phase: ServerMigrateJournal['phase']): ServerMigrateJournal {
  return { version: 1, phase, stagedHome: group.staged, instances: members.map(({ instance, planned, moved }) => ({ instance, planned, ...(moved ? { moved } : {}) })) };
}

/** The home marker is committed by now; apply the ledgers. Recovery also finishes the home's
 *  publication (MOVED.json, PATH), which commitLegacyMigration repeats safely. */
function commitGroup(group: Group, members: Array<Pick<Member, 'instance' | 'state' | 'moved'>>, finishHome: boolean): void {
  const { target, env, now } = group.opts;
  if (finishHome) commitLegacyMigration(target, env);
  for (const { instance, state, moved } of members) {
    if (moved) saveServerState({ ...applyMigrationReport(state, moved), updatedAt: now }, instance, target);
  }
  removeServerMigrateJournal(target);
}

/** Reverse every planned move from disk state, then the home. Start only fully restored instances. */
async function rollbackGroup(group: Group, members: Member[]): Promise<boolean> {
  const { target } = group.opts;
  if (readServerMigrateJournal(target) && readInstallMarker(target.config)) writeServerMigrateJournal(target, journalFor(group, members, 'rolling-back'));
  const restored: Member[] = [];
  for (const member of [...members].reverse()) {
    const report = await member.strategy.rollbackMigration(group.context(member.instance, member.state, false), member.planned);
    for (const error of report.errors) group.say(`${member.instance}: rollback of ${error.artifact.path ?? error.artifact.name}: ${error.message}`, 'error');
    if (!report.errors.length) restored.push(member);
  }
  const complete = restored.length === members.length;
  if (complete) {
    removeServerMigrateJournal(target);
    if (pending(target)) rollbackLegacyMigration(target);
  } else group.say('The rollback is incomplete. Re-run server-migrate to finish it.', 'error');
  for (const member of restored.reverse()) {
    try { await member.strategy.startService(group.context(member.instance, member.state, false)); }
    catch (error) { group.say(`${member.instance}: the restored service did not pass its check: ${message(error)}`, 'warn'); }
  }
  return complete;
}

/** Finish or reverse an interrupted run before planning a new one. */
async function recover(group: Group, journal: ServerMigrateJournal): Promise<'committed' | 'rolled-back' | 'failed'> {
  const { target } = group.opts;
  const loaded = journal.instances.map(({ instance, planned, moved }) => ({ instance, planned, moved, state: loadServerState(instance, group.records) }));
  // A staged home whose marker committed belongs to a group that passed every check.
  if (journal.phase === 'committing' || (journal.stagedHome && committed(target))) {
    group.say('Finishing an interrupted server-migrate commit.');
    commitGroup(group, loaded, journal.stagedHome);
    return 'committed';
  }
  group.say('Rolling back an interrupted server-migrate run.');
  const members: Member[] = [];
  for (const entry of loaded) {
    const strategy = group.member(entry.instance, entry.state);
    if (typeof strategy === 'string') { group.say(strategy, 'error'); return 'failed'; }
    members.push({ ...entry, strategy });
  }
  if (!members.length && pending(target)) rollbackLegacyMigration(target);
  return await rollbackGroup(group, members) ? 'rolled-back' : 'failed';
}

async function stopAll(group: Group, members: Member[]): Promise<void> {
  for (const member of members) await member.strategy.stopService(group.context(member.instance, member.state, false));
}

async function moveAndCheck(group: Group, members: Member[]): Promise<void> {
  const { legacy, target, env } = group.opts;
  if (!committed(target)) {
    const staged = migrateLegacyHome(legacy, target, { commit: false, ...(env ? { env } : {}) });
    if (staged.status !== 'pending') throw new Error(`Expected a staged home, got ${staged.status}`);
    group.staged = true;
  }
  writeServerMigrateJournal(target, journalFor(group, members, 'migrating'));
  for (const member of members) {
    member.moved = await member.strategy.migrate(group.context(member.instance, member.state, false));
    writeServerMigrateJournal(target, journalFor(group, members, 'migrating'));
    const [error] = member.moved.errors;
    if (error) throw new Error(`${member.instance}: ${error.artifact.path ?? error.artifact.name}: ${error.message}`);
  }
  for (const member of members) {
    group.say(`${member.instance}: checking health`);
    await member.strategy.startService(group.migratedContext(member), { probeAuth: true });
  }
  // The last refusal point: a legacy write during the checks refuses here and rolls the group back.
  if (pending(target)) commitLegacyMigration(target, env);
  writeServerMigrateJournal(target, journalFor(group, members, 'committing'));
}

async function migrateGroup(group: Group): Promise<ServerMigrateStatus> {
  const journal = readServerMigrateJournal(group.opts.target);
  if (journal && !group.opts.dryRun) {
    const recovered = await recover(group, journal);
    if (recovered !== 'rolled-back') return recovered === 'committed' ? 'migrated' : 'failed';
  }
  const { members, errors } = await planGroup(group);
  for (const error of errors) group.say(error, 'error');
  if (errors.length) return 'failed';
  if (!members.length) { group.say(`No completed server install is recorded in ${group.records.root}.`); return 'unchanged'; }
  if (committed(group.opts.target) && members.every(m => !m.planned.moved.length)) {
    group.say('Every server install already uses the new names. Nothing to migrate.');
    return 'unchanged';
  }
  describePlan(group, members);
  if (group.opts.dryRun) return 'planned';
  try {
    await stopAll(group, members);
    await moveAndCheck(group, members);
  } catch (error) {
    if (!(group.staged && committed(group.opts.target))) {
      group.say(`server-migrate failed: ${message(error)}. Rolling back every instance.`, 'error');
      return await rollbackGroup(group, members) ? 'rolled-back' : 'failed';
    }
    // The home committed after every check passed: finish forward, never roll a committed home back.
    group.say(`server-migrate committed the home, then failed: ${message(error)}. Finishing the commit.`, 'warn');
    commitGroup(group, members, true);
    return 'migrated';
  }
  commitGroup(group, members, false);
  group.say(`Migrated ${members.length} server install${members.length === 1 ? '' : 's'}.`, 'info');
  return 'migrated';
}

export async function runServerMigrate(opts: ServerMigrateOptions): Promise<ServerMigrateResult> {
  // Until the home commits, the legacy home holds the authoritative server records and locks.
  const records = committed(opts.target) ? opts.target : opts.legacy;
  const group = new Group(opts, records);
  // A dry run only reads: it takes no install lock, because a lock is a home write.
  const instances = group.instances().map(i => i.instance);
  const status = opts.dryRun ? await migrateGroup(group) : await withInstallLocks(instances, records, () => migrateGroup(group));
  return { status, lines: group.lines };
}
