import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Home } from '../../src/home/home.ts';
import { BINARY_NAMES } from '../../src/home/identity.ts';
import { posixLauncher, windowsLauncher } from '../../src/self-update/launcher.ts';

const execFile = promisify(execFileCallback);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function pack(cwd: string, destination: string): Promise<string> {
  const result = await execFile(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], { cwd, shell: process.platform === 'win32' });
  const records = JSON.parse(result.stdout) as Array<{ filename: string }>;
  return join(destination, records[0]!.filename);
}

type BinaryRun = (file: string, args: string[], shell?: boolean) => Promise<{ stdout: string; stderr: string }>;
type Entry = [file: string, prefixArgs: string[], shell: boolean];

async function verifyBinary(run: BinaryRun, entries: Entry[], name: string, rebrand: boolean): Promise<void> {
  for (const [file, pre, shell] of entries) {
    const result = await run(file, [...pre, 'worker', 'list'], shell);
    assert.deepEqual(JSON.parse(result.stdout), { workers: [] }, `${name}: stdout must contain only JSON`);
    const expected = rebrand && name !== 'hsq' ? `[${name}] '${name}' is deprecated; use 'hsq' instead.\n` : '';
    assert.equal(result.stderr, expected, `${name}, switch ${rebrand}, ${pre[0] ?? file}`);
    const help = await run(file, [...pre, '--help'], shell);
    const expectedName = rebrand || name === 'hsq' ? name : 'cez';
    assert.ok(help.stdout.includes(`  ${expectedName} run "<task>"`));
    assert.equal(help.stderr, expected);
    const subHelp = await run(file, [...pre, 'worker', '--help'], shell);
    assert.ok(subHelp.stdout.includes(`  ${expectedName} worker spawn`));
    assert.equal(subHelp.stderr, expected);
  }
}

// bound: npm pack/install/link and fresh CLI processes for both switch states need an outer hang guard.
test('packed, alias, linked and managed binaries retain their name and keep notices off JSON stdout', { timeout: 120_000 }, async () => {
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
    const scopedManifest = JSON.parse(await readFile(join(scoped, 'package.json'), 'utf8')) as { bin: Record<string, string> };
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
      const managed = join(root, `${name}${process.platform === 'win32' ? '.cmd' : ''}`);
      await writeFile(managed, process.platform === 'win32' ? windowsLauncher({}, home, name) : posixLauncher({}, home, name));
      await chmod(managed, 0o755);
    }
    // Reuse the same launchers across an upgrade and a downgrade.
    for (const rebrand of [false, true, false]) {
      // Only the installed test copy changes. The repository's release switch stays false.
      await writeFile(join(scoped, 'dist/home/switch.js'), `export const REBRAND_SWITCH = ${rebrand};\n`);
      for (const name of BINARY_NAMES) {
        assert.equal(scopedManifest.bin[name], `dist/${name}.js`);
        assert.equal(aliasManifest.bin[name], `${name}.js`);
        const managed = join(root, `${name}${process.platform === 'win32' ? '.cmd' : ''}`);
        if (process.platform !== 'win32') {
          const used = await run(managed, ['use', 'installed']);
          assert.ok(used.stdout.includes('now using installed'));
          assert.equal(used.stderr, rebrand && name !== 'hsq' ? `[${name}] '${name}' is deprecated; use 'hsq' instead.\n` : '');
        }
        const linked = process.platform === 'win32' ? join(prefix, `${name}.cmd`) : join(prefix, 'bin', name);
        const entries: Entry[] = [
          [process.execPath, [join(scoped, scopedManifest.bin[name]!)], false],
          [process.execPath, [join(alias, aliasManifest.bin[name]!)], false],
          [managed, [], process.platform === 'win32'],
          [linked, [], process.platform === 'win32'],
        ];
        await verifyBinary(run, entries, name, rebrand);
      }
    }
  } finally {
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
    await rm(root, { recursive: true, force: true });
  }
});
