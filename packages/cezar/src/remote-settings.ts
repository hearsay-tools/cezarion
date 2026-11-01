/**
 * The host switch for remote settings administration (hearsay-tools/cezarion#2428).
 *
 * A remote cockpit (`CEZ_REMOTE=1`) keeps Agent config and worktree setup read-only, because both
 * persist commands the host runs outside an agent's tool permissions. The host operator can grant
 * those two settings to the users one cockpit admits by running `cez remote-settings enable`, which
 * records that cockpit's listen port in `~/.cezar/remote-settings.json`. The grant names a port
 * because cockpits on one host can share a home: the multi-domain installer runs one service per
 * domain, each with its own port and login, under the same user. No HTTP route writes this file, so
 * a browser can never grant itself the permission.
 *
 * The server reads the file on each capability read, so enable and disable take effect without a
 * restart. Reads fail closed: a missing, malformed or unreadable file grants nothing.
 */

import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { cezarHomeDir } from './paths.ts';

export const REMOTE_SETTINGS_FILE = 'remote-settings.json';

const portKey = z.string().regex(/^[1-9]\d{0,4}$/).refine((key) => Number(key) <= 65_535);
const fileSchema = z.object({
  cockpits: z.record(portKey, z.object({ enabledAt: z.string().optional() })),
});
type RemoteSettingsFile = z.infer<typeof fileSchema>;

export interface RemoteSettingsGrant { port: number; enabledAt?: string }

export interface RemoteSettingsState {
  /** The cockpit ports the host operator granted, ascending. */
  grants: RemoteSettingsGrant[];
  path: string;
  /** Why an existing file grants nothing. */
  issue?: string;
}

export function remoteSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), REMOTE_SETTINGS_FILE);
}

/** True when the state grants the cockpit listening on `port`. */
export function isGranted(state: RemoteSettingsState, port: number | undefined): boolean {
  return port !== undefined && state.grants.some((grant) => grant.port === port);
}

/** The last read per path, reused while the file's modification time and size stay the same. */
const cache = new Map<string, { mtimeMs: number; size: number; state: RemoteSettingsState }>();

/** The grants as the host file says. Never throws. */
export function readRemoteSettings(env: NodeJS.ProcessEnv = process.env): RemoteSettingsState {
  const path = remoteSettingsPath(env);
  let mtimeMs: number;
  let size: number;
  try {
    ({ mtimeMs, size } = statSync(path));
  } catch {
    cache.delete(path);
    return { grants: [], path };
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
    return { grants: [], path, issue: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return { grants: [], path, issue: `${path} does not hold {"cockpits": {"<port>": {}}}` };
  return { grants: grantsOf(parsed.data), path };
}

function grantsOf(file: RemoteSettingsFile): RemoteSettingsGrant[] {
  return Object.entries(file.cockpits)
    .map(([port, grant]) => ({ port: Number(port), ...(grant.enabledAt ? { enabledAt: grant.enabledAt } : {}) }))
    .sort((a, b) => a.port - b.port);
}

/** The file's grants for a rewrite. A file that grants nothing starts over. */
async function currentGrants(path: string): Promise<RemoteSettingsFile['cockpits']> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data.cockpits : {};
  } catch {
    return {};
  }
}

/** Writes through a temporary file, so a reader never sees half a file. */
async function writeGrants(path: string, cockpits: RemoteSettingsFile['cockpits']): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ cockpits }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** Grant the cockpit listening on `port`. */
export async function enableRemoteSettings(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<RemoteSettingsState> {
  const path = remoteSettingsPath(env);
  const cockpits = await currentGrants(path);
  await writeGrants(path, { ...cockpits, [String(port)]: { enabledAt: now.toISOString() } });
  return readRemoteSettings(env);
}

/** Withdraw the grant for `port`, or every grant when no port is given. */
export async function disableRemoteSettings(env: NodeJS.ProcessEnv = process.env, port?: number): Promise<RemoteSettingsState> {
  const path = remoteSettingsPath(env);
  const cockpits = port === undefined ? {} : await currentGrants(path);
  if (port !== undefined) delete cockpits[String(port)];
  if (Object.keys(cockpits).length === 0) await rm(path, { force: true });
  else await writeGrants(path, cockpits);
  return readRemoteSettings(env);
}
