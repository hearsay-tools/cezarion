import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { accountProtectedRoots, ensureTestInstallMarker } from './test-install-marker.mjs';

test('script sandboxes create a stable private marker and refuse an inherited live marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-script-marker-'));
  const path = join(root, 'install.json');
  try {
    ensureTestInstallMarker(root);
    const before = readFileSync(path, 'utf8');
    const splitPath = join(root, 'config', 'install.json');
    const splitBefore = readFileSync(splitPath, 'utf8');
    assert.equal(JSON.parse(splitBefore).kind, 'test');
    assert.equal(JSON.parse(before).kind, 'test');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    ensureTestInstallMarker(root);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(readFileSync(splitPath, 'utf8'), splitBefore);
    writeFileSync(splitPath, JSON.stringify({ ...JSON.parse(splitBefore), kind: 'live' }));
    assert.throws(() => ensureTestInstallMarker(root), /Refusing.*live install marker/);
    writeFileSync(splitPath, splitBefore);
    const live = JSON.stringify({ ...JSON.parse(before), kind: 'live' });
    writeFileSync(path, live);
    assert.throws(() => ensureTestInstallMarker(root), /Refusing.*live install marker/);
    assert.equal(readFileSync(path, 'utf8'), live);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('a live split marker refuses before writing an unmarked base', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-script-split-marker-'));
  const config = join(root, 'config');
  const live = JSON.stringify({ installId: 'live-split', kind: 'live' });
  try {
    mkdirSync(config);
    writeFileSync(join(config, 'install.json'), live);
    assert.throws(() => ensureTestInstallMarker(root), /Refusing.*live install marker/);
    assert.equal(existsSync(join(root, 'install.json')), false);
    assert.equal(readFileSync(join(config, 'install.json'), 'utf8'), live);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the script refuses the account home and its symlink aliases before any read or write', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'cez-script-account-'));
  const account = join(fixture, 'account');
  const legacy = join(account, '.cezar');
  const real = os.userInfo;
  // Simulate the account home: the guard reads it from the OS, never from HOME.
  os.userInfo = (...args) => ({ ...real(...args), homedir: account });
  syncBuiltinESMExports();
  try {
    assert.equal(accountProtectedRoots()[0], legacy, 'the account home mock must be active');
    for (const root of accountProtectedRoots()) {
      assert.throws(() => ensureTestInstallMarker(root), /refusing to write a test install marker/);
      if (root.startsWith(account)) assert.equal(existsSync(root), false);
    }
    // The host case: a wrong test marker on the real home is refused, not reused, and stays as it was.
    mkdirSync(legacy, { recursive: true });
    const marker = JSON.stringify({ installId: 'canary', kind: 'test' });
    writeFileSync(join(legacy, 'install.json'), marker);
    assert.throws(() => ensureTestInstallMarker(legacy), /refusing to write a test install marker/);
    assert.equal(existsSync(join(legacy, 'config')), false);
    assert.equal(readFileSync(join(legacy, 'install.json'), 'utf8'), marker);
    symlinkSync(legacy, join(fixture, 'alias'), 'dir');
    assert.throws(() => ensureTestInstallMarker(join(fixture, 'alias')), /refusing to write a test install marker/);
    symlinkSync(account, join(fixture, 'account-alias'), 'dir');
    assert.throws(() => ensureTestInstallMarker(join(fixture, 'account-alias', '.cezar')), /refusing to write a test install marker/);
    ensureTestInstallMarker(join(fixture, 'sandbox'));
    assert.equal(JSON.parse(readFileSync(join(fixture, 'sandbox', 'install.json'), 'utf8')).kind, 'test');
  } finally {
    os.userInfo = real;
    syncBuiltinESMExports();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the script fails closed when the OS gives no absolute account home', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'cez-script-no-home-'));
  const real = os.userInfo;
  try {
    for (const homedir of ['', 'relative-home']) {
      os.userInfo = (...args) => ({ ...real(...args), homedir });
      syncBuiltinESMExports();
      assert.throws(() => ensureTestInstallMarker(join(fixture, 'sandbox')), /refusing to write a test install marker/);
      assert.equal(existsSync(join(fixture, 'sandbox')), false);
    }
  } finally {
    os.userInfo = real;
    syncBuiltinESMExports();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('on macOS the script refuses an absent account root spelled in another case', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'cez-script-case-'));
  const account = join(fixture, 'account');
  const realInfo = os.userInfo;
  const realType = os.type;
  os.userInfo = (...args) => ({ ...realInfo(...args), homedir: account });
  os.type = () => 'Darwin';
  syncBuiltinESMExports();
  try {
    // A fresh instance reads the mocked platform at load.
    const darwin = await import('./test-install-marker.mjs?darwin');
    assert.equal(darwin.accountProtectedRoots()[0], join(account, '.cezar'), 'the account home mock must be active');
    for (const root of [join(account, '.CEZAR'), join(account, 'Library', 'Caches', 'HEARSAY SQUAWK')]) {
      assert.throws(() => darwin.ensureTestInstallMarker(root), /refusing to write a test install marker/);
    }
    assert.equal(existsSync(join(account, '.CEZAR')), false);
  } finally {
    os.userInfo = realInfo;
    os.type = realType;
    syncBuiltinESMExports();
    rmSync(fixture, { recursive: true, force: true });
  }
});
