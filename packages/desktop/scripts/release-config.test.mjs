import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseConfig } from './release-config.mjs';
test('public releases never silently become unsigned', () => {
  for (const platform of ['darwin', 'win32', 'linux']) assert.throws(() => releaseConfig(platform, {}, false), /requires/);
});
test('dry-run installers need no secrets and macOS is sealed ad-hoc', () => {
  assert.deepEqual(releaseConfig('darwin', {}, true).bundle.macOS, { signingIdentity: '-' });
  assert.equal(releaseConfig('linux', {}, true).bundle.createUpdaterArtifacts, false);
  assert.deepEqual(releaseConfig('win32', {}, true).bundle.targets, ['nsis']);
});
test('each public platform requires its signing identity', () => {
  const env = { TAURI_SIGNING_PRIVATE_KEY: 'test', TAURI_SIGNING_PUBLIC_KEY: Buffer.from('untrusted comment: test\npublic-key').toString('base64') };
  assert.throws(() => releaseConfig('darwin', env, false), /APPLE_CERTIFICATE/);
  assert.throws(() => releaseConfig('win32', env, false), /WINDOWS_CERTIFICATE_THUMBPRINT/);
  assert.equal(releaseConfig('linux', env, false).bundle.createUpdaterArtifacts, true);
  assert.throws(() => releaseConfig('linux', {...env, TAURI_SIGNING_PUBLIC_KEY: 'junk'}, false), /exported Tauri/);
});

test('shell manifests agree before any installer is built', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = path => readFile(new URL(path, import.meta.url), 'utf8');
  const pkg = JSON.parse(await read('../package.json'));
  const lock = JSON.parse(await read('../package-lock.json'));
  const tauri = JSON.parse(await read('../src-tauri/tauri.conf.json'));
  const cargo = await read('../src-tauri/Cargo.toml');
  assert.equal(pkg.version, tauri.version);
  assert.equal(lock.version, tauri.version);
  assert.equal(lock.packages[''].version, tauri.version);
  assert.equal(cargo.match(/^version = "([^"]+)"/m)[1], tauri.version);
});
