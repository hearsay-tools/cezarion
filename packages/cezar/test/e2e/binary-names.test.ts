import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Home } from '../../src/home/home.ts';
import { BINARY_NAMES } from '../../src/home/identity.ts';
import { shellQuote } from '../../src/core/shell-env.ts';
import { posixLauncher, windowsLauncher } from '../../src/managed-install/launcher.ts';

const execFile = promisify(execFileCallback);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const binExtension = process.platform === 'win32' ? '.cmd' : '';
const targetIdentities = { cezarion: 'cez', cez: 'cez', hsq: 'hsq' };
const npmIdentities = process.platform === 'win32' ? targetIdentities : { cezarion: 'cezarion', cez: 'cez', hsq: 'hsq' };

async function pack(cwd: string, destination: string): Promise<string> {
  const result = await execFile(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], { cwd, shell: process.platform === 'win32' });
  const records = JSON.parse(result.stdout) as Array<{ filename: string }>;
  return join(destination, records[0]!.filename);
}

type BinaryRun = (file: string, args: string[], shell?: boolean) => Promise<{ stdout: string; stderr: string }>;
type Entry = [file: string, prefixArgs: string[], shell: boolean, identity?: string];

async function verifyBinary(run: BinaryRun, entries: Entry[], name: string): Promise<void> {
  for (const [file, pre, shell, identity = name] of entries) {
    const result = await run(file, [...pre, 'worker', 'list'], shell);
    assert.deepEqual(JSON.parse(result.stdout), { workers: [] }, `${name}: stdout must contain only JSON`);
    const expected = identity !== 'hsq' ? `[${identity}] '${identity}' is deprecated; use 'hsq' instead.\n` : '';
    assert.equal(result.stderr, expected, `${name}, ${pre[0] ?? file}`);
    const help = await run(file, [...pre, '--help'], shell);
    assert.ok(help.stdout.includes(`  ${identity} run "<task>"`));
    assert.equal(help.stderr, expected);
    const manifest = JSON.parse(await readFile(join(repo, 'packages/cezar/package.json'), 'utf8')) as { version: string };
    for (const flag of ['--version', '-v']) {
      const version = await run(file, [...pre, flag], shell);
      assert.equal(version.stdout, `${manifest.version}\n`);
      assert.equal(version.stderr, expected);
    }
    const subHelp = await run(file, [...pre, 'worker', '--help'], shell);
    assert.ok(subHelp.stdout.includes(`  ${identity} worker spawn`));
    assert.equal(subHelp.stderr, expected);
  }
}

