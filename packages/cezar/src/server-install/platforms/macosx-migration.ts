import { existsSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardLaunchdWrite, ownsLaunchdPlist, readLaunchdPlist } from './macosx-launchd-files.ts';
import type { InstallContext, PlatformMigrationReport, StepArtifact } from '../types.ts';
import { StepAborted } from '../steps.ts';

const emptyReport = (): PlatformMigrationReport => ({ moved: [], leftAloneForeign: [], errors: [] });
type Move = PlatformMigrationReport['moved'][number];

function label(xml: string): string | undefined {
  return xml.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
}

function relabel(xml: string, from: string, to: string): string {
  if (label(xml) !== from) throw new Error(`Unexpected launchd label (expected ${from})`);
  return xml.replace(/(<key>Label<\/key>\s*<string>)[^<]+(<\/string>)/, `$1${to}$2`);
}

export async function unloadLaunchd(ctx: InstallContext, name: string): Promise<void> {
  const target = `gui/${process.getuid?.() ?? 0}/${name}`;
  const result = await ctx.runner.capture('launchctl', ['bootout', target]);
  // launchctl returns nonzero for an already-unloaded job; prove it is absent.
  if (result.code !== 0 && (await ctx.runner.capture('launchctl', ['print', target])).code === 0) {
    throw new Error(`Could not unload ${name}: ${result.stderr}`);
  }
}

async function bootstrap(ctx: InstallContext, artifact: StepArtifact): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const code = await ctx.runner.interactive('launchctl', ['bootstrap', domain, artifact.path!]);
  const loaded = await ctx.runner.capture('launchctl', ['print', `${domain}/${artifact.name!}`]);
  if (code !== 0 || loaded.code !== 0) throw new Error(`Could not load ${artifact.name}`);
}

