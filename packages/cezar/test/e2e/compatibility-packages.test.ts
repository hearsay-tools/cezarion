import assert from 'node:assert/strict';
import { execFileSync, execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { productIdentity } from '../../src/home/identity.ts';
import { withCompatibilityPackages } from '../../src/release/compatibility.ts';

const execFile = promisify(execFileCallback);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const old = productIdentity(false), active = productIdentity(true);

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
function bundle(source: string, destination: string, ancestors: Set<string> = new Set()): void {
  cpSync(source, destination, { recursive: true, dereference: true, filter: path => basename(path) !== 'node_modules' });
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const next = new Set([...ancestors, source]);
  for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})])) {
    const dependency = dependencyRoot(source, name);
    if (!dependency) {
      assert.ok(name in (pkg.optionalDependencies ?? {}), `missing local dependency ${name}`);
      continue;
    }
    if (!next.has(dependency)) bundle(dependency, join(destination, 'node_modules', name), next);
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
  const manifest = { ...pkg, name: active.npmPackage, scripts: {}, devDependencies: {}, bundleDependencies: Object.keys(pkg.dependencies) };
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(source, 'dist/home/switch.js'), 'export const REBRAND_SWITCH = true;\n');
  for (const name of Object.keys(pkg.dependencies)) {
    const dependency = dependencyRoot(original, name);
    assert.ok(dependency, `missing installed dependency ${name}`);
    bundle(dependency, join(source, 'node_modules', name));
  }
  return { tarball: pack(source, root), source, manifest };
}

// bound: pack/bundle/install and real CLI children need more than the default unit-test timeout.
test('old forwarding tarballs install offline, execute the new runtime and pass the shipped validator', { timeout: 240_000 }, async () => {
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
      packages => Object.values(packages).map(({ dir, manifest }) => ({ name: manifest.name, file: pack(dir, root) })), true);
    for (const bridge of bridges) {
      const consumer = join(root, bridge.name === old.npmPackage ? 'scoped' : 'alias'); mkdirSync(consumer);
      writeFileSync(join(consumer, 'package.json'), '{"private":true}');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CEZ_|HSQ_)/i.test(key)));
      Object.assign(env, { HOME: root, NODE_NO_WARNINGS: '1', npm_config_cache: join(root, 'empty-cache'),
        npm_config_registry: `http://127.0.0.1:${address.port}`, HSQ_DELEGATION_URL: `http://127.0.0.1:${address.port}/api/v1/delegation`,
        HSQ_DELEGATION_TOKEN: token, HSQ_TASK_ID: '11111111-1111-4111-8111-111111111111' });
      await execFile(npm, ['install', '--no-update-notifier', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', runtime.tarball, bridge.file],
        { cwd: consumer, env, shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024 });
      const shim = join(consumer, 'node_modules', bridge.name);
      const implementation = join(consumer, 'node_modules', active.npmPackage);
      assert.equal(JSON.parse(readFileSync(join(implementation, 'package.json'), 'utf8')).name, active.npmPackage);
      for (const command of ['cezarion', 'cez', 'hsq']) {
        const entry = command === 'hsq' ? 'hsq.js' : 'index.js';
        const calls = [[process.execPath, [join(shim, 'dist', entry)], false, command === 'hsq' ? 'hsq' : 'cez'],
          [join(consumer, 'node_modules/.bin', command + (process.platform === 'win32' ? '.cmd' : '')), [], process.platform === 'win32', process.platform === 'win32' && command !== 'hsq' ? 'cez' : command]] as const;
        for (const [file, args, shell, identity] of calls) {
          const result = await execFile(file, [...args, 'worker', 'list'], { cwd: consumer, env, shell });
          assert.deepEqual(JSON.parse(result.stdout), { workers: [] });
          assert.equal(result.stderr, identity === 'hsq' ? '' : `[${identity}] '${identity}' is deprecated; use 'hsq' instead.\n`);
          await assert.rejects(execFile(file, [...args, 'invalid-compatibility-test-command'], { cwd: consumer, env, shell }),
            (error: unknown) => (error as { code?: number }).code === 1);
        }
      }
      if (bridge.name === old.npmPackage) {
        const frozen = stripTypeScriptTypes(readFileSync(new URL('../fixtures/v0.17.0-package-validator.ts.txt', import.meta.url), 'utf8'));
        const args = ['--input-type=module', '-e', `${frozen}\nvalidateInstalledPackage(process.argv[1], process.argv[2], process.argv[3]);`, shim, runtime.manifest.version, consumer];
        await execFile(process.execPath, args, { env });
        rmSync(join(shim, 'web/dist/assets'), { recursive: true });
        await assert.rejects(execFile(process.execPath, args, { env }), /staged web assets incomplete/);
      }
    }
    assert.equal(registryCalls, 0);
  } finally {
    server.closeAllConnections(); await promisify(server.close.bind(server))();
    rmSync(root, { recursive: true, force: true });
  }
});
