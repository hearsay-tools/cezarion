import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  disableRemoteSettings,
  enableRemoteSettings,
  isGranted,
  readRemoteSettings,
  type RemoteSettingsState,
} from './remote-settings.ts';
import { COCKPIT_PORTS } from './task-cli/discovery.ts';

/**
 * `cez remote-settings enable | status | disable` (hearsay-tools/cezarion#2428): the host operator's
 * grant for editing Agent config and worktree setup from one remote cockpit, named by its listen
 * port. It runs on the machine that runs Cezarion, as the same user (and the same `CEZ_HOME`) as the
 * cockpit service. One JSON object per invocation; exit 0 ok, 2 refused, 64 usage.
 */

export const REMOTE_SETTINGS_WARNING =
  'Anyone this cockpit admits can now save agent hooks, MCP servers and worktree setup commands that run on this machine as this user. Keep the cockpit behind owner-only Tailscale access or an authenticated HTTPS proxy, bound to loopback.';

const USAGE = `cez remote-settings — let a remote cockpit (CEZ_REMOTE=1) edit Agent config and worktree setup.
One JSON object per invocation; exit 0 ok, 2 refused, 64 usage.

  enable [--port <n>]    allow remote edits on the cockpit listening on that port. Without --port,
                         the only remote cockpit running on 127.0.0.1 ports 4321–4370
  status                 show the grants and what each running cockpit on this machine does with them
  disable [--port <n>]   withdraw the grant for that port, or every grant without --port

Takes effect on the next request; no restart. Run it on the machine that runs Cezarion, as the
cockpit's user. It applies only to a cockpit bound to loopback behind owner-only Tailscale access or
an authenticated HTTPS proxy.`;

export interface CockpitHealth { url: string; localHandoff: boolean; settingsAdmin?: boolean | undefined }

export interface RemoteSettingsIo {
  stdout(line: string): void;
  /** Running cockpits on this machine; tests replace the loopback port scan. */
  cockpits?: (env: NodeJS.ProcessEnv) => Promise<CockpitHealth[]>;
}

const healthSchema = z.object({
  capabilities: z.object({ localHandoff: z.boolean(), settingsAdmin: z.boolean().optional() }),
});

const PROBE_TIMEOUT_MS = 800; // bound: one loopback health read per port; a silent port is not a cockpit

async function probe(url: string): Promise<CockpitHealth | null> {
  try {
    const res = await fetch(`${url}/api/v1/health`, { redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const parsed = healthSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    return { url, ...parsed.data.capabilities };
  } catch {
    return null;
  }
}

/** `CEZ_URL` when set, otherwise every cockpit answering on the loopback ports. */
export async function scanCockpits(env: NodeJS.ProcessEnv): Promise<CockpitHealth[]> {
  const urls = env.CEZ_URL ? [env.CEZ_URL.replace(/\/+$/, '')] : COCKPIT_PORTS.map((port) => `http://127.0.0.1:${port}`);
  return (await Promise.all(urls.map(probe))).filter((found): found is CockpitHealth => found !== null);
}

/** The listen port of a cockpit found on a loopback address; any other address names no grant. */
function loopbackPort(url: string): number | undefined {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'http:' || parsed.port === '') return undefined;
  return Number(parsed.port);
}

/** What one cockpit does with the grants, in one line. */
export function cockpitEffect(cockpit: CockpitHealth, state: RemoteSettingsState): string {
  if (cockpit.localHandoff) return 'local cockpit: settings are editable without a grant';
  if (cockpit.settingsAdmin === undefined) return 'this cockpit is older than remote settings administration and keeps settings read-only';
  if (cockpit.settingsAdmin) return 'remote cockpit: remote settings administration is in effect';
  if (isGranted(state, loopbackPort(cockpit.url))) {
    return 'remote cockpit: granted, but settings stay read-only because it binds a non-loopback host, or it reads another CEZ_HOME';
  }
  return 'remote cockpit: not granted, settings are read-only';
}

function stateBody(state: RemoteSettingsState) {
  return { grants: state.grants, path: state.path, ...(state.issue ? { issue: state.issue } : {}) };
}

class Refusal extends Error {
  constructor(readonly exitCode: number, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65_535) {
    throw new Error(`--port must be a port number (1–65535), not "${value}"`);
  }
  return Number(value);
}

/** `--port`, or the only remote cockpit running on the loopback ports. */
async function portToEnable(port: number | undefined, env: NodeJS.ProcessEnv, io: RemoteSettingsIo): Promise<number> {
  if (port !== undefined) return port;
  const remote = (await (io.cockpits ?? scanCockpits)({ ...env, CEZ_URL: '' }))
    .filter((cockpit) => !cockpit.localHandoff)
    .flatMap((cockpit) => loopbackPort(cockpit.url) ?? []);
  if (remote.length === 1) return remote[0]!;
  const error = remote.length === 0
    ? 'no remote cockpit (CEZ_REMOTE=1) answers on 127.0.0.1 ports 4321–4370; pass --port <n> with its listen port'
    : `several remote cockpits run on this machine (ports ${remote.join(', ')}); pass --port <n> to choose one`;
  throw new Refusal(2, { ok: false, code: 'choose_cockpit', error, ports: remote });
}

function parse(argv: string[]): { command: 'enable' | 'status' | 'disable'; port: number | undefined } {
  try {
    const { positionals, values } = parseArgs({ args: argv, options: { port: { type: 'string' } }, allowPositionals: true, strict: true });
    const [command, ...rest] = positionals;
    if (rest.length > 0 || (command !== 'enable' && command !== 'status' && command !== 'disable')) {
      throw new Error(command === undefined ? 'missing command (enable, status, disable)' : `unknown arguments "${argv.join(' ')}"`);
    }
    if (command === 'status' && values.port !== undefined) throw new Error('status takes no --port');
    return { command, port: parsePort(values.port) };
  } catch (error) {
    throw new Refusal(64, { ok: false, code: 'invalid_input', error: error instanceof Error ? error.message : String(error), usage: USAGE });
  }
}

async function run(argv: string[], env: NodeJS.ProcessEnv, io: RemoteSettingsIo): Promise<Record<string, unknown>> {
  const { command, port } = parse(argv);
  if (command === 'enable') {
    const granted = await portToEnable(port, env, io);
    return { ok: true, port: granted, ...stateBody(await enableRemoteSettings(granted, env)), warning: REMOTE_SETTINGS_WARNING };
  }
  if (command === 'disable') return { ok: true, ...stateBody(await disableRemoteSettings(env, port)) };
  const state = readRemoteSettings(env);
  const cockpits = await (io.cockpits ?? scanCockpits)(env);
  return {
    ok: true,
    ...stateBody(state),
    cockpits: cockpits.map((cockpit) => ({
      url: cockpit.url,
      remote: !cockpit.localHandoff,
      settingsAdmin: cockpit.settingsAdmin ?? cockpit.localHandoff,
      effect: cockpitEffect(cockpit, state),
    })),
  };
}

export async function runRemoteSettingsCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: RemoteSettingsIo = { stdout: (line) => console.log(line) },
): Promise<number> {
  if (['help', '--help', '-h'].includes(argv[0] ?? '')) {
    io.stdout(USAGE);
    return 0;
  }
  try {
    io.stdout(JSON.stringify(await run(argv, env, io), null, 2));
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.stdout(JSON.stringify(error.body, null, 2));
    return error.exitCode;
  }
}
