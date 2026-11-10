import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureTestInstallMarker } from './test-install-marker.mjs';

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
