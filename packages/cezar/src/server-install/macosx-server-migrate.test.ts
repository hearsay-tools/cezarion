import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { readInstallMarker } from '../home/install-marker.ts';
import { prepareMigrationHome } from '../home/migration-boot.ts';
import { migrationFixture } from '../home/migration.testkit.ts';
import { cleanStoreRoots } from '../home/store.testkit.ts';
import { runServerMigrate } from './group-migrate.ts';
import { readServerMigrateJournal } from './migrate-journal.ts';
import { squawkLaunchdPlist, createMacosxNgrok, launchdPlist } from './platforms/macosx-ngrok.ts';
import { loadServerState } from './state.ts';
import { getStrategy, supportsServerMigration } from './strategies.ts';
import { createAutoUi } from './ui.ts';
import { STEP_STATUSES, type CommandResult, type InstallContext, type PlatformStrategy, type Runner, type ServerState } from './types.ts';

afterEach(() => { cleanStoreRoots(); vi.restoreAllMocks(); });

const done = STEP_STATUSES[1];
const OLD = ['ai.cezar.cockpit', 'ai.cezar.ngrok'];
const NEW = ['tools.hearsay.squawk.cockpit', 'tools.hearsay.squawk.ngrok'];
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

/** launchctl, curl and sleep as the macOS strategy sees them. Never the real launchctl. */
class FakeLaunchd implements Runner {
  readonly loaded = new Set<string>();
  readonly unhealthy = new Set<string>();
  readonly failBootout = new Set<string>();
  readonly failBootstrap = new Set<string>();
  /** Labels whose bootstrap loads the job and still exits nonzero. */
  readonly loadThenFail = new Set<string>();
  readonly commands: string[][] = [];
  /** Runs at each bootstrap, before the job loads: what the new process would read. */
  onBootstrap: (label: string) => void = () => {};
  /** Every probe socket accepts and never answers; only curl --max-time returns (exit 28). */
  hang = false;
  /** The ngrok API lists no tunnel for this many requests. */
  tunnelAfter = 0;
  private tunnelRequests = 0;

  private up(agent: 'cockpit' | 'ngrok'): boolean {
    return [...this.loaded].some(label => label.endsWith(`.${agent}`) && !this.unhealthy.has(label));
  }

  async capture(program: string, args: string[]): Promise<CommandResult> {
    this.commands.push([program, ...args]);
    const label = args[1]?.split('/').pop() ?? '';
    if (program === 'launchctl' && args[0] === 'bootout') {
      if (this.failBootout.has(label)) return { code: 5, stdout: '', stderr: 'Operation not permitted' };
      this.loaded.delete(label);
      return ok();
    }
    if (program === 'launchctl' && args[0] === 'print') return { code: this.loaded.has(label) ? 0 : 113, stdout: '', stderr: '' };
    const status = args.includes('%{http_code}');
    if (program === 'curl' && this.hang) {
      return args.includes('--max-time') ? { code: 28, stdout: status ? '000' : '', stderr: '' } : new Promise<CommandResult>(() => {});
    }
    if (program === 'curl' && status) return ok(this.up('cockpit') ? '200' : '000');
    if (program === 'curl') return ok(this.up('ngrok') && ++this.tunnelRequests > this.tunnelAfter ? '{"tunnels":[{"public_url":"https://x"}]}' : '');
    if (program === 'sh') return ok();
    throw new Error(`unexpected command: ${program} ${args.join(' ')}`);
  }

  async interactive(program: string, args: string[]): Promise<number> {
    this.commands.push([program, ...args]);
    if (program !== 'launchctl' || args[0] !== 'bootstrap') throw new Error(`unexpected command: ${program} ${args.join(' ')}`);
    const label = readFileSync(args[2]!, 'utf8').match(/<key>Label<\/key>\s*<string>([^<]+)/)![1]!;
    this.onBootstrap(label);
    if (this.failBootstrap.has(label)) return 5;
    this.loaded.add(label);
    return this.loadThenFail.has(label) ? 5 : 0;
  }

