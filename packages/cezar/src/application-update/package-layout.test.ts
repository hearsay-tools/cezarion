import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { productIdentity } from '../home/identity.ts';
import { discoverInstallation } from './discovery.ts';
import { ApplicationUpdateService, validateInstalledPackage, type RestartPlan } from './service.ts';
import { manualRepairCommand, promoteOriginal, restoreOriginal, runRestartWorkflow, type HelperPlan } from './helper.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const layouts = ['direct', 'nested', 'hoisted'] as const;
const kinds = ['global', 'npx'] as const;

function fixture(renamed: boolean, kind: typeof kinds[number], layout: typeof layouts[number]) {
  const root = mkdtempSync(join(tmpdir(), 'update-package-layout-')); roots.push(root);
  const identity = productIdentity(renamed);
  // npm refuses the unscoped name `hsq`. A layout under it is not a published one and stays unsupported.
  const outerPackage = layout === 'direct' ? identity.npmPackage : identity.npmAlias ?? 'hsq';
  const prefix = join(root, 'prefix'), cache = join(root, 'cache');
  const installRoot = kind === 'global' ? prefix : join(cache, '_npx', 'abc123');
  const modules = join(installRoot, kind === 'global' ? 'lib/node_modules' : 'node_modules');
  const outerRoot = join(modules, outerPackage);
  const packageRoot = layout === 'nested' ? join(outerRoot, 'node_modules', identity.npmPackage) : join(modules, identity.npmPackage);
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  mkdirSync(join(packageRoot, 'web/dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: identity.npmPackage, version: '1.0.0', bin: { hsq: 'dist/index.js', cez: 'dist/index.js' }, dependencies: {} }));
  writeFileSync(join(packageRoot, 'dist/index.js'), 'previous CLI');
  writeFileSync(join(packageRoot, 'web/dist/index.html'), 'previous web');
  if (layout !== 'direct') {
    mkdirSync(outerRoot, { recursive: true });
    writeFileSync(join(outerRoot, 'package.json'), JSON.stringify({ name: outerPackage, version: '1.0.0', dependencies: { [identity.npmPackage]: '^1.0.0' }, bin: { hsq: 'bin.js', cez: 'bin.js' } }));
    writeFileSync(join(outerRoot, 'bin.js'), 'previous alias');
  }
  if (kind === 'npx') writeFileSync(join(installRoot, 'package.json'), JSON.stringify({ _npx: { packages: [outerPackage] }, dependencies: { [outerPackage]: '^1.0.0' } }));
  const launchEntry = join(outerRoot, layout === 'direct' ? 'dist/index.js' : 'bin.js');
  const runNpm = vi.fn(async (args: string[]) => {
    expect(args.at(-1)).toBe(`${outerPackage}@2.0.0`);
    const stage = args[args.indexOf('--prefix') + 1]!;
    const stagedOuter = join(stage, 'node_modules', outerPackage);
    cpSync(outerRoot, stagedOuter, { recursive: true });
    const runtime = layout === 'nested' ? join(stagedOuter, 'node_modules', identity.npmPackage) : join(stage, 'node_modules', identity.npmPackage);
    if (layout === 'hoisted') cpSync(packageRoot, runtime, { recursive: true });
    for (const directory of new Set([runtime, stagedOuter])) {
      const path = join(directory, 'package.json');
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), version: '2.0.0' }));
    }
  });
  const home = join(root, 'home');
  let restart: RestartPlan | undefined;
  const options = { packageRoot, launchEntry, npmPrefix: prefix, npmCache: cache, home, targetVersion: () => '2.0.0', runNpm,
    armRestart: async (plan: RestartPlan) => { restart = plan; } };
  const record = () => join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!, 'state.json');
  const helperPlan = (): HelperPlan => ({ ...restart!, oldPid: 1, nodeExecutable: process.execPath, nodeArgs: [], cliArgs: [], cwd: root,
    repoRoot: root, host: '127.0.0.1', port: 12345, npmBin: 'unused' });
  return { root, identity, outerPackage, outerRoot, packageRoot, options, runNpm, record, helperPlan };
}

