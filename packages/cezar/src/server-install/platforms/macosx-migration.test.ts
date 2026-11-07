import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Home } from '../../home/home.ts';
import { createMacosxNgrok, cezarLaunchdPlist, launchdPlist, macosxNgrok } from './macosx-ngrok.ts';
import { applyMigrationReport } from '../migration-report.ts';
import { createAutoUi } from '../ui.ts';
import { STEP_STATUSES, freshServerState, type InstallContext, type StepArtifact } from '../types.ts';

const strategy = createMacosxNgrok({ rebrand: true });

describe('macOS launchd migration', () => {
  let root: string;
  let dir: string;
  let ctx: InstallContext;
  let loaded: Set<string>;
  let commands: string[][];
  let failBootstrap: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'launchd-migration-'));
    const home = Home.sandbox(root, { layout: 'split' });
    dir = join(home.data, 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    loaded = new Set();
    commands = [];
    failBootstrap = undefined;
    ctx = {
      home, launchAgentsDir: () => dir, state: freshServerState(), instance: 'default', ui: createAutoUi(),
      save: vi.fn(async () => {}), dryRun: false, assumeYes: true, reconfigure: new Set(),
      repoRoot: '/repo', now: '2026-11-07T00:00:00.000Z', prefs: {},
      runner: {
        capture: async (program, args) => {
          commands.push([program, ...args]);
          const name = args[1]?.split('/').pop() ?? '';
          if (args[0] === 'bootout') { loaded.delete(name); return { code: 0, stdout: '', stderr: '' }; }
          if (args[0] === 'print') return { code: loaded.has(name) ? 0 : 113, stdout: '', stderr: '' };
          return { code: 0, stdout: program === 'curl' ? 'public_url' : '', stderr: '' };
        },
        interactive: async (program, args) => {
          commands.push([program, ...args]);
          if (args[0] === 'bootstrap') {
            const xml = readFileSync(args[2]!, 'utf8');
            const name = xml.match(/<key>Label<\/key>\s*<string>([^<]+)/)![1]!;
            if (name === failBootstrap) return 5;
            loaded.add(name);
          }
          return 0;
        },
      },
    };
  });
  afterEach(() => rmSync(root, { force: true, recursive: true }));

  function plant(agent: 'cockpit' | 'ngrok', owned = true, argv = ['/n/npx', '--yes', 'cezarion']): StepArtifact {
    const name = `ai.cezar.${agent}`;
    const path = join(dir, `${name}.plist`);
    writeFileSync(path, agent === 'cockpit' ? cezarLaunchdPlist('/repo', 4321, argv) : launchdPlist(4321, 'ops:secret'), { mode: 0o600 });
    loaded.add(name);
    const artifact: StepArtifact = { kind: 'owned', type: 'launchd', name, path };
    ctx.state.steps[agent === 'cockpit' ? 'autostart' : 'ngrok'] = { status: STEP_STATUSES[1], created: owned ? { artifacts: [artifact] } : null };
    return artifact;
  }

  it('moves owned old agents, keeps exact private backups and returns ledger rewrites without saving', async () => {
    const cockpit = plant('cockpit');
    const ngrok = plant('ngrok');
    const before = structuredClone(ctx.state);
    const xml = readFileSync(ngrok.path!, 'utf8');
    const report = await strategy.migrate!(ctx);
    expect(report.errors).toEqual([]);
    expect(report.leftAloneForeign).toEqual([]);
    expect(report.moved).toHaveLength(2);
    expect(loaded).toEqual(new Set(['tools.hearsay.squawk.cockpit', 'tools.hearsay.squawk.ngrok']));
    for (const move of report.moved) {
      expect(existsSync(move.from.path!)).toBe(false);
      expect(statSync(move.to.path!).mode & 0o777).toBe(0o600);
      expect(statSync(move.backup!.path!).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(`${ngrok.path}.migrated`, 'utf8')).toBe(xml);
    expect(ctx.state).toEqual(before);
    expect(ctx.save).not.toHaveBeenCalled();
    const next = applyMigrationReport(ctx.state, report);
    expect(next.steps.autostart!.created!.artifacts[0]!.name).toBe('tools.hearsay.squawk.cockpit');
    expect(next.steps.ngrok!.created!.artifacts[0]!.path).toBe(join(dir, 'tools.hearsay.squawk.ngrok.plist'));
    expect(existsSync(cockpit.path!)).toBe(false);
  });

  it('leaves foreign old plists and services untouched and reports them', async () => {
    const cockpit = plant('cockpit', false, ['/n/npx', '--yes', 'cezar-cli']);
    const ngrok = plant('ngrok', false);
    const original = [cockpit, ngrok].map((a) => readFileSync(a.path!, 'utf8'));
    const report = await strategy.migrate!(ctx);
    expect(report.leftAloneForeign).toEqual([cockpit, ngrok].map((artifact) => ({ ...artifact, kind: 'shared' })));
    expect(report.moved).toEqual([]);
    expect(report.errors).toEqual([]);
    expect([cockpit, ngrok].map((a) => readFileSync(a.path!, 'utf8'))).toEqual(original);
    expect(commands).toEqual([]);
  });

  it('recognizes our npx launcher when check() left created:null', async () => {
    plant('cockpit', false);
    const report = await strategy.migrate!(ctx);
    expect(report.moved).toHaveLength(1);
    expect(applyMigrationReport(ctx.state, report).steps.autostart!.created!.artifacts[0]!.name).toBe('tools.hearsay.squawk.cockpit');
  });

  it.each([
    { argv: ['/usr/bin/node', '/usr/local/bin/cezarion'], owned: true },
    { argv: ['/usr/bin/node', '/usr/local/bin/cez'], owned: true },
    { argv: ['/n/npx', '--yes', 'cezarion-other'], owned: false },
    { argv: ['/usr/bin/node', '/other/dist/index.js'], owned: false },
    { argv: ['/usr/bin/node'], owned: false },
    { argv: ['/other/program', '/usr/local/bin/cezarion'], owned: false },
  ])('proves launcher ownership for $argv: $owned', async ({ argv, owned }) => {
    plant('cockpit', false, argv);
    const report = await strategy.migrate!(ctx);
    expect(report.errors).toEqual([]);
    expect(report.moved).toHaveLength(owned ? 1 : 0);
    expect(report.leftAloneForeign).toHaveLength(owned ? 0 : 1);
  });

  it('rolls back a successful migration and a second rollback does nothing', async () => {
    const old = plant('cockpit');
    const xml = readFileSync(old.path!, 'utf8');
    const report = await strategy.migrate!(ctx);
    const rollback = await strategy.rollbackMigration!(ctx, report);
    expect(rollback.errors).toEqual([]);
    expect(rollback.moved[0]!.to).toEqual(old);
    expect(readFileSync(old.path!, 'utf8')).toBe(xml);
    expect(existsSync(report.moved[0]!.to.path!)).toBe(false);
    expect(loaded).toEqual(new Set(['ai.cezar.cockpit']));
    commands.length = 0;
    expect(await strategy.rollbackMigration!(ctx, report)).toEqual({ moved: [], leftAloneForeign: [], errors: [] });
    expect(commands).toEqual([]);
  });

  it('refuses rollback over a changed destination plist without touching its job', async () => {
    plant('ngrok');
    const report = await strategy.migrate!(ctx);
    const path = report.moved[0]!.to.path!;
    writeFileSync(path, 'foreign replacement');
    commands.length = 0;
    const rollback = await strategy.rollbackMigration!(ctx, report);
    expect(rollback.errors[0]!.message).toContain('Destination plist changed');
    expect(readFileSync(path, 'utf8')).toBe('foreign replacement');
    expect(commands).toEqual([]);
  });

  it('restores the old job and active plist when the new bootstrap fails', async () => {
    const old = plant('ngrok');
    const xml = readFileSync(old.path!, 'utf8');
    failBootstrap = 'tools.hearsay.squawk.ngrok';
    const report = await strategy.migrate!(ctx);
    expect(report.moved).toEqual([]);
    expect(report.errors[0]!.message).toContain('Could not load');
    expect(readFileSync(old.path!, 'utf8')).toBe(xml);
    expect(existsSync(join(dir, 'tools.hearsay.squawk.ngrok.plist'))).toBe(false);
    expect(loaded).toEqual(new Set(['ai.cezar.ngrok']));
  });

  it('refuses to replace an existing destination', async () => {
    plant('ngrok');
    const path = join(dir, 'tools.hearsay.squawk.ngrok.plist');
    writeFileSync(path, 'foreign target');
    const report = await strategy.migrate!(ctx);
    expect(report.errors[0]!.message).toContain('Destination already exists');
    expect(readFileSync(path, 'utf8')).toBe('foreign target');
    expect(commands).toEqual([]);
  });

  it('makes the switch-off migration a no-op and the dry-run report a preview', async () => {
    const old = plant('ngrok');
    expect(await macosxNgrok.migrate!(ctx)).toEqual({ moved: [], leftAloneForeign: [], errors: [] });
    ctx.dryRun = true;
    const report = await strategy.migrate!(ctx);
    expect(report.moved).toHaveLength(1);
    expect(existsSync(old.path!)).toBe(true);
    expect(existsSync(report.moved[0]!.to.path!)).toBe(false);
    expect(existsSync(report.moved[0]!.backup!.path!)).toBe(false);
    expect(commands).toEqual([]);
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it('checks, deploys and uninstalls a pre-switch ledger with the new labels selected', async () => {
    const oldCockpit = plant('cockpit', true, ['/usr/bin/node', '/usr/local/bin/cezarion']);
    const oldNgrok = plant('ngrok');
    const steps = strategy.steps(ctx);
    for (const id of ['autostart', 'ngrok']) {
      const step = steps.find((s) => s.id === id)!;
      expect(await step.check(ctx)).toBe(true);
      expect(commands.at(-1)).toEqual(['test', '-f', id === 'ngrok' ? oldNgrok.path! : oldCockpit.path!]);
    }
    await strategy.redeploy!(ctx);
    expect(commands.filter((c) => c[1] === 'kickstart').map((c) => c[3])).toEqual([
      `gui/${process.getuid?.() ?? 0}/ai.cezar.cockpit`, `gui/${process.getuid?.() ?? 0}/ai.cezar.ngrok`,
    ]);
    for (const id of ['ngrok', 'autostart']) await steps.find((s) => s.id === id)!.undo(ctx, ctx.state.steps[id]!.created ?? null);
    expect(existsSync(oldCockpit.path!)).toBe(false);
    expect(existsSync(oldNgrok.path!)).toBe(false);
    expect(loaded.size).toBe(0);
  });

  it('checks, deploys and uninstalls legacy agents when pre-switch check() recorded created:null', async () => {
    const oldCockpit = plant('cockpit', false, ['/usr/bin/node', '/usr/local/bin/cezarion']);
    const oldNgrok = plant('ngrok', false);
    const steps = strategy.steps(ctx);
    for (const id of ['autostart', 'ngrok']) {
      expect(await steps.find((s) => s.id === id)!.check(ctx)).toBe(true);
      expect(commands.at(-1)).toEqual(['test', '-f', id === 'ngrok' ? oldNgrok.path! : oldCockpit.path!]);
    }
    await strategy.redeploy!(ctx);
    expect(commands.filter((c) => c[1] === 'kickstart').map((c) => c[3])).toEqual([
      `gui/${process.getuid?.() ?? 0}/ai.cezar.cockpit`, `gui/${process.getuid?.() ?? 0}/ai.cezar.ngrok`,
    ]);
    for (const id of ['ngrok', 'autostart']) await steps.find((s) => s.id === id)!.undo(ctx, null);
    expect(existsSync(oldCockpit.path!)).toBe(false);
    expect(existsSync(oldNgrok.path!)).toBe(false);
    expect(commands.filter((c) => c[1] === 'bootout').map((c) => c[2])).toEqual([
      `gui/${process.getuid?.() ?? 0}/ai.cezar.ngrok`, `gui/${process.getuid?.() ?? 0}/ai.cezar.cockpit`,
    ]);
    expect(loaded.size).toBe(0);
  });

  it('prefers the selected static agent and removes both static plists on undo with no ledger', async () => {
    const old = plant('ngrok', false);
    const path = join(dir, 'tools.hearsay.squawk.ngrok.plist');
    writeFileSync(path, launchdPlist(4321, 'ops:secret', undefined, '/n/ngrok', true));
    loaded.add('tools.hearsay.squawk.ngrok');
    const step = strategy.steps(ctx).find((s) => s.id === 'ngrok')!;
    await step.check(ctx);
    expect(commands.at(-1)).toEqual(['test', '-f', path]);
    await step.undo(ctx, null);
    expect(existsSync(old.path!)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(loaded.size).toBe(0);
  });

  it('creates fresh switch-on plists with only the new labels', async () => {
    ctx.ui = { ...ctx.ui, password: async () => 'secret', text: async (opts) => opts.message.includes('domain') ? '' : 'ops' };
    const capture = ctx.runner.capture;
    ctx.runner.capture = async (program, args) => program === 'bash'
      ? { code: 0, stdout: '/usr/local/bin/cezarion', stderr: '' } : capture(program, args);
    for (const id of ['autostart', 'ngrok']) {
      const created = await strategy.steps(ctx).find((s) => s.id === id)!.run(ctx);
      const artifact = created!.artifacts.find((a) => a.type === 'launchd')!;
      expect(artifact.name).toBe(`tools.hearsay.squawk.${id === 'ngrok' ? 'ngrok' : 'cockpit'}`);
      expect(readFileSync(artifact.path!, 'utf8')).toContain(`<string>${artifact.name}</string>`);
      expect(statSync(artifact.path!).mode & 0o777).toBe(0o600);
    }
    expect(cezarLaunchdPlist('/repo', 4321, ['/n/npx', '--yes', 'cezarion'], true)).toContain('<string>tools.hearsay.squawk.cockpit</string>');
    expect(launchdPlist(4321, 'ops:secret', undefined, '/n/ngrok', true)).toContain('<string>tools.hearsay.squawk.ngrok</string>');
  });
});
