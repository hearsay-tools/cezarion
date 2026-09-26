import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { Agent, createServer, get } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ApplicationUpdateService } from '../../dist/application-update/service.js';
import { discoverInstallation } from '../../dist/application-update/discovery.js';
import { promoteOriginal, restoreOriginal, runHelper } from '../../dist/application-update/helper.js';
import { withDirectoryLock } from '../../dist/application-update/lock.js';
import { armRestartHelper } from '../../dist/application-update/launcher.js';

const execFile = promisify(execFileCallback);
const npm = async (args: string[], env: NodeJS.ProcessEnv) => execFile('npm', args, { env, timeout: 90_000, maxBuffer: 2_000_000 });
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;

// These are strictly local fixture requests. A fresh agent avoids a worker's
// inherited Node global proxy (which need not exempt ::1 or all of 127/8).
async function localJson(url: string): Promise<Record<string, any>> {
  const agent = new Agent();
  try {
    return await new Promise((resolve, reject) => {
      const request = get(url, { agent }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          try { assert.equal(response.statusCode, 200); resolve(JSON.parse(body)); } catch (error) { reject(error); }
        });
        response.on('error', reject);
      });
      request.once('error', reject);
      request.setTimeout(1000, () => request.destroy(new Error('local fixture request timed out')));
    });
  } finally { agent.destroy(); }
}

