import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopMetadata, rustMetadata } from './build-metadata.mjs';
import { releaseConfig } from './release-config.mjs';

test('both desktop identities reach the release overlay and Rust without a second switch', () => {
  for (const rebrand of ['off', 'on']) {
    const metadata = desktopMetadata({ rebrand });
    const overlay = releaseConfig('linux', {}, true, metadata);
    const built = desktopMetadata({ tauriConfig: overlay });
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