/** Keep the previous bytes as a private, durable rollback artifact. */
function backupPlist(path: string, xml: string): void {
  if (existsSync(path)) {
    if (readLaunchdPlist(path) !== xml || (lstatSync(path).mode & 0o777) !== 0o600) throw new Error(`Backup already exists: ${path}`);
    return;
  }
  writeFileSync(path, xml, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
}

/** Consume rollback state only after its bytes are restored to the active old path. */
function removeBackup(move: Move, xml: string): void {
  const path = move.backup!.path!;
  if (!existsSync(path)) return;
  if (readLaunchdPlist(path) !== xml) throw new Error(`Backup changed: ${path}`);
  rmSync(path);
}

async function movePlist(ctx: InstallContext, move: Move, xml: string): Promise<void> {
  const { from, to, backup } = move;
  if (guardLaunchdWrite(ctx, to) !== undefined) throw new Error(`Destination already exists: ${to.path}`);
  backupPlist(backup!.path!, xml);
  const nextXml = relabel(xml, from.name!, to.name!);
  let published = false;
  try {
    // Exclusive creation refuses a destination that appeared after preflight.
    writeFileSync(to.path!, nextXml, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
    published = true;
    await unloadLaunchd(ctx, from.name!);
    await bootstrap(ctx, to);
    rmSync(from.path!);
  } catch (error) {
    // Do not touch a destination we did not create, or whose bytes have changed.
    // The old job stays unloaded: the group starts it after the home rolls back, so it reads the legacy home.
    if (published) {
      guardLaunchdWrite(ctx, to, { selected: to, expectedXml: nextXml });
      await unloadLaunchd(ctx, to.name!);
      rmSync(to.path!);
    }
    removeBackup(move, xml);
    throw error;
  }
}

/** Migrate only provably owned legacy agents. State and persistence belong to the caller. */
export async function migrateLaunchd(ctx: InstallContext, dir: string): Promise<PlatformMigrationReport> {
  const report = emptyReport();
  const details: string[] = [];
  for (const [stepId, agent] of [['autostart', 'cockpit'], ['ngrok', 'ngrok']] as const) {
    const from: StepArtifact = { kind: 'owned', type: 'launchd', name: `ai.cezar.${agent}`, path: join(dir, `ai.cezar.${agent}.plist`) };
    if (!existsSync(from.path!)) continue;
    try {
      const xml = readLaunchdPlist(from.path!);
      if (!ownsLaunchdPlist(ctx, from, xml)) {
        report.leftAloneForeign.push({ ...from, kind: 'shared' });
        details.push(`launchd ${from.name} left alone: ${from.path} is not ours`);
        continue;
      }
      if (!ctx.state.steps[stepId]) throw new Error(`Unknown migration step: ${stepId}`);
      const to: StepArtifact = { ...from, name: `tools.hearsay.squawk.${agent}`, path: join(dir, `tools.hearsay.squawk.${agent}.plist`) };
      const backup: StepArtifact = { kind: 'owned', type: 'file', path: `${from.path}.migrated` };
      const move: Move = { stepId, from, to, backup };
      // Validate the same collision and label cases in dry runs.
      relabel(xml, from.name!, to.name!);
      if (guardLaunchdWrite(ctx, to) !== undefined) throw new Error(`Destination already exists: ${to.path}`);
      if (!ctx.dryRun) await movePlist(ctx, move, xml);
      report.moved.push(move);
      details.push(`launchd ${from.name} → ${to.name} (${to.path}; old plist kept as ${backup.path})`);
    } catch (error) {
      report.errors.push({ artifact: from, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (details.length) report.details = details;
  return report;
}

function inspectRollback(ctx: InstallContext, move: Move): { xml: string; restoreFile: boolean; complete: boolean } {
  const { from, to, backup } = move;
  if (from.kind !== 'owned' || to.kind !== 'owned' || from.type !== 'launchd' ||
      !from.name?.startsWith('ai.cezar.') || to.name !== from.name.replace('ai.cezar.', 'tools.hearsay.squawk.') ||
      backup?.path !== `${from.path}.migrated`) throw new Error('Invalid launchd rollback entry');
  if (!existsSync(backup.path) && existsSync(from.path!) && !existsSync(to.path!)) {
    readLaunchdPlist(from.path!);
    return { xml: '', restoreFile: false, complete: true };
  }
  const xml = readLaunchdPlist(backup.path);
  const nextXml = relabel(xml, from.name, to.name);
  const restoreFile = !existsSync(from.path!);
  if (!restoreFile) {
    if (readLaunchdPlist(from.path!) !== xml) throw new Error(`Original path is occupied: ${from.path}`);
    if (!existsSync(to.path!)) return { xml, restoreFile, complete: true };
  }
  guardLaunchdWrite(ctx, from, { selected: from, expectedXml: xml });
  if (guardLaunchdWrite(ctx, to, { selected: to, expectedXml: nextXml }) === undefined) throw new Error(`Destination plist missing: ${to.path}`);
  return { xml, restoreFile, complete: false };
}

async function isLoaded(ctx: InstallContext, artifact: StepArtifact): Promise<boolean> {
  const target = `gui/${process.getuid?.() ?? 0}/${artifact.name!}`;
  return (await ctx.runner.capture('launchctl', ['print', target])).code === 0;
}

async function restorePlist(ctx: InstallContext, move: Move): Promise<boolean> {
  const { from, to } = move;
  const { xml, restoreFile, complete } = inspectRollback(ctx, move);
  if (complete) {
    if (!ctx.dryRun && existsSync(move.backup!.path!)) removeBackup(move, xml);
    return false;
  }
  if (ctx.dryRun) return true;
  if (restoreFile) writeFileSync(from.path!, xml, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
  try {
    // Restore only the file. The group starts the old job after the home rolls back: loaded now,
    // it would resolve the still-pending target home and keep serving it.
    await unloadLaunchd(ctx, to.name!);
    rmSync(to.path!);
  } catch (error) {
    if (restoreFile) rmSync(from.path!);
    if (!(await isLoaded(ctx, to))) await bootstrap(ctx, to);
    throw error;
  }
  removeBackup(move, xml);
  return true;
}

export async function rollbackLaunchdMigration(ctx: InstallContext, migrated: PlatformMigrationReport): Promise<PlatformMigrationReport> {
  const report = emptyReport();
  for (const move of [...migrated.moved].reverse()) {
    try {
      if (await restorePlist(ctx, move)) report.moved.push({ stepId: move.stepId, from: move.to, to: move.from, ...(move.backup ? { backup: move.backup } : {}) });
    } catch (error) {
      report.errors.push({ artifact: move.to, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

/** An agent whose plist the ledger records or whose launcher proves it ours. */
export type LaunchdService = StepArtifact & { name: string; path: string; role: 'cockpit' | 'ngrok' };

const NGROK_API = 'http://localhost:4040/api/tunnels';
/** Each probe is bounded: a socket that accepts and never answers must not block the group before rollback. */
const PROBE_SECONDS = '2';
/** Polls one second apart. The tunnel connects after the cockpit is up, so it gets about 30 s. */
const COCKPIT_POLLS = 15;
const TUNNEL_POLLS = 30;

/** One line per service for the dry-run plan; names are the post-migration labels. */
export function launchdHealthDetails(services: LaunchdService[], port: number): string[] {
  return services.map((s) => `health check: ${s.name} is loaded and ${s.role === 'cockpit'
    ? `http://127.0.0.1:${port}/ answers` : `the ngrok API at ${NGROK_API} lists a tunnel`}`);
}

/** `server-migrate` stop: boot out every owned agent. Foreign agents are never in the list. */
export async function stopLaunchdServices(ctx: InstallContext, services: LaunchdService[]): Promise<void> {
  for (const service of services) {
    if (ctx.dryRun) ctx.ui.info(`DRY RUN — would launchctl bootout ${service.name}.`);
    else await unloadLaunchd(ctx, service.name);
  }
}

/** `sleep 1` through the runner keeps the poll testable without real timers. */
async function poll(ctx: InstallContext, attempts: number, probe: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probe()) return true;
    if (i < attempts - 1) await ctx.runner.capture('sh', ['-c', 'sleep 1']);
  }
  return false;
}

/** `server-migrate` start: load each agent that is not loaded, then check the cockpit port and the tunnel. */
export async function startLaunchdServices(ctx: InstallContext, services: LaunchdService[], port: number): Promise<void> {
  if (ctx.dryRun) {
    for (const line of launchdHealthDetails(services, port)) ctx.ui.info(`DRY RUN — would load and check: ${line}`);
    return;
  }
  for (const service of services) {
    if (!existsSync(service.path)) throw new StepAborted(`Recorded launchd plist missing: ${service.path}`);
    // Always a fresh process: a job loaded earlier may have resolved a home that has since changed state.
    await unloadLaunchd(ctx, service.name);
    await bootstrap(ctx, service);
  }
  for (const service of services) {
    const up = service.role === 'cockpit'
      ? await poll(ctx, COCKPIT_POLLS, async () => {
        const code = (await ctx.runner.capture('curl', ['-s', '--max-time', PROBE_SECONDS, '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}/`])).stdout.trim();
        return code !== '' && code !== '000';
      })
      : await poll(ctx, TUNNEL_POLLS, async () => (await ctx.runner.capture('curl', ['-s', '--max-time', PROBE_SECONDS, NGROK_API])).stdout.includes('public_url'));
    if (!up) throw new StepAborted(service.role === 'cockpit' ? `${service.name} did not answer on port ${port}` : `${service.name}: the ngrok API lists no tunnel`);
  }
}