// The ack can land before the boot health pre-warm (server.ts refreshHealth)
// finishes; the first GET then joins that in-flight compute, whose CLI probes
// can outlast a one-shot 1s read under load. So poll like the restart helper
// (helper.ts), and stop as soon as the child dies.
async function pollLocalJson(url: string, child: ReturnType<typeof spawn>, deadlineMs = 20_000): Promise<Record<string, any>> {
  const deadline = Date.now() + deadlineMs;
  let last: unknown;
  do {
    if (child.exitCode !== null) throw new Error(`built CLI exited before health: ${child.exitCode}`);
    try { return await localJson(url); } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error(`local fixture never answered within ${deadlineMs}ms: ${last instanceof Error ? last.message : String(last)}`, { cause: last });
}

// Keep this owner alive until cleanup, so its replacement children are reaped.
// The endpoint cases enable an explicit rejecting local proxy in this child;
// production must keep its private loopback probe off that proxy.
function isolatedHelper(proxy: string) {
  const helper = new URL('../../dist/application-update/helper.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
import { runHelper } from ${JSON.stringify(helper)};
process.on('message', async plan => {
  try { await runHelper(plan); process.send({ok:true}); }
  catch(error) { process.send({ok:false,message:error.message}); }
});`], { env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: '', no_proxy: '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return {
    child,
    run: (plan: Parameters<typeof runHelper>[0]) => new Promise<void>((resolve, reject) => {
      const onExit = () => reject(new Error('fixture helper exited unexpectedly'));
      child.once('exit', onExit);
      child.once('message', message => {
        child.off('exit', onExit);
        const result = message as { ok: boolean; message?: string };
        if (result.ok) resolve(); else reject(new Error(result.message));
      });
      child.send(plan);
    }),
  };
}

async function simpleHelperFixture(host = '127.0.0.1', badHealth = false) {
  const root = await mkdtemp(join(tmpdir(), 'cez-update-helper-boundary-'));
  const prefix = join(root, 'prefix');
  const original = join(prefix, 'lib/node_modules/@wjarka/cezarion');
  const stateDir = join(root, 'home', 'application-updates', 'fixture');
  const recovery = join(stateDir, 'recovery');
  const recordPath = join(stateDir, 'state.json');
  const cache = join(root, 'cache');
  const claimId = randomUUID();
  await mkdir(join(original, 'dist'), { recursive: true });
  await mkdir(join(original, 'web/dist'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(original, 'package.json'), JSON.stringify({ name: '@wjarka/cezarion', version: '1.0.0', type: 'module' }));
  await writeFile(join(original, 'web/dist/index.html'), '<!doctype html>');
  await writeFile(join(original, 'dist/index.js'), `import { createServer } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2); const value = (flag) => args.includes(flag) ? args[args.lastIndexOf(flag) + 1] : undefined;
const port = Number(value('--port')); const repoRoot = value('--repo');
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
if (args.includes('--version')) { console.log(version); process.exit(0); }
const server = createServer((req, res) => res.end(JSON.stringify({version: ${badHealth} && version === '2.0.0' ? 'wrong-version' : version, repoRoot, pid:process.pid})));
server.listen(port, value('--bind-host') ?? ${JSON.stringify(host)}, () => {
  const bound = server.address();
  appendFileSync(${JSON.stringify(join(root, 'children.ndjson'))}, JSON.stringify({pid:process.pid,version,host:bound.address,port:bound.port})+'\\n');
  process.send?.({type:'application-update-listening', host:bound.address, port:bound.port, repoRoot, version}, () => process.disconnect?.());
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));`);
  await cp(original, recovery, { recursive: true });
  await writeFile(recordPath, JSON.stringify({ state: { status: 'restarting', supported: true, targetVersion: '2.0.0' },
    recovery, claimId, ownerPid: process.pid }));
  const installation = { kind: 'global' as const, prefix, cache, installRoot: prefix, packageRoot: original,
    outerRoot: original, launchEntry: join(original, 'dist/index.js'), outerPackage: '@wjarka/cezarion' as const, request: '@wjarka/cezarion' };
  const portProbe = createServer();
  await new Promise<void>((resolve) => portProbe.listen(0, host, resolve));
  const address = portProbe.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const plan = { installation, targetVersion: '2.0.0', oldVersion: '1.0.0', recovery, recordPath, claimId,
    oldPid: 2_000_000_000, nodeExecutable: process.execPath, nodeArgs: [], cliArgs: ['serve'], cwd: root,
    repoRoot: root, host, port, npmBin: join(root, 'fake-npm.cjs') };
  return { root, original, stateDir, recovery, recordPath, plan };
}

async function registryFixture(oldVersion: string, newVersion: string) {
  const root = await mkdtemp(join(tmpdir(), 'cez-update-package-'));
  const cache = join(root, 'cache'); const prefix = join(root, 'prefix'); const home = join(root, 'home');
  const tarDir = join(root, 'tarballs'); await mkdir(tarDir);
  const metadata: Record<string, Record<string, any>> = { '@wjarka/cezarion': {}, cezarion: {} };
  const tarballs = new Map<string, Buffer>();
  let latest = oldVersion;
  const registry = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0]!);
    if (path.startsWith('/_tarballs/')) {
      const body = tarballs.get(path);
      if (!body) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body); return;
    }
    const name = path.slice(1);
    if (!metadata[name]) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      name, 'dist-tags': { latest }, versions: metadata[name],
    }));
  });
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
  const address = registry.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env, npm_config_registry: url, npm_config_cache: cache, CEZ_HOME: home };
  for (const version of [oldVersion, newVersion]) {
    for (const name of ['@wjarka/cezarion', 'cezarion'] as const) {
      const dir = join(root, 'fixtures', name === 'cezarion' ? 'alias' : 'scoped', version);
      await mkdir(dir, { recursive: true });
      const manifest = name === 'cezarion'
        ? { name, version, type: 'module', bin: { cezarion: 'bin.js', cez: 'bin.js' }, dependencies: { '@wjarka/cezarion': `^${version}` } }
        : { name, version, type: 'module', bin: { cezarion: 'dist/index.js', cez: 'dist/index.js' }, exports: { '.': './dist/index.js' }, engines: { node: '>=20' }, dependencies: {} };
      await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
      if (name === 'cezarion') await writeFile(join(dir, 'bin.js'), "#!/usr/bin/env node\nimport '@wjarka/cezarion';\n");
      else {
        await mkdir(join(dir, 'dist')); await mkdir(join(dir, 'web/dist'), { recursive: true });
        await writeFile(join(dir, 'dist/index.js'), `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const args = process.argv.slice(2);
if (args.includes('--version')) console.log(version);
else {
  const value = (flag) => args[args.lastIndexOf(flag) + 1];
  const port = Number(value('--port'));
  const repoRoot = value('--repo');
  const server = createServer((req, res) => {
    if (req.url === '/api/v1/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: process.env.FIXTURE_BAD_HEALTH_VERSION === version ? 'wrong-version' : version, repoRoot, pid: process.pid }));
    } else if (req.url === '/restart' && req.method === 'POST') {
      res.end('ack');
      res.once('finish', () => setTimeout(() => server.close(() => process.exit(0)), 50));
    } else { res.statusCode = 404; res.end(); }
  });
  server.listen(port, '127.0.0.1', () => {
    if (process.send) process.send({ type: 'application-update-listening', host: server.address().address, port: server.address().port, repoRoot, version }, () => process.disconnect?.());
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
`);
        await writeFile(join(dir, 'web/dist/index.html'), '<!doctype html>');
      }
      const packed = JSON.parse((await npm(['pack', dir, '--json', '--ignore-scripts', '--pack-destination', tarDir], env)).stdout) as Array<{ filename: string }>;
      const body = await readFile(join(tarDir, packed[0]!.filename));
      const id = `${name === 'cezarion' ? 'alias' : 'scoped'}-${version}.tgz`;
      const path = `/_tarballs/${id}`; tarballs.set(path, body);
      metadata[name]![version] = { ...manifest, dist: { tarball: `${url}${path}`, shasum: createHash('sha1').update(body).digest('hex') } };
    }
  }
  return { root, cache, prefix, home, env, url, setLatest: (value: string) => { latest = value; },
    unpublishAlias: (version: string) => { delete metadata.cezarion![version]; },
    setEngine: (name: string, version: string, range: string) => { metadata[name]![version]!.engines.node = range; },
    close: async () => {
    await new Promise<void>((resolve) => registry.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}

test('alias publication lag leaves the original npx command untouched', { timeout: 120_000 }, async () => {
  const fixture = await registryFixture('0.14.8', '0.15.0');
  const previousRegistry = process.env.npm_config_registry;
  process.env.npm_config_registry = fixture.url;
  try {
    const npx = () => npm(['exec', '--yes', '--package=cezarion', '--', 'cezarion', '--version'], fixture.env);
    assert.equal((await npx()).stdout.trim(), '0.14.8');
    const npxRoot = join(fixture.cache, '_npx', (await readdir(join(fixture.cache, '_npx')))[0]!);
    const original = join(npxRoot, 'node_modules/@wjarka/cezarion');
    const launchEntry = join(npxRoot, 'node_modules/.bin/cezarion');
    fixture.setLatest('0.15.0'); fixture.unpublishAlias('0.15.0');
    const service = new ApplicationUpdateService({ packageRoot: original, launchEntry, npmPrefix: fixture.prefix,
      npmCache: fixture.cache, home: fixture.home, targetVersion: () => '0.15.0' });
    await assert.rejects(service.apply());
    assert.equal(service.snapshot().status, 'error');
    assert.equal(await versionFromFreshOriginalCommand(launchEntry), '0.14.8');
  } finally {
    if (previousRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = previousRegistry;
    await fixture.close();
  }
});

test('engine-incompatible advertised package is refused before touching the original', { timeout: 120_000 }, async () => {
  const fixture = await registryFixture('1.0.0', '2.0.0');
  const previousRegistry = process.env.npm_config_registry;
  process.env.npm_config_registry = fixture.url;
  try {
    await npm(['install', '--global', '--prefix', fixture.prefix, '--no-audit', '--no-fund', '--ignore-scripts', '@wjarka/cezarion@1.0.0'], fixture.env);
    const original = join(fixture.prefix, 'lib/node_modules/@wjarka/cezarion');
    const originalLaunch = join(fixture.prefix, 'bin/cez');
    fixture.setLatest('2.0.0');
    // The local registry's published metadata declares an engine the host cannot run.
    // npm's --engine-strict gate must stop staging before the original is changed.
    fixture.setEngine('@wjarka/cezarion', '2.0.0', '>=999');
    const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: originalLaunch,
      npmPrefix: fixture.prefix, npmCache: fixture.cache, home: fixture.home, targetVersion: () => '2.0.0' });
    await assert.rejects(service.apply());
    assert.equal(await versionFromFreshOriginalCommand(originalLaunch), '1.0.0');
  } finally {
    if (previousRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = previousRegistry;
    await fixture.close();
  }
});

async function versionFromFreshOriginalCommand(entry: string): Promise<string> {
  return (await execFile(process.execPath, [entry, '--version'], { timeout: 10_000 })).stdout.trim();
}

for (const [oldVersion, newVersion] of [['0.14.8', '0.15.0'], ['1.0.0', '2.0.0']] as const) {
  test(`default alias npx ${oldVersion} → ${newVersion} updates the original future command`, { timeout: 120_000 }, async () => {
    const fixture = await registryFixture(oldVersion, newVersion);
    const previousRegistry = process.env.npm_config_registry;
    process.env.npm_config_registry = fixture.url;
    try {
      const npx = () => npm(['exec', '--yes', '--package=cezarion', '--', 'cezarion', '--version'], fixture.env);
      assert.equal((await npx()).stdout.trim(), oldVersion);
      const npxBase = join(fixture.cache, '_npx');
      const roots = await readdir(npxBase);
      const npxRoot = join(npxBase, roots[0] ?? '');
      const request = (await readJson(join(npxRoot, 'package.json')))._npx.packages;
      assert.deepEqual(request, ['cezarion']);
      const original = join(npxRoot, 'node_modules/@wjarka/cezarion');
      const originalLaunch = join(npxRoot, 'node_modules/.bin/cezarion');
      const initialLayout = discoverInstallation({ prefix: fixture.prefix, cache: fixture.cache, packageRoot: original, launchEntry: originalLaunch });
      assert.notEqual(initialLayout.kind, 'unsupported', JSON.stringify(initialLayout));
      fixture.setLatest(newVersion);
      const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: originalLaunch, npmPrefix: fixture.prefix,
        npmCache: fixture.cache, home: fixture.home, targetVersion: () => newVersion });
      assert.equal((await service.apply()).status, 'ready');
      assert.equal((await readJson(join(original, 'package.json'))).version, oldVersion);
      const updateDirs = await readdir(join(fixture.home, 'application-updates'));
      const record = await readJson(join(fixture.home, 'application-updates', updateDirs[0]!, 'state.json'));
      const layout = discoverInstallation({ prefix: fixture.prefix, cache: fixture.cache, packageRoot: original, launchEntry: originalLaunch });
      assert.notEqual(layout.kind, 'unsupported');
      if (layout.kind === 'unsupported') return;
      const plan = { installation: layout, targetVersion: newVersion, oldVersion, stage: record.stage, recovery: record.recovery, recoveryPackage: record.recoveryPackage, binLinks: record.binLinks, claimId: randomUUID(),
        recordPath: join(fixture.home, 'application-updates', updateDirs[0]!, 'state.json'), oldPid: -1,
        nodeExecutable: process.execPath, nodeArgs: [], cliArgs: [], cwd: fixture.root, repoRoot: fixture.root, host: '127.0.0.1', port: 0, npmBin: 'npm' };
      await withDirectoryLock(join(npxRoot, 'concurrency.lock'), async (assertOwned) => {
        await promoteOriginal(plan, true);
        await assertOwned();
      });
      assert.equal(await versionFromFreshOriginalCommand(originalLaunch), newVersion);
      assert.equal((await readJson(join(npxRoot, 'package.json')))._npx.packages[0], 'cezarion');
      assert.equal((await npx()).stdout.trim(), newVersion);
      await withDirectoryLock(join(npxRoot, 'concurrency.lock'), async (assertOwned) => {
        await restoreOriginal(plan);
        await assertOwned();
      });
      assert.equal(await versionFromFreshOriginalCommand(originalLaunch), oldVersion);
    } finally {
      if (previousRegistry === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = previousRegistry;
      await fixture.close();
    }
  });
}

for (const outerPackage of ['@wjarka/cezarion', 'cezarion'] as const) {
test(`${outerPackage} global promotion changes the original command used by future launches`, { timeout: 120_000 }, async () => {
  const fixture = await registryFixture('1.0.0', '2.0.0');
  const previousRegistry = process.env.npm_config_registry;
  process.env.npm_config_registry = fixture.url;
  try {
    await npm(['install', '--global', '--prefix', fixture.prefix, '--no-audit', '--no-fund', '--ignore-scripts', `${outerPackage}@1.0.0`], fixture.env);
    const hoisted = join(fixture.prefix, 'lib/node_modules/@wjarka/cezarion');
    const original = existsSync(hoisted) ? hoisted : join(fixture.prefix, 'lib/node_modules/cezarion/node_modules/@wjarka/cezarion');
    const originalLaunch = join(fixture.prefix, 'bin/cez');
    assert.equal(await versionFromFreshOriginalCommand(originalLaunch), '1.0.0');
    fixture.setLatest('2.0.0');
    const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: originalLaunch, npmPrefix: fixture.prefix,
      npmCache: fixture.cache, home: fixture.home, targetVersion: () => '2.0.0' });
    assert.equal((await service.apply()).status, 'ready');
    assert.equal(await versionFromFreshOriginalCommand(originalLaunch), '1.0.0');
    const updateDirs = await readdir(join(fixture.home, 'application-updates'));
    const recordPath = join(fixture.home, 'application-updates', updateDirs[0]!, 'state.json');
    const record = await readJson(recordPath);
    const layout = discoverInstallation({ prefix: fixture.prefix, cache: fixture.cache, packageRoot: original, launchEntry: originalLaunch });
    assert.notEqual(layout.kind, 'unsupported');
    if (layout.kind === 'unsupported') return;
    const plan = { installation: layout, targetVersion: '2.0.0', oldVersion: '1.0.0', stage: record.stage, recovery: record.recovery, recoveryPackage: record.recoveryPackage, binLinks: record.binLinks, claimId: randomUUID(),
      recordPath, oldPid: -1, nodeExecutable: process.execPath, nodeArgs: [], cliArgs: [], cwd: fixture.root,
      repoRoot: fixture.root, host: '127.0.0.1', port: 0, npmBin: 'npm' };
    await promoteOriginal(plan);
    assert.equal(await versionFromFreshOriginalCommand(originalLaunch), '2.0.0');
    // npm may remove the original bin link before a failed promotion. Recovery
    // must restore that command as well as package files.
    await rm(originalLaunch);
    await restoreOriginal(plan);
    assert.equal(await versionFromFreshOriginalCommand(originalLaunch), '1.0.0');
  } finally {
    if (previousRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = previousRegistry;
    await fixture.close();
  }
});
}

for (const installKind of ['global', 'npx'] as const) for (const badHealth of [false, true]) {
test(`real ${installKind} restart helper ${badHealth ? 'reaps new process and rolls back on wrong health' : 'promotes after acknowledgement and boots on the same port'}`, { timeout: 120_000 }, async () => {
  const fixture = await registryFixture('1.0.0', '2.0.0');
  const previousRegistry = process.env.npm_config_registry;
  const previousBadHealth = process.env.FIXTURE_BAD_HEALTH_VERSION;
  process.env.npm_config_registry = fixture.url;
  if (badHealth) process.env.FIXTURE_BAD_HEALTH_VERSION = '2.0.0';
  let oldPid: number | undefined;
  let port = 0;
  try {
    let original: string;
    let originalLaunch: string;
    if (installKind === 'global') {
      await npm(['install', '--global', '--prefix', fixture.prefix, '--no-audit', '--no-fund', '--ignore-scripts', '@wjarka/cezarion@1.0.0'], fixture.env);
      original = join(fixture.prefix, 'lib/node_modules/@wjarka/cezarion');
      originalLaunch = join(fixture.prefix, 'bin/cez');
    } else {
      await npm(['exec', '--yes', '--package=cezarion', '--', 'cezarion', '--version'], fixture.env);
      const npxRoot = join(fixture.cache, '_npx', (await readdir(join(fixture.cache, '_npx')))[0]!);
      original = join(npxRoot, 'node_modules/@wjarka/cezarion');
      originalLaunch = join(npxRoot, 'node_modules/.bin/cezarion');
    }
    fixture.setLatest('2.0.0');
    const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: originalLaunch,
      npmPrefix: fixture.prefix, npmCache: fixture.cache, home: fixture.home, targetVersion: () => '2.0.0' });
    assert.equal((await service.apply()).status, 'ready');
    const updateDirs = await readdir(join(fixture.home, 'application-updates'));
    const recordPath = join(fixture.home, 'application-updates', updateDirs[0]!, 'state.json');
    const record = await readJson(recordPath);
    const layout = discoverInstallation({ prefix: fixture.prefix, cache: fixture.cache, packageRoot: original, launchEntry: originalLaunch });
    assert.notEqual(layout.kind, 'unsupported');
    if (layout.kind === 'unsupported') return;
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address(); assert.ok(address && typeof address !== 'string'); port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const old = spawn(process.execPath, [originalLaunch, 'serve', '--port', String(port), '--repo', fixture.root],
      { cwd: fixture.root, env: fixture.env, stdio: 'ignore' });
    oldPid = old.pid;
    const health = async (): Promise<{ version: string; repoRoot: string; pid: number } | undefined> => {
      try { const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(500) });
        return response.ok ? await response.json() as { version: string; repoRoot: string; pid: number } : undefined;
      } catch { return undefined; }
    };
    for (let i = 0; i < 100 && !(await health()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await health())?.version, '1.0.0');
    const claimId = randomUUID();
    await writeFile(recordPath, JSON.stringify({ ...record, state: { status: 'restarting', supported: true, targetVersion: '2.0.0' }, claimId, ownerPid: process.pid }));
    const plan = { installation: layout, targetVersion: '2.0.0', oldVersion: '1.0.0', stage: record.stage, claimId,
      recovery: record.recovery, recoveryPackage: record.recoveryPackage, binLinks: record.binLinks, recordPath, oldPid: old.pid!,
      nodeExecutable: process.execPath, nodeArgs: [], cliArgs: ['serve'], cwd: fixture.root,
      repoRoot: fixture.root, host: '127.0.0.1', port, npmBin: 'npm' };
    const running = runHelper(plan);
    const acknowledgement = await fetch(`http://127.0.0.1:${port}/restart`, { method: 'POST' });
    assert.equal(await acknowledgement.text(), 'ack');
    assert.equal(old.exitCode, null, 'HTTP acknowledgement must arrive before old process exits');
    await running;
    const next = await health();
    assert.equal(next?.version, badHealth ? '1.0.0' : '2.0.0');
    assert.equal(next?.repoRoot, fixture.root);
    assert.equal((await readJson(recordPath)).state.status, badHealth ? 'error' : 'idle');
    assert.equal(await versionFromFreshOriginalCommand(originalLaunch), badHealth ? '1.0.0' : '2.0.0');
  } finally {
    if (port) {
      try { const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(500) });
        const data = await response.json() as { pid?: number }; if (data.pid) process.kill(data.pid, 'SIGTERM');
      } catch { /* no replacement owns the port */ }
    }
    if (oldPid) { try { process.kill(oldPid, 'SIGTERM'); } catch { /* old already exited */ } }
    if (previousRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = previousRegistry;
    if (previousBadHealth === undefined) delete process.env.FIXTURE_BAD_HEALTH_VERSION;
    else process.env.FIXTURE_BAD_HEALTH_VERSION = previousBadHealth;
    await fixture.close();
  }
});
}

