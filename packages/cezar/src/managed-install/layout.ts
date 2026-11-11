import { productIdentity } from '../home/identity.ts';
/**
 * The managed install layout that `cez install` created and the desktop shell still uses:
 *
 *   <versions>/<id>/                       one `npm install --prefix` tree per version
 *   <versions>/<id>/.cezar-install.json    manifest: version, source, installedAt
 *   <versions>/current  →  <id>            the active version (a symlink; a junction on Windows)
 *   <bin>/cezar, cez, hsq                  launchers that exec `current`'s entry
 *
 * The cockpit no longer installs or switches versions here. The home migration still copies an
 * existing tree and rewrites its launchers (home/migrate.ts), and the desktop shell installs
 * into it on first start.
 */

import type { Home } from '../home/home.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Source checkouts keep this name in both switch states (decision D17).
export const PACKAGE_NAME = productIdentity(false).npmPackage;
export const CURRENT_LINK = 'current';
const MANIFEST_FILE = '.cezar-install.json';

export function versionsDir(env: NodeJS.ProcessEnv = process.env, home: Home): string {
  return home.versions;
}

export function binDir(env: NodeJS.ProcessEnv = process.env, home: Home): string {
  return home.bin;
}

/** A version id is a directory name under `versions/`: it must never climb out of it. */
export function assertSafeId(id: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(id) || id.includes('..')) throw new Error(`invalid version id: ${id}`);
  return id;
}

export function versionDir(id: string, env: NodeJS.ProcessEnv = process.env, home: Home): string {
  return join(versionsDir(env, home), assertSafeId(id));
}

const manifestSchema = z
  .object({
    version: z.string(),
    source: z.enum(['registry', 'local', 'link']),
    installedAt: z.string(),
    /** `link` only: the linked package root (`<worktree>/packages/cezar`) and its branch. */
    checkout: z.string().optional(),
    branch: z.string().optional(),
  })
  .passthrough();
export type InstallManifest = z.infer<typeof manifestSchema>;

export function readManifest(id: string, env: NodeJS.ProcessEnv = process.env, home: Home): InstallManifest | null {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(join(versionDir(id, env, home), MANIFEST_FILE), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
