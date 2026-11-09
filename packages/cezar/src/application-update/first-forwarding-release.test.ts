import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stopGroup } from '../detached-process.ts';
import { productIdentity } from '../home/identity.ts';
import { withCompatibilityPackages } from '../release/compatibility.ts';
import { discoverInstallation } from './discovery.ts';
import { restoreOriginal, runHelper, type HelperPlan } from './helper.ts';
import { modulesAt, oldInstallation } from './legacy-entry-paths.testkit.ts';
import * as npmProcess from './npm-process.ts';
import { PackageRecoveryError, RECOVERY_FAILURE_MESSAGE } from './scoped-recovery.ts';
import { installedRuntime } from './runtime-layout.ts';
import { ApplicationUpdateService, type RestartPlan } from './service.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const old = productIdentity(false), active = productIdentity(true);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const log = join(root, 'launches.jsonl');
    if (existsSync(log)) for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
      const { pid } = JSON.parse(line);
      await stopGroup({ pid }, { graceMs: 500, killWaitMs: 500 });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/** Small runtime fixture implements the helper's real listener/health protocol. */
function serverCode(log: string, version: string): string {
  return `import {createServer} from 'node:http';
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2), value=key=>args[args.lastIndexOf(key)+1];
const host=value('--bind-host'),port=Number(value('--port')),repoRoot=value('--repo'),version=${JSON.stringify(version)};
const server=createServer((_,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({version,repoRoot}));});
server.listen(port,host,()=>{
appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,version,entry:process.argv[1]})+'\\n');
process.send?.({type:'application-update-listening',host,port,repoRoot,version});
});
process.on('SIGTERM',()=>server.close(()=>process.exit()));
`;
}
function copy(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function fixture(kind: 'global' | 'npx', alias: boolean, nested = false, forwarding = false, linkedHome = false) {
  const root = mkdtempSync(join(tmpdir(), 'first-forwarding-')); roots.push(root);
  const prefix = join(root, 'prefix'), cache = join(root, 'cache');
  const consumer = kind === 'global' ? prefix : join(cache, '_npx', 'first123');
  const original = oldInstallation(consumer, kind, alias, [alias ? 'bin.js' : 'dist/index.js'], nested, false);
  const log = join(root, 'launches.jsonl');
  writeFileSync(join(original.packageRoot, 'dist/index.js'), serverCode(log, '0.17.0'));
  const runtime = join(root, 'runtime');
  mkdirSync(join(runtime, 'dist'), { recursive: true });
  mkdirSync(join(runtime, 'web/dist/assets'), { recursive: true });
  writeFileSync(join(runtime, 'web/dist/index.html'), '<script src="/assets/app.js"></script>');
  writeFileSync(join(runtime, 'web/dist/assets/app.js'), 'fixture asset');
  writeFileSync(join(runtime, 'dist/index.js'), serverCode(log, '0.18.0'));
  const manifest = { name: active.npmPackage, version: '0.18.0', type: 'module',
    exports: { '.': './dist/index.js' }, bin: { hsq: 'dist/index.js' }, dependencies: {} };
  writeFileSync(join(runtime, 'package.json'), JSON.stringify(manifest));
  const trees: Record<string, string> = {};
  withCompatibilityPackages(runtime, manifest, packages => {
    for (const { dir, manifest: pkg } of Object.values(packages)) {
      trees[pkg.name] = join(root, 'trees', pkg.name);
      copy(dir, trees[pkg.name]!);
    }
  }, true);
  const outerPackage = alias ? old.npmAlias : old.npmPackage;
  const install = (modules: string) => {
    const outer = join(modules, outerPackage);
    copy(trees[outerPackage]!, outer);
    const dependencies = nested ? join(outer, 'node_modules') : modules;
    if (alias) copy(trees[old.npmPackage]!, join(dependencies, old.npmPackage));
    copy(runtime, join(dependencies, active.npmPackage));
    return { outer, scoped: alias ? join(dependencies, old.npmPackage) : outer, runtime: join(dependencies, active.npmPackage) };
  };
  let savedScoped = original.packageRoot;
  if (forwarding) {
    const current = install(modulesAt(consumer, kind));
    for (const path of new Set([current.outer, current.scoped, current.runtime])) {
      const file = join(path, 'package.json'), pkg = JSON.parse(readFileSync(file, 'utf8'));
      pkg.version = '0.17.0';
      for (const name of Object.keys(pkg.dependencies)) pkg.dependencies[name] = '0.17.0';
      writeFileSync(file, JSON.stringify(pkg));
    }
    writeFileSync(join(current.runtime, 'dist/index.js'), serverCode(log, '0.17.0'));
    original.packageRoot = current.runtime;
    savedScoped = current.scoped;
  }
  const originalManifests = new Map([...new Set([original.outer, original.packageRoot, savedScoped])]
    .map(path => [path, readFileSync(join(path, 'package.json'), 'utf8')]));
  let restart: RestartPlan | undefined;
  const runNpm = vi.fn(async (args: string[]) => {
    expect(args.at(-1)).toBe(`${outerPackage}@0.18.0`);
    install(join(args[args.indexOf('--prefix') + 1]!, 'node_modules'));
  });
  const home = join(root, 'home');
  if (linkedHome) {
    const target = join(root, 'actual-home'); mkdirSync(target);
    symlinkSync(target, home, process.platform === 'win32' ? 'junction' : 'dir');
  }
  // No rebrand override: this is the actual switch-off build, not an emulated switch-on caller.
  const options = { rebrand: forwarding ? true : undefined, packageRoot: original.packageRoot, launchEntry: original.launchEntries[0]!, npmPrefix: prefix, npmCache: cache,
    home, targetVersion: () => '0.18.0', runNpm, armRestart: async (plan: RestartPlan) => { restart = plan; } };
  const record = () => join(options.home, 'application-updates', readdirSync(join(options.home, 'application-updates'))[0]!, 'state.json');
  const plan = (port: number): HelperPlan => ({ ...restart!, oldPid: 2147483647, nodeExecutable: process.execPath, nodeArgs: [], cliArgs: [],
    cwd: root, repoRoot: root, host: '127.0.0.1', port, npmBin: 'fixture-only' });
  return { root, log, kind, original, originalManifests, options, record, plan, install, modules: modulesAt(consumer, kind), outerPackage };
}

async function unusedPort(): Promise<number> {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

for (const kind of ['global', 'npx'] as const) for (const alias of [false, true]) for (const nested of [false, true]) for (const forwarding of [false, true]) for (const linkedHome of [false, true]) {
  // bound: the real helper starts one tiny listener child and proves its IPC and HTTP health before returning.
  it.each([false, true])(`${linkedHome ? 'symlinked-home' : 'ordinary-home'} ${forwarding ? 'switch-on forwarding' : 'switch-off old'} ${kind} ${alias ? 'alias' : 'scoped'} to first ${nested ? 'nested' : 'hoisted'} forwarding release; promotion fails=%s`, async fail => {
    const f = fixture(kind, alias, nested, forwarding, linkedHome);
    const service = new ApplicationUpdateService(f.options);
    expect(service.snapshot().supported).toBe(true);
    expect((await service.apply()).status).toBe('ready');
    const pending = readFileSync(f.record(), 'utf8');
    const resumed = new ApplicationUpdateService(f.options);
    expect(resumed.snapshot().status).toBe('ready');
    expect(readFileSync(f.record(), 'utf8')).toBe(pending);
    expect((await resumed.apply()).status).toBe('ready');
    expect(f.options.runNpm).toHaveBeenCalledTimes(1);
    await resumed.restart();
    const plan = f.plan(await unusedPort());
    expect(plan.installation.launchEntry).toBe(f.options.launchEntry);
    const promote = vi.spyOn(npmProcess, 'runOwnedNpm').mockImplementation(async (_npm, args) => {
      expect(args.at(-1)).toBe(`${f.outerPackage}@0.18.0`);
      f.install(f.modules);
      if (fail) throw new Error('fixture promotion failed after replacing the package');
    });
    await runHelper(plan);
    expect(promote).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(f.record(), 'utf8')).state;
    const [launch] = readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(launch).toMatchObject({ version: fail ? '0.17.0' : '0.18.0', entry: f.options.launchEntry });
    expect(state.status).toBe(fail ? 'error' : 'idle');
    if (fail) {
      expect(state.message).toContain('previous release was restored');
      for (const [path, bytes] of f.originalManifests) expect(readFileSync(join(path, 'package.json'), 'utf8')).toBe(bytes);
      expect(new ApplicationUpdateService(f.options).snapshot().supported).toBe(true);
      expect(JSON.parse(readFileSync(join(f.original.packageRoot, 'package.json'), 'utf8')).version).toBe('0.17.0');
    } else {
      const runtime = installedRuntime(f.modules, f.outerPackage);
      const input = { prefix: f.options.npmPrefix, cache: f.options.npmCache, packageRoot: runtime.path, launchEntry: f.options.launchEntry };
      expect(discoverInstallation(input, false).kind).toBe('unsupported');
      expect(discoverInstallation(input, true).kind).toBe(kind);
    }
  }, 30_000);
}

type Fault = 'pin' | 'version' | 'outer-version' | 'foreign' | 'alias-scoped-pin' | 'scoped-pin' | 'scoped-version' | 'scoped-foreign' | 'scoped-runtime';
function damage(f: ReturnType<typeof fixture>, stage: string, fault: Fault): void {
  const modules = join(stage, 'node_modules');
  const outer = join(modules, f.outerPackage), scoped = join(modules, old.npmPackage), runtime = join(modules, active.npmPackage);
  const path = fault.startsWith('scoped') ? scoped : fault === 'version' || fault === 'foreign' ? runtime : outer;
  if (fault === 'scoped-runtime') {
    const nested = join(scoped, 'node_modules', active.npmPackage); copy(runtime, nested);
    const file = join(nested, 'package.json'), pkg = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...pkg, version: '9.9.9' }));
  } else if (fault.endsWith('foreign')) {
    const foreign = join(f.root, 'foreign'); copy(path, foreign); rmSync(path, { recursive: true });
    symlinkSync(foreign, path, process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (fault === 'alias-scoped-pin') manifest.dependencies[old.npmPackage] = '^0.18.0';
    else if (fault.endsWith('pin')) manifest.dependencies[active.npmPackage] = '^0.18.0';
    else manifest.version = '0.19.0';
    writeFileSync(join(path, 'package.json'), JSON.stringify(manifest));
  }
}
for (const kind of ['global', 'npx'] as const) for (const alias of [false, true]) {
  const faults: Fault[] = ['pin', 'version', 'outer-version', 'foreign', ...(alias ? ['alias-scoped-pin', 'scoped-pin', 'scoped-version', 'scoped-foreign', 'scoped-runtime'] as const : [])];
  for (const fault of faults) it.each(['prepare', 'ready'])(`switch-off ${kind} ${alias ? 'alias' : 'scoped'} rejects ${fault} in %s target`, async phase => {
    const f = fixture(kind, alias);
    const service = new ApplicationUpdateService(f.options);
    if (phase === 'prepare') {
      const install = f.options.runNpm.getMockImplementation()!;
      f.options.runNpm.mockImplementationOnce(async args => { await install(args); damage(f, args[args.indexOf('--prefix') + 1]!, fault); });
      await expect(service.apply()).rejects.toThrow('preparation failed');
    } else {
      await service.apply();
      const { stage } = JSON.parse(readFileSync(f.record(), 'utf8'));
      damage(f, stage, fault);
    }
    const resumed = new ApplicationUpdateService(f.options);
    expect(resumed.snapshot().status).toBe('error');
    await expect(resumed.restart()).rejects.toThrow('Prepare');
    expect(existsSync(f.options.launchEntry)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.original.packageRoot, 'package.json'), 'utf8')).version).toBe('0.17.0');
  });
}

