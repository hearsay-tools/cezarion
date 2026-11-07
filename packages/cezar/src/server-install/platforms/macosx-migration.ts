import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstallContext, PlatformMigrationReport, StepArtifact } from '../types.ts';

const emptyReport = (): PlatformMigrationReport => ({ moved: [], leftAloneForeign: [], errors: [] });
type Move = PlatformMigrationReport['moved'][number];

function label(xml: string): string | undefined {
  return xml.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
}

function relabel(xml: string, from: string, to: string): string {
  if (label(xml) !== from) throw new Error(`Unexpected launchd label (expected ${from})`);
  return xml.replace(/(<key>Label<\/key>\s*<string>)[^<]+(<\/string>)/, `$1${to}$2`);
}

function readPlist(path: string): string {
  if (!lstatSync(path).isFile()) throw new Error(`Refusing non-regular plist: ${path}`);
  return readFileSync(path, 'utf8');
}

/** Only the exact installer launch forms establish ownership without a ledger. */
function isOurLauncher(xml: string): boolean {
  const inner = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
  const args = [...inner.matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((m) => m[1]!.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
  const serve = args.indexOf('serve');
  if (serve < 1) return false;
  const command = args.slice(0, serve);
  if (basename(command[0]!) === 'npx') return command.length === 3 && command[1] === '--yes' && command[2] === 'cezarion';
  if (command.length !== 2 || !/^node(?:\.exe)?$/.test(basename(command[0]!))) return false;
  const entry = command[1]!;
  const ownEntry = resolve(fileURLToPath(new URL('../../../dist/index.js', import.meta.url)));
  return entry === ownEntry || ['cezarion', 'cez'].includes(basename(entry));
}

function isRecorded(ctx: InstallContext, stepId: string, from: StepArtifact): boolean {
  return ctx.state.steps[stepId]?.created?.artifacts.some((a) =>
    a.kind === 'owned' && a.type === from.type && a.name === from.name && a.path === from.path) ?? false;
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
    if (readPlist(path) !== xml || (lstatSync(path).mode & 0o777) !== 0o600) throw new Error(`Backup already exists: ${path}`);
    return;
  }
  writeFileSync(path, xml, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
}

async function movePlist(ctx: InstallContext, move: Move, xml: string): Promise<void> {
  const { from, to, backup } = move;
  if (existsSync(to.path!)) throw new Error(`Destination already exists: ${to.path}`);
  backupPlist(backup!.path!, xml);
  const nextXml = relabel(xml, from.name!, to.name!);
  // Exclusive creation refuses another install's plist, even if it appeared after preflight.
  writeFileSync(to.path!, nextXml, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
  try {
    await unloadLaunchd(ctx, from.name!);
    await bootstrap(ctx, to);
    rmSync(from.path!);
  } catch (error) {
    // An unsuccessful move leaves the original ledger valid.
    await unloadLaunchd(ctx, to.name!);
    rmSync(to.path!);
    await bootstrap(ctx, from);
    throw error;
  }
}

/** Migrate only provably owned legacy agents. State and persistence belong to the caller. */
export async function migrateLaunchd(ctx: InstallContext, dir: string, rebrand: boolean): Promise<PlatformMigrationReport> {
  const report = emptyReport();
  if (!rebrand) return report;
  for (const [stepId, agent] of [['autostart', 'cockpit'], ['ngrok', 'ngrok']] as const) {
    const from: StepArtifact = { kind: 'owned', type: 'launchd', name: `ai.cezar.${agent}`, path: join(dir, `ai.cezar.${agent}.plist`) };
    if (!existsSync(from.path!)) continue;
    try {
      const xml = readPlist(from.path!);
      if (!isRecorded(ctx, stepId, from) && !(agent === 'cockpit' && isOurLauncher(xml))) {
        report.leftAloneForeign.push({ ...from, kind: 'shared' });
        continue;
      }
      const to: StepArtifact = { ...from, name: `tools.hearsay.squawk.${agent}`, path: join(dir, `tools.hearsay.squawk.${agent}.plist`) };
      const backup: StepArtifact = { kind: 'owned', type: 'file', path: `${from.path}.migrated` };
      const move: Move = { stepId, from, to, backup };
      // Validate the same collision and label cases in dry runs.
      relabel(xml, from.name!, to.name!);
      if (existsSync(to.path!)) throw new Error(`Destination already exists: ${to.path}`);
      if (!ctx.dryRun) await movePlist(ctx, move, xml);
      report.moved.push(move);
    } catch (error) {
      report.errors.push({ artifact: from, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

function inspectRollback(move: Move): { xml: string; restoreFile: boolean; complete: boolean } {
  const { from, to, backup } = move;
  if (from.kind !== 'owned' || to.kind !== 'owned' || from.type !== 'launchd' ||
      !from.name?.startsWith('ai.cezar.') || to.name !== from.name.replace('ai.cezar.', 'tools.hearsay.squawk.') ||
      backup?.path !== `${from.path}.migrated`) throw new Error('Invalid launchd rollback entry');
  const xml = readPlist(backup.path);
  const nextXml = relabel(xml, from.name, to.name);
  const restoreFile = !existsSync(from.path!);
  if (!restoreFile) {
    if (readPlist(from.path!) !== xml) throw new Error(`Original path is occupied: ${from.path}`);
    if (!existsSync(to.path!)) return { xml, restoreFile, complete: true };
  }
  if (readPlist(to.path!) !== nextXml) throw new Error(`Destination plist changed: ${to.path}`);
  return { xml, restoreFile, complete: false };
}

async function isLoaded(ctx: InstallContext, artifact: StepArtifact): Promise<boolean> {
  const target = `gui/${process.getuid?.() ?? 0}/${artifact.name!}`;
  return (await ctx.runner.capture('launchctl', ['print', target])).code === 0;
}

async function restorePlist(ctx: InstallContext, move: Move): Promise<boolean> {
  const { from, to } = move;
  const { xml, restoreFile, complete } = inspectRollback(move);
  if (complete) return false;
  if (ctx.dryRun) return true;
  const oldLoaded = await isLoaded(ctx, from);
  if (restoreFile) writeFileSync(from.path!, xml, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
  try {
    await unloadLaunchd(ctx, to.name!);
    // A prior attempt can have restored and loaded the old job already.
    if (!oldLoaded) await bootstrap(ctx, from);
    rmSync(to.path!);
  } catch (error) {
    if (!oldLoaded) await unloadLaunchd(ctx, from.name!);
    if (restoreFile) rmSync(from.path!);
    if (!(await isLoaded(ctx, to))) await bootstrap(ctx, to);
    throw error;
  }
  return true;
}

export async function rollbackLaunchdMigration(ctx: InstallContext, migrated: PlatformMigrationReport, rebrand: boolean): Promise<PlatformMigrationReport> {
  const report = emptyReport();
  if (!rebrand) return report;
  for (const move of [...migrated.moved].reverse()) {
    try {
      if (await restorePlist(ctx, move)) report.moved.push({ stepId: move.stepId, from: move.to, to: move.from, ...(move.backup ? { backup: move.backup } : {}) });
    } catch (error) {
      report.errors.push({ artifact: move.to, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
