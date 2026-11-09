import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { productIdentity } from '../home/identity.ts';
import { discoverInstallation } from './discovery.ts';
import { ApplicationUpdateService, type RestartPlan } from './service.ts';
import { restoreOriginal, type HelperPlan } from './helper.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const old = productIdentity(false), active = productIdentity(true);
function packageAt(path: string, name: string, version: string, dependencies = {}) {
  mkdirSync(join(path, 'dist'), { recursive: true });
  mkdirSync(join(path, 'web/dist'), { recursive: true });
  writeFileSync(join(path, 'dist/index.js'), `${name}@${version}`);
  writeFileSync(join(path, 'web/dist/index.html'), 'web');
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version, dependencies, bin: { cez: 'dist/index.js' } }));
}
function fixture(kind: 'global' | 'npx', alias: boolean, hoisted: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'forwarding-layout-')); roots.push(root);
  const prefix = join(root, 'prefix'), cache = join(root, 'cache'), home = join(root, 'home');
  const installRoot = kind === 'global' ? prefix : join(cache, '_npx', 'abc123');
  const modules = join(installRoot, kind === 'global' ? 'lib/node_modules' : 'node_modules');
  const outerPackage = alias ? old.npmAlias : old.npmPackage;
  const outerRoot = join(modules, outerPackage);
  const packageRoot = join(hoisted ? modules : join(outerRoot, 'node_modules'), active.npmPackage);
  packageAt(outerRoot, outerPackage, '1.0.0', { [active.npmPackage]: '1.0.0' });
  packageAt(packageRoot, active.npmPackage, '1.0.0');
  if (kind === 'npx') writeFileSync(join(installRoot, 'package.json'), JSON.stringify({ _npx: { packages: [outerPackage] } }));
  let target = '2.0.0';
  const runNpm = vi.fn(async (args: string[]) => {
    expect(args.at(-1)).toBe(`${outerPackage}@${target}`);
    const stageModules = join(args[args.indexOf('--prefix') + 1]!, 'node_modules');
    const stagedOuter = join(stageModules, outerPackage);
    packageAt(stagedOuter, outerPackage, target, { [active.npmPackage]: target });
    packageAt(join(hoisted ? stageModules : join(stagedOuter, 'node_modules'), active.npmPackage), active.npmPackage, target);
  });
  let restart: RestartPlan | undefined;
  const options = { rebrand: true, packageRoot, launchEntry: join(outerRoot, 'dist/index.js'), npmPrefix: prefix, npmCache: cache, home,
    targetVersion: () => target, runNpm, armRestart: async (plan: RestartPlan) => { restart = plan; } };
  const helper = (): HelperPlan => ({ ...restart!, oldPid: 1, nodeExecutable: process.execPath, nodeArgs: [], cliArgs: [], cwd: root,
    repoRoot: root, host: '127.0.0.1', port: 12345, npmBin: 'unused' });
  const record = () => join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!, 'state.json');
  return { root, modules, outerRoot, packageRoot, options, helper, record, next: () => { target = '3.0.0'; } };
}

for (const kind of ['global', 'npx'] as const) for (const alias of [false, true]) for (const hoisted of [false, true]) {
  it(`${kind} old ${alias ? 'alias' : 'scoped'} forwarding, ${hoisted ? 'hoisted' : 'nested'} runtime: two targets and recovery`, async () => {
    const f = fixture(kind, alias, hoisted);
    const input = { prefix: f.options.npmPrefix, cache: f.options.npmCache, packageRoot: f.packageRoot, launchEntry: f.options.launchEntry };
    expect(discoverInstallation(input, false).kind).toBe('unsupported');
    expect(discoverInstallation(input, true)).toMatchObject({ kind, packageRoot: f.packageRoot, outerRoot: f.outerRoot });
    const service = new ApplicationUpdateService(f.options);
    expect((await service.apply()).status).toBe('ready');
    const pending = readFileSync(f.record(), 'utf8');
    const resumed = new ApplicationUpdateService(f.options);
    expect(resumed.snapshot().status).toBe('ready');
    expect(readFileSync(f.record(), 'utf8')).toBe(pending);
    await resumed.restart();
    const plan = f.helper();
    expect(Boolean(plan.recoveryPackage)).toBe(kind === 'global' && hoisted);
    rmSync(f.outerRoot, { recursive: true });
    if (existsSync(f.packageRoot)) rmSync(f.packageRoot, { recursive: true });
    packageAt(f.outerRoot, plan.installation.outerPackage, '2.0.0', { [active.npmPackage]: '2.0.0' });
    packageAt(f.packageRoot, active.npmPackage, '2.0.0');
    await restoreOriginal(plan);
    expect(readFileSync(join(f.packageRoot, 'dist/index.js'), 'utf8')).toBe(`${active.npmPackage}@1.0.0`);
    expect(existsSync(f.options.launchEntry)).toBe(true);
    // A later matching old-name release remains installable, without changing the outer identity.
    const record = JSON.parse(readFileSync(f.record(), 'utf8'));
    writeFileSync(f.record(), JSON.stringify({ ...record, state: { status: 'idle', supported: true }, ownerPid: undefined, claimId: undefined, startedAt: undefined }));
    f.next();
    expect((await new ApplicationUpdateService(f.options).apply()).targetVersion).toBe('3.0.0');
  });
}