  launchctl(): string[][] {
    return this.commands.filter(c => c[0] === 'launchctl' && c[1] !== 'print');
  }
}

/** The group engine builds its own contexts; point them at a scratch LaunchAgents directory. */
function inDirectory(base: PlatformStrategy, dir: string): PlatformStrategy {
  const at = (ctx: InstallContext): InstallContext => ({ ...ctx, launchAgentsDir: () => dir });
  return {
    ...base,
    migrate: ctx => base.migrate!(at(ctx)),
    rollbackMigration: (ctx, report) => base.rollbackMigration!(at(ctx), report),
    stopService: ctx => base.stopService!(at(ctx)),
    startService: (ctx, opts) => base.startService!(at(ctx), opts),
  };
}

/** A plist as an install made before the rename wrote it: the old label. */
const legacyLabel = (xml: string) => xml.replaceAll('tools.hearsay.squawk.', 'ai.cezar.');

/** A completed pre-rename macOS install: both agents loaded and recorded, unless `ngrokRecorded` is false. */
function macInstall({ ngrokRecorded = true } = {}) {
  const f = migrationFixture();
  const dir = join(f.directory, 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  const launchd = new FakeLaunchd();
  const plist = (label: string) => join(dir, `${label}.plist`);
  writeFileSync(plist(OLD[0]!), legacyLabel(squawkLaunchdPlist('/repo', 4321, ['/n/npx', '--yes', 'cezarion'])), { mode: 0o600 });
  writeFileSync(plist(OLD[1]!), legacyLabel(launchdPlist(4321, 'ops:secret', 'cockpit.ngrok.app', '/opt/homebrew/bin/ngrok')), { mode: 0o600 });
  for (const label of OLD) launchd.loaded.add(label);
  const agent = (label: string) => ({ kind: 'owned' as const, type: 'launchd', name: label, path: plist(label) });
  const state: ServerState = {
    schema: 1, platform: 'macosx-ngrok', instance: 'default', installed: true, primaryPort: 4321, publicUrl: 'https://cockpit.ngrok.app', ephemeral: false,
    steps: {
      deps: { status: done, created: { artifacts: [] } },
      autostart: { status: done, created: { artifacts: [agent(OLD[0]!)] } },
      ngrok: { status: done, created: ngrokRecorded ? { artifacts: [{ kind: 'shared', type: 'ngrok-config', name: 'authtoken' }, agent(OLD[1]!)] } : null },
      identity: { status: done, created: { artifacts: [] } },
    },
  } as ServerState;
  Home.seed(f.legacy, f.legacy.serverState('default'), state);
  const bytes = Object.fromEntries(OLD.map(label => [label, readFileSync(plist(label), 'utf8')]));
  return { ...f, dir, launchd, plist, bytes };
}
type MacInstall = ReturnType<typeof macInstall>;

/** Every file under the target home with its bytes: proves a run wrote nothing there. */
function snapshot(root: string): Array<[string, string]> {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()
    .filter(path => statSync(join(root, path)).isFile())
    .map(path => [path, readFileSync(join(root, path), 'base64')]);
}

function serverMigrate(f: MacInstall, { dryRun = false } = {}) {
  const strategy = inDirectory(createMacosxNgrok(), f.dir);
  return runServerMigrate({
    legacy: f.legacy, target: f.target, strategy: () => strategy, dryRun, assumeYes: true, repoRoot: '/repo',
    now: '2026-11-11T00:00:00.000Z', ui: createAutoUi({}, () => {}), runner: f.launchd, env: f.env,
  });
}

function expectOldAgents(f: MacInstall, { staged }: { staged: boolean }): void {
  expect(f.launchd.loaded).toEqual(new Set(OLD));
  for (const label of OLD) {
    expect(readFileSync(f.plist(label), 'utf8')).toBe(f.bytes[label]);
    expect(existsSync(`${f.plist(label)}.migrated`)).toBe(false);
  }
  for (const label of NEW) expect(existsSync(f.plist(label))).toBe(false);
  expect(readInstallMarker(f.target.config)?.state).toBeUndefined();
  expect(existsSync(join(f.target.config, 'install.json.failed'))).toBe(staged);
  expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(false);
  expect(readServerMigrateJournal(f.target)).toBeUndefined();
  expect(loadServerState('default', f.legacy).steps.autostart!.created!.artifacts[0]!.name).toBe(OLD[0]);
}

function expectNewAgents(f: MacInstall): void {
  expect(f.launchd.loaded).toEqual(new Set(NEW));
  for (const label of OLD) {
    expect(existsSync(f.plist(label))).toBe(false);
    expect(readFileSync(`${f.plist(label)}.migrated`, 'utf8')).toBe(f.bytes[label]);
  }
  expect(readInstallMarker(f.target.config)?.state).toBe('committed');
  expect(readServerMigrateJournal(f.target)).toBeUndefined();
  const steps = loadServerState('default', f.target).steps;
  expect(steps.autostart!.created!.artifacts).toEqual([{ kind: 'owned', type: 'launchd', name: NEW[0], path: f.plist(NEW[0]!) }]);
  expect(steps.ngrok!.created!.artifacts.find(a => a.type === 'launchd')).toEqual({ kind: 'owned', type: 'launchd', name: NEW[1], path: f.plist(NEW[1]!) });
}

describe('hsq server-migrate on macOS (launchd)', () => {
  it('boots out the old labels, moves the home and both agents, checks health, then commits', async () => {
    const f = macInstall();
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expectNewAgents(f);
    expect(f.launchd.launchctl().slice(0, 2).map(c => c.slice(1, 2).concat(c[2]!.split('/').pop()!)))
      .toEqual([['bootout', OLD[0]], ['bootout', OLD[1]]]);
    expect(f.launchd.commands).toContainEqual(['curl', '-s', '--max-time', '2', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:4321/']);
    expect(f.launchd.commands).toContainEqual(['curl', '-s', '--max-time', '2', 'http://localhost:4040/api/tunnels']);
  });

  it('is a no-op on a rerun after success', async () => {
    const f = macInstall();
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    const commands = f.launchd.commands.length;
    const result = await serverMigrate(f);
    expect(result).toMatchObject({ status: 'unchanged' });
    expect(result.lines).toContain('Every server install already uses the new names. Nothing to migrate.');
    expect(f.launchd.commands).toHaveLength(commands);
    expectNewAgents(f);
  });

  it.each([
    { step: 'stop', staged: false, fail: (f: MacInstall) => f.launchd.failBootout.add(OLD[1]!) },
    { step: 'bootstrap of the new tunnel', staged: true, fail: (f: MacInstall) => f.launchd.failBootstrap.add(NEW[1]!) },
    { step: 'new cockpit bootstrap that loads and still fails', staged: true, fail: (f: MacInstall) => f.launchd.loadThenFail.add(NEW[0]!) },
    { step: 'new tunnel bootstrap that loads and still fails', staged: true, fail: (f: MacInstall) => f.launchd.loadThenFail.add(NEW[1]!) },
    { step: 'cockpit health check', staged: true, fail: (f: MacInstall) => f.launchd.unhealthy.add(NEW[0]!) },
    { step: 'tunnel health check', staged: true, fail: (f: MacInstall) => f.launchd.unhealthy.add(NEW[1]!) },
    { step: 'health probe that never answers', staged: true, fail: (f: MacInstall) => { f.launchd.hang = true; } },
  ])('a failure at the $step unloads every new agent, restores the old plists, labels and legacy home, then a rerun migrates', async ({ fail, staged }) => {
    const f = macInstall();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const homes: Array<[string, string]> = [];
    f.launchd.onBootstrap = label => homes.push([label, prepareMigrationHome(f.target, f.env, { legacy: f.legacy }).kind]);
    fail(f);
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'rolled-back' });
    expectOldAgents(f, { staged });
    // A restored old job starts only after the home rolls back, so it reads the legacy home, never the staged one.
    expect(homes.filter(([label]) => label === OLD[0])).not.toEqual([]);
    expect(homes.filter(([label]) => OLD.includes(label))).toEqual(homes.filter(([label]) => OLD.includes(label)).map(([label]) => [label, 'legacy']));
    expect(homes.filter(([label]) => NEW.includes(label))).toEqual(homes.filter(([label]) => NEW.includes(label)).map(([label]) => [label, 'staged']));
    for (const set of [f.launchd.failBootout, f.launchd.failBootstrap, f.launchd.loadThenFail, f.launchd.unhealthy]) set.clear();
    f.launchd.hang = false;
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expectNewAgents(f);
  });

  it('waits about 30 s for the tunnel after the cockpit answers', async () => {
    const f = macInstall();
    f.launchd.tunnelAfter = 10;
    await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
    expectNewAgents(f);
  });

  it('never stops, moves or checks a tunnel plist the ledger does not record', async () => {
    const f = macInstall({ ngrokRecorded: false });
    const result = await serverMigrate(f);
    expect(result).toMatchObject({ status: 'migrated' });
    expect(f.launchd.loaded).toEqual(new Set([NEW[0], OLD[1]]));
    expect(readFileSync(f.plist(OLD[1]!), 'utf8')).toBe(f.bytes[OLD[1]!]);
    expect(f.launchd.commands.some(c => c.join(' ').includes('ngrok'))).toBe(false);
  });

  it('--dry-run prints the stop, each move and health check, and changes nothing', async () => {
    const f = macInstall();
    const before = snapshot(f.target.root);
    const result = await serverMigrate(f, { dryRun: true });
    expect(result.status).toBe('planned');
    expect(result.lines).toEqual(expect.arrayContaining([
      'stop: every instance that shares this home stops first (default)',
      `default: launchd ${OLD[0]} → ${NEW[0]} (${f.plist(NEW[0]!)}; old plist kept as ${f.plist(OLD[0]!)}.migrated)`,
      `default: launchd ${OLD[1]} → ${NEW[1]} (${f.plist(NEW[1]!)}; old plist kept as ${f.plist(OLD[1]!)}.migrated)`,
      `default: health check: ${NEW[0]} is loaded and http://127.0.0.1:4321/ answers`,
      `default: health check: ${NEW[1]} is loaded and the ngrok API at http://localhost:4040/api/tunnels lists a tunnel`,
      'rollback: any failure restores every old service definition (systemd units and nginx sites, launchd plists), starts the old services and renames the marker to install.json.failed; the legacy home stays in use. A restore error leaves its instance stopped and the rollback journal in place: fix the reported error and re-run server-migrate to finish the rollback. A restored service that fails its start check is reported as a warning.',
    ]));
    expect(result.lines.join('\n')).not.toContain('unit and site');
    expect(result.lines.join('\n')).not.toContain('secret');
    expect(f.launchd.commands).toEqual([]);
    expect(f.launchd.loaded).toEqual(new Set(OLD));
    for (const label of OLD) expect(readFileSync(f.plist(label), 'utf8')).toBe(f.bytes[label]);
    expect(snapshot(f.target.root)).toEqual(before);
  });
});

describe('a legacy home that records an installed macOS server', () => {
  it('supports group migration', () => {
    expect(supportsServerMigration(getStrategy('macosx-ngrok'))).toBe(true);
  });

  it('boot keeps the legacy home and prints the server-migrate notice', () => {
    const f = macInstall();
    const before = snapshot(f.target.root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(prepareMigrationHome(f.target, f.env, { legacy: f.legacy })).toEqual({ kind: 'legacy', home: f.legacy });
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Run hsq server-migrate.'));
    expect(snapshot(f.target.root)).toEqual(before);
    expect(readInstallMarker(f.target.config)?.state).toBeUndefined();
    expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(false);
    expect(f.launchd.commands).toEqual([]);
  });
});