for (const rebrand of [false, true]) for (const renamed of [false, true]) for (const kind of kinds) for (const layout of layouts) {
  it(`switch ${rebrand}: ${renamed ? 'new' : 'old'} ${kind} ${layout} discovery, pending restart and recovery`, async () => {
    const f = fixture(renamed, kind, layout);
    const input = { prefix: f.options.npmPrefix, cache: f.options.npmCache, packageRoot: f.packageRoot, launchEntry: f.options.launchEntry };
    const installation = discoverInstallation(input, rebrand);
    const service = new ApplicationUpdateService({ ...f.options, rebrand });
    if (renamed && (!rebrand || layout !== 'direct')) {
      expect(installation.kind).toBe('unsupported');
      expect(service.snapshot().supported).toBe(false);
      await expect(service.apply()).rejects.toThrow('manually');
      expect(f.runNpm).not.toHaveBeenCalled();
      return;
    }
    expect(installation).toMatchObject({ kind, outerPackage: f.outerPackage, packageRoot: f.packageRoot });
    expect((await service.apply()).status).toBe('ready');
    const pending = readFileSync(f.record(), 'utf8');
    // A legacy pending record has no identity field to migrate. Switch-on boot must reuse it.
    const resumed = new ApplicationUpdateService({ ...f.options, rebrand: true });
    expect(resumed.snapshot().status).toBe('ready');
    expect(readFileSync(f.record(), 'utf8')).toBe(pending);
    await resumed.restart();
    const plan = f.helperPlan();
    expect(plan.installation.launchEntry).toBe(f.options.launchEntry);
    expect(manualRepairCommand(plan.installation, '1.0.0')).toContain(`${f.outerPackage}@1.0.0`);
    writeFileSync(join(f.packageRoot, 'dist/index.js'), 'broken replacement');
    await restoreOriginal(plan);
    expect(readFileSync(join(f.packageRoot, 'dist/index.js'), 'utf8')).toBe('previous CLI');
    expect(existsSync(plan.installation.launchEntry)).toBe(true);
    validateInstalledPackage(f.packageRoot, '1.0.0', f.packageRoot, f.identity.npmPackage);
    expect(f.runNpm).toHaveBeenCalledTimes(1);
  });
}

it.skipIf(process.platform === 'win32')('preserves the alias through real npm promotion and failure rollback without registry access', async () => {
  const f = fixture(false, 'npx', 'hoisted');
  const service = new ApplicationUpdateService({ ...f.options, rebrand: false });
  await service.apply(); await service.restart();
  const npm = join(f.root, 'offline-npm');
  const argsFile = join(f.root, 'args.json');
  // This executable stands in for npm. It only records argv and damages our private fixture.
  writeFileSync(npm, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));fs.writeFileSync(${JSON.stringify(join(f.packageRoot, 'dist/index.js'))},'replacement');`, { mode: 0o700 });
  const plan = { ...f.helperPlan(), npmBin: npm };
  const reported = vi.fn();
  await runRestartWorkflow({ waitForOldExit: async () => {}, promote: () => promoteOriginal(plan), validateOriginal: async () => {},
    launch: async () => {}, verifyHealth: async () => { throw new Error('health failed'); }, reapReplacement: async () => {},
    restore: () => restoreOriginal(plan), launchPrevious: async () => { expect(readFileSync(join(f.packageRoot, 'dist/index.js'), 'utf8')).toBe('previous CLI'); },
    reportSuccess: async () => { throw new Error('must roll back'); }, reportFailure: async failed => { reported(failed); } });
  expect(JSON.parse(readFileSync(argsFile, 'utf8')).at(-1)).toBe(`${f.outerPackage}@2.0.0`);
  expect(reported).toHaveBeenCalledWith(false);
});

it.each([
  ['hsq'], ['hsq@1.0.0'], ['@hearsay-tools/squawk@latest'], ['hsq', 'foreign'], ['foreign'], [],
].map(requests => ({ requests })))('rejects pinned, mixed, foreign and unscoped new npx requests: $requests', async ({ requests }) => {
  const f = fixture(true, 'npx', 'direct');
  const root = join(f.options.npmCache, '_npx/abc123');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ _npx: { packages: requests } }));
  const service = new ApplicationUpdateService({ ...f.options, rebrand: true });
  expect(service.snapshot().supported).toBe(false);
  await expect(service.apply()).rejects.toThrow('manually');
  expect(f.runNpm).not.toHaveBeenCalled();
});

it('rejects an unrelated dependency under the alias', () => {
  const f = fixture(false, 'global', 'nested');
  writeFileSync(join(f.outerRoot, 'package.json'), JSON.stringify({ name: f.outerPackage, dependencies: { foreign: '1.0.0' } }));
  const service = new ApplicationUpdateService({ ...f.options, rebrand: false });
  expect(service.snapshot().supported).toBe(false);
  expect(f.runNpm).not.toHaveBeenCalled();
});
