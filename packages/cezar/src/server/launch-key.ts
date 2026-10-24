import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Per-project random capability for bookmarklet auto-start. A link without the matching key may
 * prefill the composer but must not auto-start a run.
 */
export function ensureLaunchKey(dataDir: string): string {
  const path = join(dataDir, 'launch-key');
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim();
      if (existing) return existing;
    }
  } catch {
    // unreadable — fall through and regenerate
  }
  const key = randomUUID();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600); // best-effort — mode is ignored on pre-existing files
  } catch {
    // non-fatal: the key still protects auto-start for this process lifetime
  }
  return key;
}