for (const kind of ['global', 'npx'] as const) for (const nested of [false, true]) {
  it.each(['missing', 'version', 'pin', 'foreign', 'nested-runtime'])(`${kind} ${nested ? 'nested' : 'hoisted'} alias recovery rejects a %s scoped wrapper before touching any installed package`, async fault => {
    const f = fixture(kind, true, nested, true, true);
    const service = new ApplicationUpdateService(f.options);
    await service.apply(); await service.restart();
    const plan = f.plan(12345);
    const backupModules = kind === 'global' ? dirname(plan.recovery) : join(plan.recovery, 'node_modules');
    const wrapper = nested ? join(kind === 'global' ? plan.recovery : join(backupModules, old.npmAlias), 'node_modules', old.npmPackage)
      : kind === 'global' ? join(backupModules, 'recovery-scoped-package') : join(backupModules, old.npmPackage);
    if (fault === 'nested-runtime') {
      const nestedRuntime = join(wrapper, 'node_modules', active.npmPackage);
      mkdirSync(nestedRuntime, { recursive: true });
      writeFileSync(join(nestedRuntime, 'package.json'), JSON.stringify({ name: active.npmPackage, version: '9.9.9' }));
    } else if (fault === 'missing') rmSync(wrapper, { recursive: true });
    else if (fault === 'foreign') {
      const foreign = join(f.root, 'foreign-backup'); copy(wrapper, foreign); rmSync(wrapper, { recursive: true });
      symlinkSync(foreign, wrapper, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      const file = join(wrapper, 'package.json'), pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (fault === 'version') pkg.version = '9.9.9'; else pkg.dependencies[active.npmPackage] = '^0.17.0';
      writeFileSync(file, JSON.stringify(pkg));
    }
    // Revert the claim to Ready to exercise refresh against the damaged saved backup.
    const record = JSON.parse(readFileSync(f.record(), 'utf8'));
    writeFileSync(f.record(), JSON.stringify({ ...record, state: { status: 'ready', supported: true, targetVersion: '0.18.0' }, claimId: undefined, ownerPid: undefined }));
    expect(new ApplicationUpdateService(f.options).snapshot().status).toBe('error');
    const installed = f.install(f.modules);
    const paths = [...new Set([installed.outer, installed.scoped, installed.runtime])];
    const before = paths.map(path => readFileSync(join(path, 'package.json'), 'utf8'));
    await expect(restoreOriginal(plan)).rejects.toThrow();
    expect(paths.map(path => readFileSync(join(path, 'package.json'), 'utf8'))).toEqual(before);
  });
}

it('reports every kept copy through existing update status when commit and undo both fail', async () => {
  const f = fixture('global', true, false, true, true);
  const service = new ApplicationUpdateService(f.options);
  await service.apply(); await service.restart();
  const plan = f.plan(12345);
  const installed = f.install(f.modules);
  vi.spyOn(npmProcess, 'runOwnedNpm').mockRejectedValue(new Error('fixture promotion failure'));
  const rename = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let commits = 0, undos = 0;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(from).includes('-recovery-')) {
      if (basename(String(from)) === 'next' && ++commits === 2) throw new Error('fixture commit rename failure');
      if (basename(String(from)) === 'previous' && ++undos === 1) throw new Error('fixture undo rename failure');
    }
    await rename.rename(from, to);
  });
  await runHelper(plan);
  const { state } = JSON.parse(readFileSync(f.record(), 'utf8'));
  expect(state.status).toBe('error');
  expect(state.message).toContain('Update and recovery failed');
  expect(state.message).toContain('Kept previous roots:');
  expect(service.snapshot()).toEqual(state);
  let copies = 0;
  for (const path of [installed.outer, installed.runtime, installed.scoped]) {
    for (const entry of readdirSync(dirname(path)).filter(name => name.startsWith(`.${basename(path)}-recovery-`))) {
      const previous = join(dirname(path), entry, 'previous');
      if (!existsSync(previous)) continue;
      copies++;
      expect(state.message).toContain(`${previous} -> ${path}`);
      expect(JSON.parse(readFileSync(join(previous, 'package.json'), 'utf8')).version).toBe('0.18.0');
    }
  }
  expect(copies).toBe(2);
  expect(commits).toBe(2); expect(undos).toBe(1);
});