it.each(['range', 'runtime-version', 'foreign-runtime', 'foreign-backup'])('fails closed for %s', async fault => {
  const f = fixture('global', true, true);
  if (fault === 'range') packageAt(f.outerRoot, old.npmAlias, '1.0.0', { [active.npmPackage]: '^1.0.0' });
  if (fault === 'runtime-version') packageAt(f.packageRoot, active.npmPackage, '0.9.0');
  if (fault === 'foreign-runtime') {
    const foreign = join(f.root, 'foreign'); cpSync(f.packageRoot, foreign, { recursive: true });
    rmSync(f.packageRoot, { recursive: true }); symlinkSync(foreign, f.packageRoot, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const service = new ApplicationUpdateService(f.options);
  if (fault !== 'foreign-backup') {
    expect(service.snapshot().supported).toBe(false);
    await expect(service.apply()).rejects.toThrow('manually');
    expect(f.options.runNpm).not.toHaveBeenCalled();
  } else {
    await service.apply(); await service.restart();
    const plan = f.helper();
    packageAt(plan.recoveryPackage!, active.npmPackage, '9.9.9');
    const before = readFileSync(join(f.packageRoot, 'dist/index.js'), 'utf8');
    await expect(restoreOriginal(plan)).rejects.toThrow('invalid hoisted');
    expect(readFileSync(join(f.packageRoot, 'dist/index.js'), 'utf8')).toBe(before);
  }
});

it.each([false, true])('stages the first forwarding release from an old scoped runtime; nested=%s', async nested => {
  const f = fixture('global', false, !nested);
  rmSync(f.packageRoot, { recursive: true });
  packageAt(f.outerRoot, old.npmPackage, '1.0.0');
  const options = { ...f.options, packageRoot: f.outerRoot };
  const service = new ApplicationUpdateService(options);
  expect((await service.apply()).status).toBe('ready');
  await service.restart();
  const plan = f.helper();
  expect(plan.installation.packageRoot).toBe(f.outerRoot);
  expect(plan.recoveryPackage).toBeUndefined();
  packageAt(f.outerRoot, old.npmPackage, '2.0.0', { [active.npmPackage]: '2.0.0' });
  packageAt(f.packageRoot, active.npmPackage, '2.0.0');
  await restoreOriginal(plan);
  expect(readFileSync(join(f.outerRoot, 'dist/index.js'), 'utf8')).toBe(`${old.npmPackage}@1.0.0`);
});

it('refuses a runtime symlink substituted after preparation without touching the foreign tree', async () => {
  const f = fixture('global', false, true);
  const service = new ApplicationUpdateService(f.options);
  await service.apply(); await service.restart();
  const foreign = join(f.root, 'unowned'); cpSync(f.packageRoot, foreign, { recursive: true });
  rmSync(f.packageRoot, { recursive: true });
  symlinkSync(foreign, f.packageRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(restoreOriginal(f.helper())).rejects.toThrow('unowned package path');
  expect(readFileSync(join(foreign, 'dist/index.js'), 'utf8')).toBe(`${active.npmPackage}@1.0.0`);
});