// bound: the former three-state matrix measured 85.10s in CI and 37.75s locally; one state needs less.
test('packed, alias, linked and managed binaries retain their name and keep notices off JSON stdout', { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'binary-names-e2e-'));
  const token = 'p'.repeat(43);
  const server = createServer((request, response) => {
    assert.equal(request.url, '/api/v1/delegation/list');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"workers":[]}');
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const consumer = join(root, 'consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), '{"private":true}');
    const tarball = await pack(join(repo, 'packages/cezar'), root);
    await execFile(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball], { cwd: consumer, shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024 });
    const scoped = join(consumer, 'node_modules/@wjarka/cezarion');
    const scopedManifest = JSON.parse(await readFile(join(scoped, 'package.json'), 'utf8')) as { version: string; bin: Record<string, string> };
    // Run the stable release's frozen validator against the installed tarball.
    const shippedValidator = stripTypeScriptTypes(await readFile(new URL('../fixtures/v0.17.0-package-validator.ts.txt', import.meta.url), 'utf8'));
    const validatorArgs = ['--input-type=module', '-e', `${shippedValidator}\nvalidateInstalledPackage(process.argv[1], process.argv[2], process.argv[3]);`, scoped, scopedManifest.version, consumer];
    await execFile(process.execPath, validatorArgs);
    await writeFile(join(scoped, 'package.json'), JSON.stringify({ ...scopedManifest, bin: { hsq: 'dist/hsq.js' } }));
    await assert.rejects(execFile(process.execPath, validatorArgs), /staged CLI entry missing/);
    await writeFile(join(scoped, 'package.json'), JSON.stringify(scopedManifest));
    const alias = join(consumer, 'node_modules/cezarion');
    await mkdir(alias);
    // Install the real alias files beside the packed dependency without contacting a registry for its unpublished version.
    for (const file of ['package.json', 'bin.js', ...BINARY_NAMES.map(name => `${name}.js`)]) {
      await copyFile(join(repo, 'alias-cezarion', file), join(alias, file));
    }
    const aliasManifest = JSON.parse(await readFile(join(alias, 'package.json'), 'utf8')) as { bin: Record<string, string> };
    const prefix = join(root, 'prefix');
    await mkdir(join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules'), { recursive: true });
    await writeFile(join(prefix, 'package.json'), '{"private":true}');
    await execFile(npm, ['link', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', scoped], { cwd: consumer, shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024 });
    const home = Home.sandbox(join(root, 'managed'));
    const managedPackage = join(home.data, 'versions/installed/node_modules/@wjarka/cezarion');
    await mkdir(dirname(managedPackage), { recursive: true });
    await symlink(scoped, managedPackage, process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(join(home.data, 'versions/installed'), join(home.data, 'versions/current'), process.platform === 'win32' ? 'junction' : 'dir');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CEZ_|HSQ_)/i.test(key)));
    env.HOME = root;
    env.HSQ_DELEGATION_URL = `http://127.0.0.1:${address.port}/api/v1/delegation`;
    env.HSQ_DELEGATION_TOKEN = token;
    env.HSQ_TASK_ID = '11111111-1111-4111-8111-111111111111';
    const run = async (file: string, args: string[], shell = false) => execFile(file, args, { cwd: consumer, env, shell, maxBuffer: 10 * 1024 * 1024 });
    for (const name of BINARY_NAMES) {
      const managed = join(root, `${name}${binExtension}`);
      await writeFile(managed, process.platform === 'win32' ? windowsLauncher({}, home, name) : posixLauncher({}, home, name));
      await chmod(managed, 0o755);
      // Like npm's Windows cmd/ps1/sh wrappers, pass the bin target to Node.
      const targetShim = join(root, `target-${name}${binExtension}`);
      const target = join(scoped, scopedManifest.bin[name]!);
      await writeFile(targetShim, process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`
        : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(target)} "$@"\n`);
      await chmod(targetShim, 0o755);
    }
    for (const name of BINARY_NAMES) {
      const managed = join(root, `${name}${binExtension}`);
      if (process.platform !== 'win32') {
        const used = await run(managed, ['use', 'installed']);
        assert.ok(used.stdout.includes('now using installed'));
        assert.equal(used.stderr, name !== 'hsq' ? `[${name}] '${name}' is deprecated; use 'hsq' instead.\n` : '');
      }
    }
    // Keep shared version-link writes serial, then check the three independent names in parallel.
    const checks: Promise<void>[] = [];
    for (const name of BINARY_NAMES) {
      assert.equal(scopedManifest.bin[name], name === 'hsq' ? 'dist/hsq.js' : 'dist/index.js');
      assert.equal(aliasManifest.bin[name], `${name}.js`);
      const managed = join(root, `${name}${binExtension}`);
      const linked = process.platform === 'win32' ? join(prefix, `${name}.cmd`) : join(prefix, 'bin', name);
      const installed = join(consumer, 'node_modules/.bin', name + binExtension);
      const entries: Entry[] = [
        [process.execPath, [join(scoped, 'dist', `${name}.js`)], false],
        [installed, [], process.platform === 'win32', npmIdentities[name]],
        [process.execPath, [join(alias, aliasManifest.bin[name]!)], false],
        [managed, [], process.platform === 'win32'],
        [linked, [], process.platform === 'win32', npmIdentities[name]],
        [join(root, `target-${name}${binExtension}`), [], process.platform === 'win32', targetIdentities[name]],
      ];
      checks.push(verifyBinary(run, entries, name));
    }
    // Drain every child before removing the installation, even on failure.
    for (const result of await Promise.allSettled(checks)) {
      if (result.status === 'rejected') throw result.reason;
    }
  } finally {
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
    await rm(root, { recursive: true, force: true });
  }
});