for (const kind of ['global', 'npx'] as const) for (const forwarding of [false, true]) {
  it(`${kind} switch ${forwarding ? 'on' : 'off'} status reader preserves canonical kept-copy details and rejects disk text`, async () => {
    const f = fixture(kind, true, false, forwarding);
    const service = new ApplicationUpdateService(f.options);
    await service.apply();
    const record = JSON.parse(readFileSync(f.record(), 'utf8'));
    const destination = kind === 'global' ? f.original.outer : join(f.modules, '..', forwarding ? 'promoted-only-entry' : 'node_modules');
    const work = mkdtempSync(join(dirname(destination), `.${basename(destination)}-recovery-`));
    const source = join(work, 'previous');
    mkdirSync(source);
    const detail = new PackageRecoveryError([{ source, destination }]).message;
    const message = `${RECOVERY_FAILURE_MESSAGE} ${detail}`;
    const state = { status: 'error', supported: true, targetVersion: '0.18.0', message };
    writeFileSync(f.record(), JSON.stringify({ ...record, state }));
    expect(service.snapshot()).toEqual(state);
    expect(new ApplicationUpdateService(f.options).snapshot()).toEqual(state);
    const messages = [
      `${message}; free text from disk`, `${message} free text from disk`,
      message.replace(destination + '', join(f.root, 'foreign')),
      `${RECOVERY_FAILURE_MESSAGE} ${new PackageRecoveryError([{ source: join(f.root, 'foreign', 'previous'), destination }]).message}`,
      `${RECOVERY_FAILURE_MESSAGE} ${new PackageRecoveryError([{ source: `${work}${sep}..${sep}previous`, destination }]).message}`,
      `${message}; ${source} -> ${destination}`,
    ];
    for (const unsafe of messages) {
      writeFileSync(f.record(), JSON.stringify({ ...record, state: { ...state, message: unsafe } }));
      expect(new ApplicationUpdateService(f.options).snapshot().message).toBe('Update state needs retry.');
    }
    const foreign = join(f.root, 'foreign-copy'); mkdirSync(foreign);
    rmSync(source, { recursive: true }); symlinkSync(foreign, source, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(f.record(), JSON.stringify({ ...record, state }));
    expect(service.snapshot().message).toBe('Update state needs retry.');
  });
}

for (const kind of ['global', 'npx'] as const) for (const forwarding of [false, true]) {
  it(`symlinked-home ${kind} switch ${forwarding ? 'on' : 'off'} rejects a recovery-slot symlink before changing installed roots`, async () => {
    const f = fixture(kind, true, false, forwarding, true);
    const service = new ApplicationUpdateService(f.options);
    await service.apply(); await service.restart();
    const plan = f.plan(12345), foreign = join(f.root, 'foreign-recovery');
    copy(plan.recovery, foreign); rmSync(plan.recovery, { recursive: true });
    symlinkSync(foreign, plan.recovery, process.platform === 'win32' ? 'junction' : 'dir');
    const before = [...f.originalManifests].map(([path]) => readFileSync(join(path, 'package.json'), 'utf8'));
    await expect(restoreOriginal(plan)).rejects.toThrow('unowned package path');
    expect([...f.originalManifests].map(([path]) => readFileSync(join(path, 'package.json'), 'utf8'))).toEqual(before);
    const record = JSON.parse(readFileSync(f.record(), 'utf8'));
    writeFileSync(f.record(), JSON.stringify({ ...record, state: { status: 'ready', supported: true, targetVersion: '0.18.0' }, claimId: undefined, ownerPid: undefined }));
    expect(new ApplicationUpdateService(f.options).snapshot().message).toBe('Prepared update is missing. Retry Update.');
  });
}
