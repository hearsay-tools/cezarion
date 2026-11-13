import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Home } from '../../home/home.ts';
import { createMacosxNgrok, squawkLaunchdPlist, launchdPlist } from './macosx-ngrok.ts';
import { applyMigrationReport } from '../migration-report.ts';
import { createAutoUi } from '../ui.ts';
import { STEP_STATUSES, freshServerState, type InstallContext, type StepArtifact } from '../types.ts';

const strategy = createMacosxNgrok();
/** A plist as an install made before the rename wrote it: the old label. */
const legacyLabel = (xml: string) => xml.replaceAll('tools.hearsay.squawk.', 'ai.cezar.');

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
          if (program === 'test') return { code: existsSync(args[1]!) ? 0 : 1, stdout: '', stderr: '' };
          if (args[0] === 'bootout') { loaded.delete(name); return { code: 0, stdout: '', stderr: '' }; }
          if (args[0] === 'print') return { code: loaded.has(name) ? 0 : 113, stdout: '', stderr: '' };
          return { code: 0, stdout: program === 'curl' ? 'public_url' : program === 'bash' ? '/usr/local/bin/cezarion' : '', stderr: '' };
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
    writeFileSync(path, legacyLabel(agent === 'cockpit' ? squawkLaunchdPlist('/repo', 4321, argv) : launchdPlist(4321, 'ops:secret', undefined, '/opt/homebrew/bin/ngrok')), { mode: 0o600 });
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

  it.each([
    { agent: 'cockpit', dryRun: false }, { agent: 'cockpit', dryRun: true },
    { agent: 'ngrok', dryRun: false }, { agent: 'ngrok', dryRun: true },
  ] as const)('rejects missing $agent ledger step before mutation (dryRun:$dryRun)', async ({ agent, dryRun }) => {
    const old = plant(agent);
    const xml = readFileSync(old.path!, 'utf8');
    const stepId = agent === 'cockpit' ? 'autostart' : 'ngrok';
    ctx.state.steps.other = ctx.state.steps[stepId]!;
    delete ctx.state.steps[stepId];
    ctx.dryRun = dryRun;
    const report = await strategy.migrate!(ctx);
    expect(report.errors).toEqual([{ artifact: old, message: `Unknown migration step: ${stepId}` }]);
    expect(report.moved).toEqual([]);
    expect(readFileSync(old.path!, 'utf8')).toBe(xml);
    expect(existsSync(`${old.path}.migrated`)).toBe(false);
    expect(existsSync(join(dir, `tools.hearsay.squawk.${agent}.plist`))).toBe(false);
    expect(loaded).toEqual(new Set([old.name!]));
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
    expect(existsSync(report.moved[0]!.backup!.path!)).toBe(false);
    // The group starts the old job after the home rolls back, never during the rollback.
    expect(loaded).toEqual(new Set());
    commands.length = 0;
    expect(await strategy.rollbackMigration!(ctx, report)).toEqual({ moved: [], leftAloneForeign: [], errors: [] });
    expect(commands).toEqual([]);
  });

  it.each([false, true])('resumes interrupted rollback with both exact plists present (old loaded: %s)', async (oldLoaded) => {
    const old = plant('cockpit');
    const report = await strategy.migrate!(ctx);
    const move = report.moved[0]!;
    const xml = readFileSync(move.backup!.path!, 'utf8');
    writeFileSync(old.path!, xml, { mode: 0o600 });
    if (oldLoaded) loaded.add(old.name!);
    commands.length = 0;
    const rollback = await strategy.rollbackMigration!(ctx, report);
    expect(rollback.errors).toEqual([]);
    expect(rollback.moved).toHaveLength(1);
    expect(readFileSync(old.path!, 'utf8')).toBe(xml);
    expect(existsSync(move.to.path!)).toBe(false);
    expect(loaded).toEqual(new Set(oldLoaded ? [old.name!] : []));
    expect(commands.filter((c) => c[1] === 'bootstrap')).toHaveLength(0);
    commands.length = 0;
    expect(await strategy.rollbackMigration!(ctx, report)).toEqual({ moved: [], leftAloneForeign: [], errors: [] });
    expect(commands).toEqual([]);
  });

  it('refuses an occupied old rollback path whose bytes differ from the backup', async () => {
    const old = plant('ngrok');
    const report = await strategy.migrate!(ctx);
    writeFileSync(old.path!, 'foreign old plist');
    commands.length = 0;
    const rollback = await strategy.rollbackMigration!(ctx, report);
    expect(rollback.errors[0]!.message).toContain('Original path is occupied');
    expect(readFileSync(old.path!, 'utf8')).toBe('foreign old plist');
    expect(existsSync(report.moved[0]!.to.path!)).toBe(true);
    expect(commands).toEqual([]);
  });

  it('migrates again after rollback and a credential rotation, without a stale backup', async () => {
    const old = plant('ngrok');
    const report = await strategy.migrate!(ctx);
    expect(existsSync(report.moved[0]!.backup!.path!)).toBe(true);
    expect((await strategy.rollbackMigration!(ctx, report)).errors).toEqual([]);
    expect(existsSync(report.moved[0]!.backup!.path!)).toBe(false);
    const rotated = legacyLabel(launchdPlist(4321, 'ops:rotated-secret', undefined, '/opt/homebrew/bin/ngrok'));
    writeFileSync(old.path!, rotated);
    commands.length = 0;
    expect(await strategy.rollbackMigration!(ctx, report)).toEqual({ moved: [], leftAloneForeign: [], errors: [] });
    expect(commands).toEqual([]);
    const next = await strategy.migrate!(ctx);
    expect(next.errors).toEqual([]);
    expect(next.moved).toHaveLength(1);
    expect(readFileSync(next.moved[0]!.backup!.path!, 'utf8')).toBe(rotated);
    expect(loaded).toEqual(new Set(['tools.hearsay.squawk.ngrok']));
  });

  it('cleans an internally rolled-back migration backup so later credentials can migrate', async () => {
    const old = plant('ngrok');
    failBootstrap = 'tools.hearsay.squawk.ngrok';
    expect((await strategy.migrate!(ctx)).errors).toHaveLength(1);
    expect(existsSync(`${old.path}.migrated`)).toBe(false);
    writeFileSync(old.path!, legacyLabel(launchdPlist(4321, 'ops:rotated-secret', undefined, '/opt/homebrew/bin/ngrok')));
    failBootstrap = undefined;
    const next = await strategy.migrate!(ctx);
    expect(next.errors).toEqual([]);
    expect(next.moved).toHaveLength(1);
  });

  it('finishes backup cleanup after rollback already restored the old file and removed the new one', async () => {
    const old = plant('ngrok');
    const report = await strategy.migrate!(ctx);
    const move = report.moved[0]!;
    writeFileSync(old.path!, readFileSync(move.backup!.path!));
    rmSync(move.to.path!);
    loaded = new Set([old.name!]);
    commands.length = 0;
    expect(await strategy.rollbackMigration!(ctx, report)).toEqual({ moved: [], leftAloneForeign: [], errors: [] });
    expect(existsSync(move.backup!.path!)).toBe(false);
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

  it('restores the active plist and leaves the old job for the group to start when the new bootstrap fails', async () => {
    const old = plant('ngrok');
    const xml = readFileSync(old.path!, 'utf8');
    failBootstrap = 'tools.hearsay.squawk.ngrok';
    const report = await strategy.migrate!(ctx);
    expect(report.moved).toEqual([]);
    expect(report.errors[0]!.message).toContain('Could not load');
    expect(readFileSync(old.path!, 'utf8')).toBe(xml);
    expect(existsSync(join(dir, 'tools.hearsay.squawk.ngrok.plist'))).toBe(false);
    expect(loaded).toEqual(new Set());
  });

  it.each(['cockpit', 'ngrok'] as const)('migration refuses an existing foreign %s destination', async (agent) => {
    plant(agent);
    const path = join(dir, `tools.hearsay.squawk.${agent}.plist`);
    writeFileSync(path, 'foreign target');
    const report = await strategy.migrate!(ctx);
    expect(report.errors[0]!.message).toContain('Destination already exists');
    expect(readFileSync(path, 'utf8')).toBe('foreign target');
    expect(commands).toEqual([]);
  });

  it('makes the dry-run report a preview', async () => {
    const old = plant('ngrok');
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

  it.each([
    { agent: 'cockpit', record: false }, { agent: 'cockpit', record: true },
    { agent: 'ngrok', record: false },
  ] as const)('never selects a foreign legacy $agent plist (step record:$record)', async ({ agent, record }) => {
    const old = plant(agent, false, ['/usr/bin/foreign']);
    const xml = readFileSync(old.path!, 'utf8');
    const stepId = agent === 'cockpit' ? 'autostart' : 'ngrok';
    if (!record) delete ctx.state.steps[stepId];
    const step = strategy.steps(ctx).find((s) => s.id === stepId)!;
    expect(await step.check(ctx)).toBe(false);
    expect(commands.at(-1)).toEqual(['test', '-f', join(dir, `tools.hearsay.squawk.${agent}.plist`)]);
    await strategy.redeploy!(ctx);
    await step.undo(ctx, null);
    expect(readFileSync(old.path!, 'utf8')).toBe(xml);
    expect(loaded).toEqual(new Set([old.name!]));
    ctx.ui = { ...ctx.ui, password: async () => 'secret', text: async (opts) => opts.message.includes('domain') ? '' : 'ops' };
    ctx.reconfigure = new Set([stepId]);
    const created = await step.run(ctx);
    expect(created!.artifacts.find((a) => a.type === 'launchd')!.name).toBe(`tools.hearsay.squawk.${agent}`);
    expect(readFileSync(old.path!, 'utf8')).toBe(xml);
    expect(loaded).toEqual(new Set([old.name!, `tools.hearsay.squawk.${agent}`]));
    expect(commands.filter((c) => c[0] === 'launchctl' && c.some((arg) => arg.endsWith(`/${old.name}`) || arg === old.path))).toEqual([]);
  });

  it.each(['cockpit', 'ngrok'] as const)('undo selects only the new %s plist and leaves the legacy plist with no ledger', async (agent) => {
    const old = plant(agent, false);
    const legacyXml = readFileSync(old.path!, 'utf8');
    const path = join(dir, `tools.hearsay.squawk.${agent}.plist`);
    writeFileSync(path, agent === 'cockpit' ? squawkLaunchdPlist('/repo', 4321, ['/n/npx', '--yes', 'cezarion']) : launchdPlist(4321, 'ops:secret', undefined, '/n/ngrok'));
    loaded.add(`tools.hearsay.squawk.${agent}`);
    const step = strategy.steps(ctx).find((s) => s.id === (agent === 'cockpit' ? 'autostart' : 'ngrok'))!;
    await step.check(ctx);
    expect(commands.at(-1)).toEqual(['test', '-f', path]);
    await step.undo(ctx, null);
    expect(readFileSync(old.path!, 'utf8')).toBe(legacyXml);
    expect(existsSync(path)).toBe(false);
    expect(loaded).toEqual(new Set([old.name!]));
    expect(commands.filter((c) => c[1] === 'bootout').map((c) => c[2])).toEqual([`gui/${process.getuid?.() ?? 0}/tools.hearsay.squawk.${agent}`]);
  });

  it.each(['cockpit', 'ngrok'] as const)('undo keeps a foreign legacy %s plist when the new agent is recorded', async (agent) => {
    const foreign = plant(agent, false, ['/n/npx', '--yes', 'cezar-cli']);
    const original = readFileSync(foreign.path!, 'utf8');
    expect((await strategy.migrate!(ctx)).leftAloneForeign).toEqual([{ ...foreign, kind: 'shared' }]);
    const name = `tools.hearsay.squawk.${agent}`;
    const path = join(dir, `${name}.plist`);
    writeFileSync(path, agent === 'cockpit'
      ? squawkLaunchdPlist('/repo', 4321, ['/n/npx', '--yes', 'cezarion'])
      : launchdPlist(4321, 'ops:secret', undefined, '/n/ngrok'));
    loaded.add(name);
    const stepId = agent === 'cockpit' ? 'autostart' : 'ngrok';
    const created = { artifacts: [{ kind: 'owned' as const, type: 'launchd', name, path }] };
    ctx.state.steps[stepId] = { status: STEP_STATUSES[1], created };
    const step = strategy.steps(ctx).find((s) => s.id === stepId)!;
    await step.check(ctx);
    expect(commands.at(-1)).toEqual(['test', '-f', path]);
    await step.undo(ctx, created);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(foreign.path!, 'utf8')).toBe(original);
    expect(loaded).toEqual(new Set([foreign.name!]));
    expect(commands.filter((c) => c[1] === 'bootout').map((c) => c[2])).toEqual([`gui/${process.getuid?.() ?? 0}/${name}`]);
  });

  it.each(['cockpit', 'ngrok'] as const)('reconfigure replaces the recorded old %s agent after the new job loads', async (agent) => {
    const old = plant(agent);
    ctx.ui = { ...ctx.ui, password: async () => 'secret', text: async (opts) => opts.message.includes('domain') ? '' : 'ops' };
    const capture = ctx.runner.capture;
    ctx.runner.capture = async (program, args) => program === 'bash'
      ? { code: 0, stdout: '/usr/local/bin/cezarion', stderr: '' } : capture(program, args);
    const stepId = agent === 'cockpit' ? 'autostart' : 'ngrok';
    ctx.reconfigure = new Set([stepId]);
    const created = await strategy.steps(ctx).find((s) => s.id === stepId)!.run(ctx);
    const next = created!.artifacts.find((a) => a.type === 'launchd')!;
    expect(next.name).toBe(`tools.hearsay.squawk.${agent}`);
    expect(existsSync(next.path!)).toBe(true);
    expect(existsSync(old.path!)).toBe(false);
    expect(loaded).toEqual(new Set([next.name!]));
    const newProof = commands.findIndex((c) => c[1] === 'print' && c[2]?.endsWith(`/${next.name}`));
    const oldBootout = commands.findIndex((c) => c[1] === 'bootout' && c[2]?.endsWith(`/${old.name}`));
    expect(newProof).toBeGreaterThan(-1);
    expect(oldBootout).toBeGreaterThan(newProof);
  });

  it.each(['cockpit', 'ngrok'] as const)('refuses a foreign destination on reconfigure of %s without touching either job', async (agent) => {
    const old = plant(agent);
    const oldXml = readFileSync(old.path!, 'utf8');
    const name = `tools.hearsay.squawk.${agent}`;
    const path = join(dir, `${name}.plist`);
    const foreignXml = squawkLaunchdPlist('/foreign', 9876, ['/usr/bin/foreign']).replace('tools.hearsay.squawk.cockpit', name);
    writeFileSync(path, foreignXml);
    loaded.add(name);
    ctx.ui = { ...ctx.ui, password: async () => 'secret', text: async () => 'ops' };
    const before = structuredClone(ctx.state);
    const stepId = agent === 'cockpit' ? 'autostart' : 'ngrok';
    await expect(strategy.steps(ctx).find((s) => s.id === stepId)!.run(ctx)).rejects.toThrow('Destination already exists');
    expect(readFileSync(path, 'utf8')).toBe(foreignXml);
    expect(readFileSync(old.path!, 'utf8')).toBe(oldXml);
    expect(loaded).toEqual(new Set([old.name!, name]));
    expect(commands.filter((c) => c[0] === 'launchctl')).toEqual([]);
    expect(ctx.state).toEqual(before);
  });

  it('can replace a destination cockpit whose launcher independently proves it is ours', async () => {
    plant('cockpit');
    const name = 'tools.hearsay.squawk.cockpit';
    const path = join(dir, `${name}.plist`);
    writeFileSync(path, squawkLaunchdPlist('/repo', 4321, ['/n/npx', '--yes', 'cezarion']));
    loaded.add(name);
    const created = await strategy.steps(ctx).find((s) => s.id === 'autostart')!.run(ctx);
    expect(created!.artifacts[0]!.name).toBe(name);
    expect(loaded).toEqual(new Set([name]));
  });

  it('can replace a destination tunnel that the ledger independently records as owned', async () => {
    const old = plant('ngrok');
    const name = 'tools.hearsay.squawk.ngrok';
    const path = join(dir, `${name}.plist`);
    writeFileSync(path, launchdPlist(4321, 'ops:old-secret', undefined, '/n/ngrok'));
    ctx.state.steps.ngrok!.created!.artifacts.push({ kind: 'owned', type: 'launchd', name, path });
    loaded.add(name);
    ctx.ui = { ...ctx.ui, password: async () => 'secret', text: async () => 'ops' };
    const created = await strategy.steps(ctx).find((s) => s.id === 'ngrok')!.run(ctx);
    expect(created!.artifacts.find((a) => a.type === 'launchd')!.name).toBe(name);
    expect(existsSync(old.path!)).toBe(false);
    expect(loaded).toEqual(new Set([name]));
  });

  it.each(['cockpit', 'ngrok'] as const)('refuses a symlink destination on reconfigure of %s', async (agent) => {
    const old = plant(agent);
    const name = `tools.hearsay.squawk.${agent}`;
    const foreign = join(dir, 'foreign.plist');
    writeFileSync(foreign, 'foreign bytes');
    symlinkSync(foreign, join(dir, `${name}.plist`));
    loaded.add(name);
    ctx.ui = { ...ctx.ui, password: async () => 'secret', text: async () => 'ops' };
    const stepId = agent === 'cockpit' ? 'autostart' : 'ngrok';
    await expect(strategy.steps(ctx).find((s) => s.id === stepId)!.run(ctx)).rejects.toThrow('non-regular plist');
    expect(readFileSync(foreign, 'utf8')).toBe('foreign bytes');
    expect(loaded).toEqual(new Set([old.name!, name]));
    expect(commands.filter((c) => c[0] === 'launchctl')).toEqual([]);
  });

  it.each(['cockpit', 'ngrok'] as const)('a failed reconfigure leaves only the previous %s job and its ledger', async (agent) => {
    const old = plant(agent);
    ctx.ui = { ...ctx.ui, password: async () => 'secret', text: async (opts) => opts.message.includes('domain') ? '' : 'ops' };
    const stepId = agent === 'cockpit' ? 'autostart' : 'ngrok';
    const before = structuredClone(ctx.state);
    failBootstrap = `tools.hearsay.squawk.${agent}`;
    await expect(strategy.steps(ctx).find((s) => s.id === stepId)!.run(ctx)).rejects.toThrow('could not load');
    expect(existsSync(old.path!)).toBe(true);
    expect(existsSync(join(dir, `${failBootstrap}.plist`))).toBe(false);
    expect(loaded).toEqual(new Set([old.name!]));
    expect(ctx.state).toEqual(before);
  });

  it('refuses reconfigure when the previous job cannot unload and removes the new job', async () => {
    const old = plant('ngrok');
    ctx.ui = { ...ctx.ui, password: async () => 'secret', text: async () => 'ops' };
    const capture = ctx.runner.capture;
    ctx.runner.capture = async (program, args) => {
      if (args[0] === 'bootout' && args[1]?.endsWith('/ai.cezar.ngrok')) {
        commands.push([program, ...args]);
        return { code: 1, stdout: '', stderr: 'refused' };
      }
      return capture(program, args);
    };
    await expect(strategy.steps(ctx).find((s) => s.id === 'ngrok')!.run(ctx)).rejects.toThrow('Could not unload');
    expect(existsSync(old.path!)).toBe(true);
    expect(existsSync(join(dir, 'tools.hearsay.squawk.ngrok.plist'))).toBe(false);
    expect(loaded).toEqual(new Set([old.name!]));
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
    expect(squawkLaunchdPlist('/repo', 4321, ['/n/npx', '--yes', 'cezarion'])).toContain('<string>tools.hearsay.squawk.cockpit</string>');
    expect(launchdPlist(4321, 'ops:secret', undefined, '/n/ngrok')).toContain('<string>tools.hearsay.squawk.ngrok</string>');
  });
});
