import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopMetadata, rustMetadata } from './build-metadata.mjs';
import { releaseConfig } from './release-config.mjs';
import { releaseMetadata } from './release-metadata.mjs';

test('both desktop identities reach the release overlay and Rust without a second switch', () => {
  for (const rebrand of ['off', 'on']) {
    const metadata = desktopMetadata({ rebrand });
    const overlay = releaseConfig('linux', {}, true, metadata);
    const built = desktopMetadata({ rebrand, tauriConfig: overlay });
    assert.equal(built.rebrand, metadata.rebrand);
    assert.equal(built.desktopAppId, metadata.desktopAppId);
    assert.match(rustMetadata(built), new RegExp(`pub const REBRAND: bool = ${metadata.rebrand};`));
    assert.ok(rustMetadata(built).includes(JSON.stringify(metadata.npmPackage)));
    if (metadata.rebrand) {
      assert.equal(overlay.identifier, 'tools.hearsay.squawk');
      assert.equal(overlay.productName, 'Squawk');
      assert.ok(overlay.plugins.updater.endpoints[0].endsWith('/squawk-desktop-latest/squawk-desktop-latest.json'));
    } else {
      assert.deepEqual(overlay, { bundle: { targets: ['appimage', 'deb'], createUpdaterArtifacts: false } });
      assert.equal(metadata.feed, 'desktop-latest');
      assert.equal(metadata.artifactStem, 'cezarion');
      assert.equal(metadata.tagPrefix, 'desktop-v');
    }
  }
});
test('native metadata refuses unknown or conflicting identity overrides', () => {
  assert.throws(() => desktopMetadata({ rebrand: 'yes' }), /on or off/);
  assert.throws(() => desktopMetadata({ tauriConfig: { identifier: 'unknown' } }), /Unknown/);
  assert.throws(() => desktopMetadata({ rebrand: 'off', tauriConfig: { identifier: 'tools.hearsay.squawk' } }), /conflicts/);
});

test('bridge builds retain the old ID and carry a new-ID payload without a new feed', () => {
  const metadata = desktopMetadata({ bridge: true });
  assert.equal(metadata.rebrand, false);
  assert.equal(metadata.bridge, true);
  const overlay = releaseConfig('linux', {}, true, metadata);
  assert.deepEqual(overlay.bundle.resources, { '../bridge-payload/': 'bridge/' });
  const compiled = desktopMetadata({ tauriConfig: overlay });
  assert.equal(compiled.bridge, true);
  assert.equal(compiled.desktopAppId, 'tools.hearsay.cezarion');
  assert.ok(rustMetadata(compiled).includes('pub const BRIDGE: bool = true;'));
  assert.throws(() => desktopMetadata({ bridge: true, rebrand: 'on' }), /old app/);
  const signing = { TAURI_SIGNING_PRIVATE_KEY: 'test', TAURI_SIGNING_PUBLIC_KEY: Buffer.from('untrusted comment: test\npublic-key').toString('base64') };
  for (const releaseRebrand of [false, true]) {
    if (releaseRebrand) assert.equal(releaseConfig('linux', signing, false, metadata, releaseRebrand).bundle.createUpdaterArtifacts, true);
    else assert.throws(() => releaseConfig('linux', signing, false, metadata, releaseRebrand), /release switch/);
  }
});
test('release naming keeps old artifacts unchanged and isolates the new feed', () => {
  for (const rebrand of ['off', 'on']) {
    const metadata = releaseMetadata({ rebrand, version: '1.2.3' });
    const old = rebrand === 'off';
    assert.equal(metadata.tag, old ? 'desktop-v1.2.3' : 'squawk-desktop-v1.2.3');
    assert.equal(metadata.stem, old ? 'cezarion' : 'squawk');
    assert.equal(metadata.feed, old ? 'desktop-latest' : 'squawk-desktop-latest');
    assert.deepEqual(releaseMetadata({ rebrand, version: '1.2.3', eventName: 'push', refName: metadata.tag }), metadata);
    assert.throws(() => releaseMetadata({ rebrand, version: '1.2.3', eventName: 'push', refName: 'wrong' }), /does not match/);
  }
  assert.equal(releaseMetadata({ bridge: true, version: '1.2.3' }).tag, 'desktop-v1.2.3');
});
test('native smoke driver refuses to touch a normal host', async () => {
  const previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'false';
  try { await assert.rejects(import('./macos-bridge-smoke.mjs'), /disposable macOS CI runner/); }
  finally { if (previous === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previous; }
});