test('a queued helper rejects a stale claim before promotion', async () => {
  const fixture = await simpleHelperFixture();
  try {
    await writeFile(fixture.plan.npmBin, '#!/usr/bin/env node\nthrow new Error("must not run")', { mode: 0o700 });
    let release!: () => void;
    const owner = withDirectoryLock(join(fixture.stateDir, 'operation.lock'), async () =>
      new Promise<void>((resolve) => { release = resolve; }));
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    const queued = runHelper(fixture.plan);
    await writeFile(fixture.recordPath, JSON.stringify({ state: { status: 'idle', supported: true }, claimId: fixture.plan.claimId }));
    release(); await owner;
    await assert.rejects(queued, /stale application update claim/);
    assert.equal((await readJson(join(fixture.original, 'package.json'))).version, '1.0.0');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('a compromised installation lock cancels promotion before launch and retains recovery', async () => {
  const fixture = await simpleHelperFixture();
  try {
    const lock = join(fixture.stateDir, 'operation.lock');
    const manifest = join(fixture.original, 'package.json');
    await writeFile(fixture.plan.npmBin, `#!/usr/bin/env node\nconst fs=require('node:fs');
const p=${JSON.stringify(manifest)}; const pkg=JSON.parse(fs.readFileSync(p)); pkg.version='2.0.0'; fs.writeFileSync(p,JSON.stringify(pkg));
fs.renameSync(${JSON.stringify(lock)},${JSON.stringify(join(fixture.stateDir, 'stolen-lock'))});
fs.mkdirSync(${JSON.stringify(lock)});`, { mode: 0o700 });
    await assert.rejects(runHelper(fixture.plan), /ownership changed/);
    assert.equal((await readJson(fixture.recordPath)).state.status, 'restarting');
    assert.equal(existsSync(fixture.recovery), true);
    await assert.rejects(fetch(`http://127.0.0.1:${fixture.plan.port}/api/v1/health`, { signal: AbortSignal.timeout(300) }));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('a SIGTERM-resistant promotion child is reaped before compromised-lock failure settles', { timeout: 15_000 }, async () => {
  const fixture = await simpleHelperFixture();
  const pidPath = join(fixture.root, 'npm-pid'); const ticks = join(fixture.original, 'npm-ticks');
  let pid = 0;
  try {
    const lock = join(fixture.stateDir, 'operation.lock');
    await writeFile(fixture.plan.npmBin, `#!/usr/bin/env node
const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));
process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(join(fixture.root, 'term-received'))},'yes'));
fs.renameSync(${JSON.stringify(lock)},${JSON.stringify(join(fixture.stateDir, 'stolen-lock'))});
fs.mkdirSync(${JSON.stringify(lock)});
let n=0; setInterval(()=>fs.writeFileSync(${JSON.stringify(ticks)},String(++n)),25);`, { mode: 0o700 });
    await assert.rejects(runHelper(fixture.plan), /ownership changed/);
    pid = Number(await readFile(pidPath, 'utf8'));
    const before = await readFile(ticks, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await readFile(ticks, 'utf8');
    assert.equal(existsSync(join(fixture.root, 'term-received')), true);
    assert.equal(after, before, 'npm must stop mutating before helper settles');
    assert.throws(() => process.kill(pid, 0), 'owned npm must be reaped');
    assert.equal((await readJson(fixture.recordPath)).state.status, 'restarting');
    assert.equal(existsSync(fixture.recovery), true);
  } finally {
    if (!pid && existsSync(pidPath)) pid = Number(await readFile(pidPath, 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a SIGTERM-resistant staging child is reaped before Apply settles', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-update-stage-reap-'));
  const prefix = join(root, 'prefix'); const cache = join(root, 'cache'); const home = join(root, 'home');
  const original = join(prefix, 'lib/node_modules/@wjarka/cezarion');
  const npmBin = join(root, 'fake-npm.cjs'); const pidPath = join(root, 'npm-pid'); const ticks = join(root, 'stage-ticks');
  let pid = 0;
  try {
    await mkdir(join(original, 'dist'), { recursive: true });
    await mkdir(join(original, 'web/dist'), { recursive: true });
    await writeFile(join(original, 'package.json'), JSON.stringify({ name: '@wjarka/cezarion', version: '1.0.0', bin: { cez: 'dist/index.js' }, dependencies: {} }));
    await writeFile(join(original, 'dist/index.js'), '');
    await writeFile(join(original, 'web/dist/index.html'), '');
    await writeFile(npmBin, `#!/usr/bin/env node
const fs=require('node:fs'); const path=require('node:path'); fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));
process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(join(root, 'term-received'))},'yes'));
const update=path.join(${JSON.stringify(home)},'application-updates',fs.readdirSync(path.join(${JSON.stringify(home)},'application-updates'))[0]);
const lock=path.join(update,'operation.lock'); fs.renameSync(lock,path.join(update,'stolen-lock')); fs.mkdirSync(lock);
let n=0; setInterval(()=>fs.writeFileSync(${JSON.stringify(ticks)},String(++n)),25);`, { mode: 0o700 });
    const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original, 'dist/index.js'),
      npmPrefix: prefix, npmCache: cache, npmBin, home, targetVersion: () => '2.0.0' });
    await assert.rejects(service.apply(), /owns this installation/);
    pid = Number(await readFile(pidPath, 'utf8'));
    const before = await readFile(ticks, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await readFile(ticks, 'utf8');
    assert.equal(existsSync(join(root, 'term-received')), true);
    assert.equal(after, before, 'npm must stop mutating before Apply settles');
    assert.throws(() => process.kill(pid, 0), 'owned npm must be reaped');
    assert.equal((await readJson(join(original, 'package.json'))).version, '1.0.0');
  } finally {
    if (!pid && existsSync(pidPath)) pid = Number(await readFile(pidPath, 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
    await rm(root, { recursive: true, force: true });
  }
});

test('a compromised npx concurrency lock cancels promotion before launch', async () => {
  const fixture = await simpleHelperFixture();
  try {
    const npxPlan = { ...fixture.plan, installation: { ...fixture.plan.installation,
      kind: 'npx' as const, installRoot: fixture.root } };
    const lock = join(fixture.root, 'concurrency.lock');
    await writeFile(npxPlan.npmBin, `#!/usr/bin/env node\nconst fs=require('node:fs');
fs.renameSync(${JSON.stringify(lock)},${JSON.stringify(join(fixture.root, 'stolen-npx-lock'))});
fs.mkdirSync(${JSON.stringify(lock)});`, { mode: 0o700 });
    await assert.rejects(runHelper(npxPlan), /ownership changed/);
    assert.equal((await readJson(fixture.recordPath)).state.status, 'restarting');
    assert.equal(existsSync(fixture.recovery), true);
    assert.equal((await readJson(join(fixture.original, 'package.json'))).version, '1.0.0');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('an unrelated matching health occupant cannot satisfy owned listener proof', async () => {
  const fixture = await simpleHelperFixture();
  const occupant = createServer((_request, response) => response.end(JSON.stringify({ version: '2.0.0', repoRoot: fixture.root })));
  try {
    await writeFile(fixture.plan.npmBin, `#!/usr/bin/env node\nconst fs=require('node:fs');
const p=${JSON.stringify(join(fixture.original, 'package.json'))}; const pkg=JSON.parse(fs.readFileSync(p)); pkg.version='2.0.0'; fs.writeFileSync(p,JSON.stringify(pkg));`, { mode: 0o700 });
    await new Promise<void>((resolve) => occupant.listen(fixture.plan.port, '127.0.0.1', resolve));
    await runHelper(fixture.plan);
    assert.equal((await readJson(fixture.recordPath)).state.status, 'error');
    assert.equal(existsSync(fixture.recovery), true);
    assert.equal((await readJson(join(fixture.original, 'package.json'))).version, '1.0.0');
    assert.equal((await (await fetch(`http://127.0.0.1:${fixture.plan.port}`)).json() as { version: string }).version, '2.0.0');
  } finally {
    await new Promise<void>((resolve) => occupant.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const ephemeral of [false, true]) test(`built production CLI acknowledges its actual listener (ephemeral=${ephemeral})`, { timeout: 50_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-built-listener-'));
  await execFile('git', ['init', '-q', root]);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const cli = new URL('../../dist/index.js', import.meta.url).pathname;
  const host = ephemeral ? '127.0.0.2' : '127.0.0.1';
  const child = spawn(process.execPath, [cli, 'serve', '--repo', root, '--bind-host', host, '--port', String(ephemeral ? 0 : port), '--no-open', '--restart-exact'], {
    cwd: root, env: { ...process.env, CEZ_HOME: join(root, 'home'), CEZ_DRY_RUN: '1', CEZ_NO_BANNER: '1', CEZ_REMOTE: '0',
      npm_config_cache: join(root, 'cache'), npm_config_prefix: join(root, 'prefix') },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const listening = await new Promise<{ type: string; host: string; port: number; repoRoot: string; version: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('built CLI did not acknowledge listener')), 20_000);
      child.once('message', (message) => { clearTimeout(timer); resolve(message as { type: string; host: string; port: number; repoRoot: string; version: string }); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`built CLI exited before listening: ${code}`)); });
    });
    assert.ok(listening.port > 0, 'IPC must carry the actual nonzero listener port');
    assert.equal(listening.host, host);
    if (!ephemeral) assert.equal(listening.port, port);
    assert.equal(listening.type, 'application-update-listening');
    assert.equal(listening.repoRoot, root);
    const health = await pollLocalJson(`http://${host}:${listening.port}/api/v1/health`, child);
    assert.equal(health.version, listening.version);
    assert.equal(health.repoRoot, root);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('copied detached helper acknowledges, then promotes and boots its owned child', { timeout: 30_000 }, async () => {
  const fixture = await simpleHelperFixture();
  let replacementPid: number | undefined;
  try {
    const manifest = join(fixture.original, 'package.json');
    await writeFile(fixture.plan.npmBin, `#!/usr/bin/env node\nconst fs=require('node:fs');
const p=${JSON.stringify(manifest)}; const pkg=JSON.parse(fs.readFileSync(p)); pkg.version='2.0.0'; fs.writeFileSync(p,JSON.stringify(pkg));`, { mode: 0o700 });
    const planPath = join(fixture.root, 'plan.json');
    await writeFile(planPath, JSON.stringify(fixture.plan));
    const launcherPath = new URL('../../dist/application-update/launcher.js', import.meta.url).pathname;
    const script = join(fixture.root, 'orchestrator.mjs');
    await writeFile(script, `import { readFileSync, writeFileSync } from 'node:fs';
import { armRestartHelper } from ${JSON.stringify(new URL('file://' + launcherPath).href)};
const plan = JSON.parse(readFileSync(${JSON.stringify(planPath)}));
const pid = await armRestartHelper(plan, { repoRoot: plan.repoRoot, host: plan.host, port: plan.port, npmBin: plan.npmBin });
writeFileSync(${JSON.stringify(join(fixture.root, 'ack'))}, String(pid));`);
    const orchestrator = spawn(process.execPath, [script, 'serve'], {
      cwd: fixture.root, env: { ...process.env, CEZ_HOME: join(fixture.root, 'home'), npm_config_cache: join(fixture.root, 'cache') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const code = await new Promise<number | null>((resolve) => orchestrator.once('exit', resolve));
    assert.equal(code, 0, 'orchestrator must receive helper acknowledgement before exiting');
    const helperPid = Number(await readFile(join(fixture.root, 'ack'), 'utf8'));
    assert.ok(helperPid > 0);
    assert.equal(existsSync(join(fixture.stateDir, 'helper', 'helper.js')), true);
    let health: { version: string; repoRoot: string; pid: number } | undefined;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try { health = await (await fetch(`http://127.0.0.1:${fixture.plan.port}/api/v1/health`, { signal: AbortSignal.timeout(300) })).json() as typeof health; }
      catch { /* child is still starting */ }
      if (health?.version === '2.0.0') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health?.version, '2.0.0');
    assert.equal(health?.repoRoot, fixture.root);
    replacementPid = health?.pid;
    for (let attempt = 0; attempt < 50 && (await readJson(fixture.recordPath)).state.status !== 'idle'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await readJson(fixture.recordPath)).state.status, 'idle');
  } finally {
    if (replacementPid) { try { process.kill(replacementPid, 'SIGTERM'); } catch { /* already exited */ } }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('detached launcher rejects a helper that exits before acknowledgement', { timeout: 10_000 }, async () => {
  const fixture = await simpleHelperFixture();
  try {
    const planPath = join(fixture.root, 'plan.json');
    await writeFile(planPath, JSON.stringify(fixture.plan));
    const launcherPath = new URL('../../dist/application-update/launcher.js', import.meta.url).pathname;
    const script = join(fixture.root, 'failed-ack.mjs');
    await writeFile(script, `import { readFileSync, writeFileSync } from 'node:fs';
import { armRestartHelper } from ${JSON.stringify(new URL('file://' + launcherPath).href)};
const plan=JSON.parse(readFileSync(${JSON.stringify(planPath)}));
process.env.NODE_OPTIONS='--require /definitely-missing-cezar-update-test';
try { await armRestartHelper(plan,{repoRoot:plan.repoRoot,host:plan.host,port:plan.port,npmBin:plan.npmBin}); }
catch { writeFileSync(${JSON.stringify(join(fixture.root, 'ack-failed'))}, 'yes'); }`);
    const child = spawn(process.execPath, [script, 'serve'], { cwd: fixture.root,
      env: { ...process.env, CEZ_HOME: join(fixture.root, 'home') }, stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(code, 0);
    assert.equal(await readFile(join(fixture.root, 'ack-failed'), 'utf8'), 'yes');
    assert.equal((await readJson(fixture.recordPath)).state.status, 'restarting');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('detached helper does not acknowledge a stale durable claim', { timeout: 10_000 }, async () => {
  const fixture = await simpleHelperFixture();
  try {
    await writeFile(fixture.recordPath, JSON.stringify({ state: { status: 'idle', supported: true }, claimId: fixture.plan.claimId }));
    const planPath = join(fixture.root, 'plan.json'); await writeFile(planPath, JSON.stringify(fixture.plan));
    const launcherPath = new URL('../../dist/application-update/launcher.js', import.meta.url).pathname;
    const script = join(fixture.root, 'stale-ack.mjs');
    await writeFile(script, `import { readFileSync, writeFileSync } from 'node:fs';
import { armRestartHelper } from ${JSON.stringify(new URL('file://' + launcherPath).href)};
const plan=JSON.parse(readFileSync(${JSON.stringify(planPath)}));
try { await armRestartHelper(plan,{repoRoot:plan.repoRoot,host:plan.host,port:plan.port,npmBin:plan.npmBin}); writeFileSync(${JSON.stringify(join(fixture.root, 'ack-result'))},'armed'); }
catch { writeFileSync(${JSON.stringify(join(fixture.root, 'ack-result'))},'rejected'); }`);
    const child = spawn(process.execPath, [script, 'serve'], { cwd: fixture.root,
      env: { ...process.env, CEZ_HOME: join(fixture.root, 'home') }, stdio: 'ignore' });
    assert.equal(await new Promise<number | null>((resolve) => child.once('exit', resolve)), 0);
    assert.equal(await readFile(join(fixture.root, 'ack-result'), 'utf8'), 'rejected');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

for (const host of ['127.0.0.2', '::1']) for (const rollback of [false, true]) {
  test(`helper preserves actual loopback endpoint ${host} (rollback=${rollback}, rejecting proxy enabled)`, { timeout: 55_000 }, async (t) => {
    if (host === '::1') {
      const ipv6 = createServer((_req, res) => res.end(JSON.stringify({ ipv6: true })));
      try {
        await new Promise<void>((resolve, reject) => { ipv6.once('error', reject); ipv6.listen(0, host, resolve); });
        const address = ipv6.address(); assert.ok(address && typeof address !== 'string');
        assert.equal((await localJson(`http://[::1]:${address.port}`)).ipv6, true);
      } catch {
        t.skip('IPv6 listener/HTTP unavailable in this environment; IPv4 nondefault loopback covers process behavior'); return;
      } finally { await new Promise<void>(resolve => ipv6.close(() => resolve())); }
    }
    const fixture = await simpleHelperFixture(host, rollback);
    let proxyRequests = 0;
    const proxy = createServer((_req, response) => { proxyRequests++; response.writeHead(502).end(); });
    proxy.on('connect', (_req, socket) => {
      proxyRequests++;
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== 'string');
    const helper = isolatedHelper(`http://127.0.0.1:${proxyAddress.port}`);
    const endpoint = `http://${host.includes(':') ? `[${host}]` : host}:${fixture.plan.port}`;
    try {
      // Old argv may contain an ephemeral port or hostname. The server-owned
      // endpoint must override them for both upgrade and rollback launches.
      fixture.plan.cliArgs = ['serve', '--bind-host', host, '--port', '0'];
      await writeFile(fixture.plan.npmBin, `#!/usr/bin/env node
const fs=require('node:fs'); const p=${JSON.stringify(join(fixture.original, 'package.json'))};
const pkg=JSON.parse(fs.readFileSync(p)); pkg.version='2.0.0'; fs.writeFileSync(p,JSON.stringify(pkg));`, { mode: 0o700 });
      await helper.run(fixture.plan);
      assert.equal(proxyRequests, 0, 'the private loopback health request must never reach the configured proxy');
      const record = await readJson(fixture.recordPath);
      assert.equal(record.state.status, rollback ? 'error' : 'idle');
      if (rollback) assert.match(record.state.message, /previous release was restored/);
      const health = await localJson(`${endpoint}/api/v1/health`);
      assert.equal(health.version, rollback ? '1.0.0' : '2.0.0');
      assert.equal(health.repoRoot, fixture.root);
      const boots = (await readFile(join(fixture.root, 'children.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(boots.map(boot => ({ host: boot.host, port: boot.port })),
        Array.from({ length: rollback ? 2 : 1 }, () => ({ host, port: fixture.plan.port })));
      if (rollback) assert.throws(() => process.kill(boots[0].pid, 0), 'failed upgrade is reaped before rollback');
    } finally {
      // Reap every owned fixture child even when assertions/verification fail.
      const boots = await readFile(join(fixture.root, 'children.ndjson'), 'utf8').catch(() => '');
      for (const line of boots.trim().split('\n').filter(Boolean)) {
        const { pid } = JSON.parse(line);
        try { process.kill(pid, 'SIGTERM'); } catch { /* helper already reaped it */ }
        for (let attempt = 0; attempt < 100; attempt++) {
          try { process.kill(pid, 0); } catch { break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.throws(() => process.kill(pid, 0), 'owned fixture child must be reaped');
      }
      helper.child.kill('SIGTERM');
      if (helper.child.exitCode === null) await new Promise<void>(resolve => helper.child.once('exit', () => resolve()));
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

// npm's accepted global alias can resolve its runtime from a sibling scoped
// package. Use real fixture processes to force that layout through both failure
// boundaries; every path and npm mutation stays in this temporary prefix.
for (const failure of ['promotion', 'health'] as const) {
  test(`hoisted global alias restores both packages and fresh launchers after ${failure} failure`, { timeout: 30_000 }, async () => {
    const fixture = await simpleHelperFixture('127.0.0.1', true);
    const { root, original } = fixture;
    const { prefix, cache } = fixture.plan.installation;
    const alias = join(prefix, 'lib/node_modules/cezarion');
    const bin = join(prefix, 'bin');
    const sibling = join(prefix, 'lib/node_modules/unrelated/keep');
    try {
      await mkdir(alias, { recursive: true }); await mkdir(bin);
      await mkdir(join(prefix, 'lib/node_modules/unrelated'));
      await writeFile(sibling, 'unrelated package stays intact');
      const scopedManifest = { ...(await readJson(join(original, 'package.json'))),
        exports: { '.': './dist/index.js' }, bin: { cez: 'dist/index.js', cezarion: 'dist/index.js' }, dependencies: {} };
      await writeFile(join(original, 'package.json'), JSON.stringify(scopedManifest));
      await writeFile(join(alias, 'package.json'), JSON.stringify({ name: 'cezarion', version: '1.0.0', type: 'module',
        bin: { cez: 'bin.js', cezarion: 'bin.js' }, dependencies: { '@wjarka/cezarion': '^1.0.0' } }));
      const aliasBytes = "#!/usr/bin/env node\nimport '@wjarka/cezarion';\n";
      await writeFile(join(alias, 'bin.js'), aliasBytes, { mode: 0o755 });
      const linkTarget = '../lib/node_modules/cezarion/bin.js';
      for (const name of ['cez', 'cezarion']) await symlink(linkTarget, join(bin, name));
      const originalLaunch = join(bin, 'cez');
      const layout = discoverInstallation({ prefix, cache, packageRoot: original, launchEntry: originalLaunch });
      assert.equal(layout.kind, 'global');
      if (layout.kind !== 'global') throw new Error('fixture must be accepted');
      assert.equal(layout.outerPackage, 'cezarion');
      assert.equal(layout.packageRoot, original); assert.equal(layout.outerRoot, alias);
      const scopedBytes = await readFile(join(original, 'dist/index.js'));
      // Real bounded npm process fixture: mutate both owned roots, record the
      // mutation, then either fail npm or boot a replacement with wrong health.
      await writeFile(fixture.plan.npmBin, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), promotion=args.includes('--global');
const destination=args[args.indexOf('--prefix')+1];
const outer=promotion ? ${JSON.stringify(alias)} : path.join(destination,'node_modules/cezarion');
const scoped=promotion ? ${JSON.stringify(original)} : path.join(destination,'node_modules/@wjarka/cezarion');
if(!promotion) {
  fs.cpSync(${JSON.stringify(alias)},outer,{recursive:true});
  fs.cpSync(${JSON.stringify(original)},scoped,{recursive:true});
}
for(const directory of [outer,scoped]) {
  const file=path.join(directory,'package.json'),pkg=JSON.parse(fs.readFileSync(file));
  pkg.version='2.0.0'; fs.writeFileSync(file,JSON.stringify(pkg));
}
if(promotion) {
  fs.appendFileSync(path.join(outer,'bin.js'),'// replaced by promotion\\n');
  fs.appendFileSync(path.join(scoped,'dist/index.js'),'// replaced by promotion\\n');
  fs.writeFileSync(${JSON.stringify(join(root, 'promotion.json'))},JSON.stringify([outer,scoped].map(directory=>JSON.parse(fs.readFileSync(path.join(directory,'package.json'))).version)));
  if(${failure === 'promotion'}) {
    for(const name of ['cez','cezarion']) fs.unlinkSync(path.join(${JSON.stringify(bin)},name));
    process.exit(1);
  }
}`, { mode: 0o700 });
      let restart: Parameters<typeof armRestartHelper>[0] | undefined;
      const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: originalLaunch,
        npmPrefix: prefix, npmCache: cache, npmBin: fixture.plan.npmBin, home: join(root, 'home'),
        targetVersion: () => '2.0.0', armRestart: async plan => { restart = plan; } });
      assert.equal((await service.apply()).status, 'ready');
      for (const name of ['cez', 'cezarion']) assert.equal(await versionFromFreshOriginalCommand(join(bin, name)), '1.0.0');
      await service.restart(); assert.ok(restart);
      await runHelper({ ...fixture.plan, ...restart });
      assert.deepEqual(await readJson(join(root, 'promotion.json')), ['2.0.0', '2.0.0']);
      assert.equal((await readJson(join(alias, 'package.json'))).version, '1.0.0');
      assert.equal((await readJson(join(original, 'package.json'))).version, '1.0.0', 'hoisted runtime must be rolled back too');
      assert.equal(await readFile(join(alias, 'bin.js'), 'utf8'), aliasBytes);
      assert.deepEqual(await readFile(join(original, 'dist/index.js')), scopedBytes);
      assert.match((await readJson(restart.recordPath)).state.message, /previous release was restored/);
      assert.equal(await readFile(sibling, 'utf8'), 'unrelated package stays intact');
      assert.equal(existsSync(restart.recovery), true, 'retain recovery after rollback');
      for (const name of ['cez', 'cezarion']) {
        assert.equal(await readlink(join(bin, name)), linkTarget);
        assert.equal((await execFile(join(bin, name), ['--version'])).stdout.trim(), '1.0.0');
      }
      const health = await localJson(`http://127.0.0.1:${fixture.plan.port}/api/v1/health`);
      assert.equal(health.version, '1.0.0'); assert.equal(health.repoRoot, root);
      const boots = (await readFile(join(root, 'children.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(boots.map(boot => boot.version), failure === 'health' ? ['2.0.0', '1.0.0'] : ['1.0.0']);
      if (failure === 'health') assert.throws(() => process.kill(boots[0].pid, 0), 'replacement reaped before rollback');
    } finally {
      const boots = await readFile(join(root, 'children.ndjson'), 'utf8').catch(() => '');
      for (const line of boots.trim().split('\n').filter(Boolean)) {
        const { pid } = JSON.parse(line);
        try { process.kill(pid, 'SIGTERM'); } catch { /* already reaped */ }
        for (let attempt = 0; attempt < 100; attempt++) {
          try { process.kill(pid, 0); } catch { break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.throws(() => process.kill(pid, 0), 'owned fixture child must be reaped');
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
