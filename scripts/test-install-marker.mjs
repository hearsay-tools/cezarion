import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Script-only sandbox bootstrap, before product imports or test-file mocks. */
export function ensureTestInstallMarker(root) {
  // The release gate can be mocked per test. Prepare both layouts without importing it.
  const roots = [root, join(root, 'config')];
  for (const candidate of roots) validateMarker(candidate);
  for (const candidate of roots) ensureMarker(candidate);
}

/** Never downgrade a live/dev marker in either layout. */
function validateMarker(root) {
  const path = join(root, 'install.json');
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8'));
    if (marker.kind !== 'test') throw new Error(`Refusing benchmark/test home with a ${marker.kind} install marker: ${root}`);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

function ensureMarker(root) {
  if (validateMarker(root)) return;
  const path = join(root, 'install.json');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify({ installId: randomUUID(), kind: 'test', createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    ensureMarker(root);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/test-install-marker.mjs <sandbox-root>');
  ensureTestInstallMarker(process.argv[2]);
}
