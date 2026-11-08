#!/usr/bin/env node
// Runs only on a disposable macOS CI runner. A real HttpOnly persistent cookie and local
// storage cross bundle IDs. No release or feed is read or written.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { desktopMetadata } from './build-metadata.mjs';
import { releaseConfig } from './release-config.mjs';

if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Run this fixture on a disposable macOS CI runner');
const root = mkdtempSync(join(tmpdir(), 'desktop-bridge-'));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
function run(program, args, env = process.env) {
  const result = spawnSync(program, args, { stdio: 'inherit', env, timeout: 1_800_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited ${result.status}`);
}
try {
  const programs = {};
  for (const rebrand of ['off', 'on']) {
    const metadata = desktopMetadata({ rebrand });
    const config = { ...releaseConfig('darwin', {}, true, metadata), identifier: metadata.desktopAppId, productName: metadata.displayName };
    config.bundle.targets = ['app'];
    const overlay = join(root, `${rebrand}.json`);
    writeFileSync(overlay, JSON.stringify(config));
    const target = join(root, 'target');
    run('npm', ['run', 'build', '--', '--debug', '--features', 'bridge-fixture', '--config', overlay], { ...process.env, CARGO_TARGET_DIR: target });
    const app = join(target, 'debug/bundle/macos', `${metadata.displayName}.app`);
    const snapshot = join(root, `${metadata.displayName}.app`);
    cpSync(app, snapshot, { recursive: true });
    programs[rebrand] = join(snapshot, 'Contents/MacOS', metadata.desktopExecutable);
  }
  const env = { ...process.env, CEZ_HOME: join(root, 'legacy'), HSQ_HOME: join(root, 'preferred') };
  const args = mode => ['--desktop-browser-fixture', mode, '--fixture-dir', root, '--fixture-port', String(port)];
  run(programs.off, args('seed'), env);
  run(programs.off, args('transfer'), env);
  run(programs.on, args('verify'), env);
  // A second transfer must not replace the profile the new app just opened.
  run(programs.off, args('transfer'), env);
  run(programs.on, args('verify'), env);
  console.log('PASS: geometry, UUID, trust origin, HttpOnly cookie and local storage survived; repeat transfer passed');
} finally {
  try {
    const id = readFileSync(join(root, 'connection-id'), 'utf8');
    for (const rebrand of ['off', 'on']) {
      const metadata = desktopMetadata({ rebrand });
      // Remove only this fixture UUID, never the bundle root or another profile.
      rmSync(join(process.env.HOME, 'Library/WebKit', metadata.desktopAppId, 'WebsiteDataStore', id), { recursive: true, force: true });
    }
  } catch { /* A failed seed may not have created a UUID. */ }
  rmSync(root, { recursive: true, force: true });
}
