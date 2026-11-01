/**
 * The host grants for remote settings administration (hearsay-tools/cezarion#2428).
 *
 * A remote cockpit (`CEZ_REMOTE=1`) keeps Agent config and worktree setup read-only, because both
 * persist commands the host runs outside an agent's tool permissions. The host operator can grant
 * those two settings to the users one cockpit admits by running `cez remote-settings enable`, which
 * writes `~/.cezar/remote-settings/<port>.json` for that cockpit's listen port. The grant names a
 * port because cockpits on one host can share a home: the multi-domain installer runs one service
 * per domain, each with its own port and login, under the same user. No HTTP route writes these
 * files, so a browser can never grant itself the permission.
 *
 * One file per port keeps every change a single create, rename or remove: two `enable` or `disable`
 * runs at once never read and rewrite each other's grants. The server reads the file for its own
 * port on each capability read, so enable and disable take effect without a restart. Reads fail
 * closed: a missing, malformed or unreadable file grants nothing.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { cezarHomeDir } from './paths.ts';

export const REMOTE_SETTINGS_DIR = 'remote-settings';

const GRANT_FILE = /^([1-9]\d{0,4})\.json$/;
const grantSchema = z.object({ enabledAt: z.string().optional() });

export interface RemoteSettingsGrant { port: number; enabledAt?: string }

export interface RemoteSettingsState {
  /** The cockpit ports the host operator granted, ascending. */
  grants: RemoteSettingsGrant[];
  /** The directory that holds one grant file per port. */
  path: string;
  /** Why a file in the directory grants nothing. */
  issue?: string;
}

export function remoteSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), REMOTE_SETTINGS_DIR);
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function grantFile(env: NodeJS.ProcessEnv, port: number): string {
  return join(remoteSettingsPath(env), `${port}.json`);
}

/** The grant in one port's file, or why it grants nothing. Never throws. */
function readGrant(path: string, port: number): RemoteSettingsGrant | { issue: string } | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { issue: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const parsed = grantSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { port, ...(parsed.data.enabledAt ? { enabledAt: parsed.data.enabledAt } : {}) };
  } catch {
    // falls through to the issue below
  }
  return { issue: `${path} is not a grant ({"enabledAt": "<time>"})` };
}

/** True when the host operator granted the cockpit listening on `port`. Read per call. */
export function isPortGranted(env: NodeJS.ProcessEnv, port: number | undefined): boolean {
  if (port === undefined || !isPort(port)) return false;
  const grant = readGrant(grantFile(env, port), port);
  return grant !== null && 'port' in grant;
}

/** True when the state lists `port`. */
export function isGranted(state: RemoteSettingsState, port: number | undefined): boolean {
  return port !== undefined && state.grants.some((grant) => grant.port === port);
}

/** Every grant on this host. Never throws. */
export function readRemoteSettings(env: NodeJS.ProcessEnv = process.env): RemoteSettingsState {
  const path = remoteSettingsPath(env);
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return { grants: [], path };
  }
  const grants: RemoteSettingsGrant[] = [];
  const issues: string[] = [];
  for (const name of names) {
    const match = GRANT_FILE.exec(name);
    if (!match || !isPort(Number(match[1]))) continue; // temporary files and anything else
    const grant = readGrant(join(path, name), Number(match[1]));
    if (grant === null) continue;
    if ('issue' in grant) issues.push(grant.issue);
    else grants.push(grant);
  }
  grants.sort((a, b) => a.port - b.port);
  return { grants, path, ...(issues.length > 0 ? { issue: issues.join('; ') } : {}) };
}

/** Grant the cockpit listening on `port`. The rename makes the file appear whole. */
export async function enableRemoteSettings(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<RemoteSettingsState> {
  if (!isPort(port)) throw new RangeError(`not a port: ${port}`);
  const dir = remoteSettingsPath(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.${port}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ enabledAt: now.toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, grantFile(env, port));
  return readRemoteSettings(env);
}

/** Withdraw the grant for `port`, or every grant when no port is given. */
export async function disableRemoteSettings(env: NodeJS.ProcessEnv = process.env, port?: number): Promise<RemoteSettingsState> {
  if (port === undefined) await rm(remoteSettingsPath(env), { recursive: true, force: true });
  else await rm(grantFile(env, port), { force: true });
  return readRemoteSettings(env);
}
