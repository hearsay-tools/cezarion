import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('installed package resolves its macOS destroy helper', { skip: process.platform !== 'darwin', timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'cez-mac-package-'));
  const target = join(root, 'locked');
  try {
    const packDir = join(root, 'pack'), consumer = join(root, 'consumer');
    await mkdir(packDir); await mkdir(consumer); await writeFile(join(consumer, 'package.json'), '{"private":true}');
    const packed = await execFile('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], { cwd: packageDir });
    const records = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const record = records[0]; assert.ok(record);
    assert.ok(record.files.some(file => file.path === 'scripts/darwin-destroy-chmod.js'));
    await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', join(packDir, record.filename)], { cwd: consumer });
    const installed = join(consumer, 'node_modules/@wjarka/cezarion');
    const helper = await import(pathToFileURL(join(installed, 'dist/delegation/darwin-destroy-chmod.js')).href) as { darwinDestroyChmod(path: string): Promise<void> };
    await mkdir(target); await chmod(target, 0);
    const before = await lstat(target, { bigint: true }); await helper.darwinDestroyChmod(target);
    const after = await lstat(target, { bigint: true });
    assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev); assert.equal(after.mode & 0o777n, 0o700n);
  } finally { try { await chmod(target, 0o700); } catch {} await rm(root, { recursive: true, force: true }); }
});
