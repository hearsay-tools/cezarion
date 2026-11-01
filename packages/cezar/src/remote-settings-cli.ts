import { z } from 'zod';
import { disableRemoteSettings, enableRemoteSettings, readRemoteSettings, type RemoteSettingsState } from './remote-settings.ts';
import { COCKPIT_PORTS } from './task-cli/discovery.ts';

/**
 * `cez remote-settings enable | status | disable` (hearsay-tools/cezarion#2428): the host operator's
 * switch for editing Agent config and worktree setup from a remote cockpit. It runs on the machine
 * that runs Cezarion, as the same user (and the same `CEZ_HOME`) as the cockpit service. One JSON
 * object per invocation; exit 0 ok, 64 usage.
 */

export const REMOTE_SETTINGS_WARNING =
  'Anyone the cockpit admits can now save agent hooks, MCP servers and worktree setup commands that run on this machine as this user. Keep the cockpit behind owner-only Tailscale access or an authenticated HTTPS proxy, bound to loopback.';

const USAGE = `cez remote-settings — let a remote cockpit (CEZ_REMOTE=1) edit Agent config and worktree setup.
One JSON object per invocation; exit 0 ok, 64 usage.

  enable    allow remote edits (takes effect on the next request; no restart)
  status    show the switch and what each running cockpit on this machine does with it
  disable   make those settings read-only again on remote cockpits

Run it on the machine that runs Cezarion, as the cockpit's user. It applies only to a cockpit bound
to loopback (127.0.0.1) behind owner-only Tailscale access or an authenticated HTTPS proxy.`;

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

/** What one cockpit does with the switch, in one line. */
export function cockpitEffect(cockpit: CockpitHealth, state: RemoteSettingsState): string {
  if (cockpit.localHandoff) return 'local cockpit: settings are editable without the switch';
  if (cockpit.settingsAdmin === undefined) return 'this cockpit is older than the switch and keeps settings read-only';
  if (cockpit.settingsAdmin) return 'remote cockpit: remote settings administration is in effect';
  if (state.enabled) {
    return 'remote cockpit: settings stay read-only because it binds a non-loopback host, or it reads another CEZ_HOME';
  }
  return 'remote cockpit: settings are read-only';
}

function stateBody(state: RemoteSettingsState) {
  return {
    enabled: state.enabled,
    ...(state.enabledAt ? { enabledAt: state.enabledAt } : {}),
    path: state.path,
    ...(state.issue ? { issue: state.issue } : {}),
  };
}

export async function runRemoteSettingsCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: RemoteSettingsIo = { stdout: (line) => console.log(line) },
): Promise<number> {
  const print = (body: unknown) => io.stdout(JSON.stringify(body, null, 2));
  const [command, ...rest] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    io.stdout(USAGE);
    return 0;
  }
  if (rest.length > 0 || (command !== 'enable' && command !== 'status' && command !== 'disable')) {
    print({
      ok: false,
      code: 'invalid_input',
      error: command === undefined ? 'missing command (enable, status, disable)' : `unknown arguments "${argv.join(' ')}"`,
      usage: USAGE,
    });
    return 64;
  }
  if (command === 'enable') {
    print({ ok: true, ...stateBody(await enableRemoteSettings(env)), warning: REMOTE_SETTINGS_WARNING });
    return 0;
  }
  if (command === 'disable') {
    print({ ok: true, ...stateBody(await disableRemoteSettings(env)) });
    return 0;
  }
  const state = readRemoteSettings(env);
  const cockpits = await (io.cockpits ?? scanCockpits)(env);
  print({
    ok: true,
    ...stateBody(state),
    cockpits: cockpits.map((cockpit) => ({
      url: cockpit.url,
      remote: !cockpit.localHandoff,
      settingsAdmin: cockpit.settingsAdmin ?? cockpit.localHandoff,
      effect: cockpitEffect(cockpit, state),
    })),
  });
  return 0;
}
