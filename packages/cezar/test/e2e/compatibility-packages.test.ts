import assert from 'node:assert/strict';
import { execFileSync, execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { productIdentity } from '../../src/home/identity.ts';
import { withCompatibilityPackages } from '../../src/release/compatibility.ts';
import { fixtureText, frozenUpdater, modulesAt, oldInstallation, capturePlans, launchOriginalEntries, type ConsumerKind } from '../../src/application-update/legacy-entry-paths.testkit.ts';

const execFile = promisify(execFileCallback);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const old = productIdentity(false), active = productIdentity(true);
const { ApplicationUpdateService } = await import(pathToFileURL(join(repo, 'packages/cezar/dist/application-update/service.js')).href) as typeof import('../../src/application-update/service.ts');
const { promoteOriginal, runRestartWorkflow } = await import(pathToFileURL(join(repo, 'packages/cezar/dist/application-update/helper.js')).href) as typeof import('../../src/application-update/helper.ts');

type Archive = { file: string; manifest: { name: string; version: string } };

/** Seed npm's own content cache from local archives. No HTTP request primes it. */
async function cacheArchives(cache: string, registry: string, archives: Archive[]): Promise<void> {
  const npmCli = process.env.npm_execpath ?? join(execFileSync(npm, ['root', '--global', '--offline', '--no-update-notifier'],
    { encoding: 'utf8', shell: process.platform === 'win32' }).trim(), 'npm/package.json');
  const cacache = createRequire(npmCli)('cacache');
  for (const { file, manifest } of archives) {
    const body = readFileSync(file);
    const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`;
    const url = `${registry}/${manifest.name.replace('/', '%2f')}`;
    const dist = { tarball: `${registry}/${basename(file)}`, integrity };
    await cacache.put(join(cache, '_cacache'), `pacote:tarball:${dist.tarball}`, body);
    await cacache.put(join(cache, '_cacache'), `make-fetch-happen:request-cache:${dist.tarball}`, body, {
      metadata: { time: Date.now(), url: dist.tarball, reqHeaders: { accept: '*/*' },
        resHeaders: { 'content-type': 'application/octet-stream' }, options: { compress: true } },
    });
    const metadata = { name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: { ...manifest, dist } } };
    for (const accept of ['application/json', 'application/vnd.npm.install-v1+json']) {
      await cacache.put(join(cache, '_cacache'), `make-fetch-happen:request-cache:${url}`, JSON.stringify(metadata), {
        metadata: { time: Date.now(), url, reqHeaders: { accept }, resHeaders: { 'content-type': 'application/json' }, options: { compress: true } },
      });
    }
  }
}

// Copy the installed dependency graph into a bundled tarball. No cache or registry is an input.
function dependencyRoot(from: string, name: string): string | undefined {
  let cursor = from;
  for (;;) {
    const candidate = join(cursor, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}
type BundleGraph = { modules: string; sources: Map<string, string>; copied: Set<string> };
function bundle(source: string, destination: string, graph: BundleGraph, ancestors: Set<string> = new Set()): void {
  if (graph.copied.has(destination)) return;
  graph.copied.add(destination);
  cpSync(source, destination, { recursive: true, dereference: true, filter: path => basename(path) !== 'node_modules' });
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const next = new Set([...ancestors, source]);
  for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})])) {
    const dependency = dependencyRoot(source, name);
    if (!dependency) {
      assert.ok(name in (pkg.optionalDependencies ?? {}), `missing local dependency ${name}`);
      continue;
    }
    if (next.has(dependency)) continue;
    // Hoist each shared exact source once. Keep conflicting versions nested.
    // Direct dependencies reserve their root slots before traversal starts.
    if (!graph.sources.has(name)) graph.sources.set(name, dependency);
    const target = graph.sources.get(name) === dependency ? join(graph.modules, name) : join(destination, 'node_modules', name);
    bundle(dependency, target, graph, next);
  }
}
function pack(dir: string, destination: string): string {
  const output = execFileSync(npm, ['pack', '--no-update-notifier', '--offline', '--json', '--ignore-scripts', '--pack-destination', destination],
    { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32' });
  return join(destination, JSON.parse(output)[0].filename);
}
function packRuntime(root: string): { tarball: string; source: string; manifest: { name: string; version: string } } {
  const source = join(root, 'runtime');
  const original = join(repo, 'packages/cezar');
  mkdirSync(source);
  for (const dir of ['dist', 'web/dist']) cpSync(join(original, dir), join(source, dir), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(original, 'package.json'), 'utf8'));
  const manifest = { ...pkg, name: active.npmPackage, version: '0.18.0', scripts: {}, devDependencies: {}, bundleDependencies: Object.keys(pkg.dependencies) };
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(source, 'dist/home/switch.js'), 'export const REBRAND_SWITCH = true;\n');
  const graph: BundleGraph = { modules: join(source, 'node_modules'), sources: new Map(), copied: new Set() };
  for (const name of Object.keys(pkg.dependencies)) {
    const dependency = dependencyRoot(original, name);
    assert.ok(dependency, `missing installed dependency ${name}`);
    graph.sources.set(name, dependency);
  }
  for (const [name, dependency] of [...graph.sources]) bundle(dependency, join(graph.modules, name), graph);
  return { tarball: pack(source, root), source, manifest };
}

async function upgradeOldLayout(root: string, kind: ConsumerKind, alias: boolean, entries: string[], version: string,
  env: NodeJS.ProcessEnv, Frozen: typeof ApplicationUpdateService, nested = kind === 'global', links = true): Promise<void> {
  const id = `${kind}-${alias ? 'alias' : 'scoped'}-${entries[0]}-${nested}`.replace(/[^a-z0-9]/gi, '');
  const consumer = kind === 'global' ? join(root, id) : join(env.npm_config_cache!, '_npx', id);
  const original = oldInstallation(consumer, kind, alias, entries, nested, links);
  let installs = 0;
  const options = { packageRoot: original.packageRoot, launchEntry: original.launchEntries[0]!,
    npmPrefix: kind === 'global' ? consumer : join(root, 'unused-prefix'), npmCache: env.npm_config_cache!,
    home: join(root, 'homes', id), targetVersion: () => version,
    runNpm: async (args: string[]) => {
      installs++;
      assert.equal(args.at(-1), `${alias ? old.npmAlias : old.npmPackage}@${version}`);
      const stage = args[args.indexOf('--prefix') + 1]!;
      assert.ok(!existsSync(join(stage, 'node_modules')), 'the shipped updater installs into an empty stage');
      await execFile(npm, [...args, '--offline', '--no-update-notifier'], { env, cwd: root, shell: process.platform === 'win32' });
    },
  };
  const plans = await capturePlans(options, original.launchEntries, Frozen, root, ApplicationUpdateService);
  assert.equal(installs, 1, 'entry-path variants reuse the same shipped ready record');
  const plan = plans[0]!;
  const frozen = stripTypeScriptTypes(fixtureText('v0.17.0-promotion-validator.ts.txt'));
  const previous = Object.fromEntries(['npm_config_registry', 'npm_config_offline', 'npm_config_update_notifier'].map(key => [key, process.env[key]]));
  let launched = false, success = false;
  try {
    Object.assign(process.env, { npm_config_registry: env.npm_config_registry, npm_config_offline: 'true', npm_config_update_notifier: 'false' });
    const unexpected = async () => { assert.fail('the historical upgrade must not roll back'); };
    await runRestartWorkflow({ waitForOldExit: async () => {}, promote: () => promoteOriginal(plan),
      validateOriginal: async () => {
        for (const entryPlan of plans) await execFile(process.execPath, ['--input-type=module', '-e', `${frozen}\nvalidateOriginal(JSON.parse(process.argv[1]), process.argv[2]);`, JSON.stringify(entryPlan), version], { env });
      },
      launch: async () => { await launchOriginalEntries(plans, consumer, env); launched = true; },
      verifyHealth: async () => { assert.equal(launched, true); }, reportSuccess: async () => { success = true; },
      reapReplacement: unexpected, restore: unexpected, launchPrevious: unexpected, reportFailure: unexpected,
    });
    assert.equal(success, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const scoped = dirname(createRequire(join(original.outer, 'package.json')).resolve(`${old.npmPackage}/package.json`));
  assert.equal(JSON.parse(readFileSync(join(scoped, 'package.json'), 'utf8')).version, version);
}
async function verifyCommands(consumer: string, binDir: string, shim: string, env: NodeJS.ProcessEnv): Promise<void> {
  for (const command of ['cezarion', 'hsq']) {
    const calls = [[join(binDir, command + (process.platform === 'win32' ? '.cmd' : '')), [], process.platform === 'win32',
      process.platform === 'win32' && command !== 'hsq' ? 'cez' : command]] as const;
    for (const [file, args, shell, identity] of calls) {
      const result = await execFile(file, [...args, 'worker', 'list'], { cwd: consumer, env, shell });
      assert.deepEqual(JSON.parse(result.stdout), { workers: [] });
      assert.equal(result.stderr, identity === 'hsq' ? '' : `[${identity}] '${identity}' is deprecated; use 'hsq' instead.\n`);
    }
  }
  await assert.rejects(execFile(process.execPath, [join(shim, 'dist/index.js'), 'invalid-compatibility-test-command'], { cwd: consumer, env }),
    (error: unknown) => (error as { code?: number }).code === 1);
}
async function verifyInstalled(consumer: string, kind: ConsumerKind, name: string, version: string, env: NodeJS.ProcessEnv): Promise<void> {
  const windows = process.platform === 'win32';
  const modules = modulesAt(consumer, kind);
  const binDir = kind === 'global' ? windows ? consumer : join(consumer, 'bin') : join(modules, '.bin');
  const shim = join(modules, name);
  const implementation = dirname(createRequire(join(shim, 'package.json')).resolve(`${active.npmPackage}/package.json`));
  assert.equal(JSON.parse(readFileSync(join(implementation, 'package.json'), 'utf8')).name, active.npmPackage);
  // Exercise the installed implementation's discovery against the actual npm result.
  const { discoverInstallation } = await import(pathToFileURL(join(implementation, 'dist/application-update/discovery.js')).href);
  const layout = discoverInstallation({ prefix: kind === 'global' ? consumer : join(consumer, 'unused-prefix'),
    cache: env.npm_config_cache, packageRoot: implementation, launchEntry: join(shim, 'dist/index.js') });
  assert.equal(layout.kind, kind);
  assert.equal(layout.outerPackage, name);
  assert.equal(layout.packageRoot, realpathSync(implementation));
  await verifyCommands(consumer, binDir, shim, env);
  if (name === old.npmPackage) {
    const frozen = stripTypeScriptTypes(readFileSync(new URL('../fixtures/v0.17.0-package-validator.ts.txt', import.meta.url), 'utf8'));
    const args = ['--input-type=module', '-e', `${frozen}\nvalidateInstalledPackage(process.argv[1], process.argv[2], process.argv[3]);`, shim, version, consumer];
    await execFile(process.execPath, args, { env });
    rmSync(join(shim, 'web/dist/assets'), { recursive: true });
    await assert.rejects(execFile(process.execPath, args, { env }), /staged web assets incomplete/);
  }
}

// bound: the complete real-npm consumer file must stay within the three-minute CI allowance (D27).
test('old forwarding tarballs and shipped installs cross the rename offline in global and npx layouts', { timeout: 180_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'compatibility-packages-'));
  const token = 'p'.repeat(43);
  let registryCalls = 0;
  const server = createServer((request, response) => {
    if (request.url !== '/api/v1/delegation/list') { registryCalls++; response.writeHead(503); response.end(); return; }
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"workers":[]}');
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const runtime = packRuntime(root);
    const bridges = withCompatibilityPackages(runtime.source, runtime.manifest,
      packages => Object.values(packages).map(({ dir, manifest }) => ({ manifest, file: pack(dir, root) })), true);
    const cache = join(root, 'empty-cache');
    const registry = `http://127.0.0.1:${address.port}`;
    await cacheArchives(cache, registry, [{ file: runtime.tarball, manifest: runtime.manifest }, ...bridges]);
    const { ApplicationUpdateService: Frozen } = await frozenUpdater(root);
    for (const [kind, name] of [['global', old.npmPackage], ['npx', old.npmAlias]] as const) {
      const id = name === old.npmPackage ? 'scoped1' : 'alias1';
      const consumer = kind === 'global' ? join(root, `global-${id}`) : join(cache, '_npx', id);
      mkdirSync(consumer, { recursive: true });
      writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, _npx: { packages: [name] } }));
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CEZ_|HSQ_)/i.test(key)));
      Object.assign(env, { HOME: root, NODE_NO_WARNINGS: '1', npm_config_cache: cache,
        npm_config_registry: registry, HSQ_DELEGATION_URL: `http://127.0.0.1:${address.port}/api/v1/delegation`,
        HSQ_DELEGATION_TOKEN: token, HSQ_TASK_ID: '11111111-1111-4111-8111-111111111111' });
      await execFile(npm, ['install', ...(kind === 'global' ? ['--global', '--prefix', consumer] : []), '--no-update-notifier', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', `${name}@${runtime.manifest.version}`],
        { cwd: consumer, env, shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024 });
      await verifyInstalled(consumer, kind, name, runtime.manifest.version, env);
      if (name === old.npmAlias) await t.test('one shipped v0.17.0 old alias preparation, promotion and restart', () =>
        upgradeOldLayout(root, 'global', true, ['bin.js'], runtime.manifest.version, env, Frozen, true, false));
    }
    assert.equal(registryCalls, 0);
  } finally {
    server.closeAllConnections(); await promisify(server.close.bind(server))();
    rmSync(root, { recursive: true, force: true });
  }
});
