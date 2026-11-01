/**
 * The host switch for remote settings administration (hearsay-tools/cezarion#2428).
 *
 * A remote cockpit (`CEZ_REMOTE=1`) keeps Agent config and worktree setup read-only, because both
 * persist commands the host runs outside an agent's tool permissions. The host operator can grant
 * those two settings to the users the deployment admits by running `cez remote-settings enable`,
 * which writes `~/.cezar/remote-settings.json`. No HTTP route writes this file, so a browser can
 * never grant itself the permission.
 *
 * The server reads the file on each capability read, so enable and disable take effect without a
 * restart. Reads fail closed: a missing, malformed or unreadable file means off.
 */

import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { cezarHomeDir } from './paths.ts';

export const REMOTE_SETTINGS_FILE = 'remote-settings.json';

const fileSchema = z.object({ enabled: z.literal(true), enabledAt: z.string().optional() });

export interface RemoteSettingsState {
  enabled: boolean;
  enabledAt?: string;
  path: string;
  /** Why an existing file counts as off. */
  issue?: string;
}

export function remoteSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), REMOTE_SETTINGS_FILE);
}

/** The last read per path, reused while the file's modification time and size stay the same. */
const cache = new Map<string, { mtimeMs: number; size: number; state: RemoteSettingsState }>();

/** The switch as the host file says. Never throws. */
export function readRemoteSettings(env: NodeJS.ProcessEnv = process.env): RemoteSettingsState {
  const path = remoteSettingsPath(env);
  let mtimeMs: number;
  let size: number;
  try {
    ({ mtimeMs, size } = statSync(path));
  } catch {
    cache.delete(path);
    return { enabled: false, path };
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.state;
  const state = parseFile(path);
  cache.set(path, { mtimeMs, size, state });
  return state;
}

function parseFile(path: string): RemoteSettingsState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { enabled: false, path, issue: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return { enabled: false, path, issue: `${path} does not hold {"enabled": true}` };
  return { enabled: true, path, ...(parsed.data.enabledAt ? { enabledAt: parsed.data.enabledAt } : {}) };
}

/** Turn the switch on. Writes through a temporary file, so a reader never sees half a file. */
export async function enableRemoteSettings(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<RemoteSettingsState> {
  const path = remoteSettingsPath(env);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ enabled: true, enabledAt: now.toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return readRemoteSettings(env);
}

/** Turn the switch off by removing the file. */
export async function disableRemoteSettings(env: NodeJS.ProcessEnv = process.env): Promise<RemoteSettingsState> {
  await rm(remoteSettingsPath(env), { force: true });
  return readRemoteSettings(env);
}
