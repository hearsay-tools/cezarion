import { productName } from '../../home/display.ts';
import { type InstallContext } from '../types.ts';
import { StepAborted, sudoStep } from '../steps.ts';

/**
 * The `ubuntuVps.redeploy` helpers: resolve the systemd scope the recorded
 * service runs in, restart it (user scope directly, system scope through
 * `sudoStep`), and prove the restart actually happened.
 */

/** Read the unit's live `ExecStart` (read-only query; no sudo needed even for a
 *  system unit). Empty string when it can't be read — callers then skip the
 *  npx-cache refresh rather than guessing. */
export async function readExecStart(ctx: InstallContext, scope: 'user' | 'system', unit: string): Promise<string> {
  const args = [...(scope === 'user' ? ['--user'] : []), 'show', unit, '-p', 'ExecStart'];
  const { stdout } = await ctx.runner.capture('systemctl', args);
  return stdout;
}

export type ServiceSnapshot = { active: string | null; started: bigint | null };

/** Read-only even for a system unit; no sudo prompt during diagnosis. */
export async function serviceSnapshot(ctx: InstallContext, scope: 'user' | 'system', unit: string): Promise<ServiceSnapshot> {
  const args = [...(scope === 'user' ? ['--user'] : []), 'show', unit, '-p', 'ActiveState', '-p', 'ExecMainStartTimestampMonotonic'];
  const result = await ctx.runner.capture('systemctl', args);
  if (result.code !== 0) return { active: null, started: null };
  const fields = new Map(result.stdout.trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  const raw = fields.get('ExecMainStartTimestampMonotonic');
  return {
    active: fields.get('ActiveState') ?? null,
    started: raw && /^\d+$/.test(raw) ? BigInt(raw) : null,
  };
}

export async function failedRestart(ctx: InstallContext, scope: 'user' | 'system', unit: string, reason: string, sudoUsed = false): Promise<never> {
  let recent = 'recent journal unavailable';
  const args = [...(scope === 'user' ? ['--user'] : []), '-u', unit, '-n', '30', '--no-pager', '--output=short'];
  try {
    const ordinary = await ctx.runner.capture('journalctl', args);
    if (ordinary.code === 0 && ordinary.stdout.trim()) recent = ordinary.stdout.trim().split('\n').slice(-30).join('\n').slice(-6000);
  } catch { /* Diagnostics must not hide the restart failure. */ }
  // An unprivileged journalctl may exit 0 with "-- No entries --" and a
  // permission hint on stderr. Once this deploy used sudo for the restart,
  // prefer its noninteractive journal read; keep ordinary output on failure.
  if (scope === 'system' && sudoUsed) {
    try {
      const privileged = await ctx.runner.capture('sudo', ['-n', 'journalctl', ...args]);
      if (privileged.code === 0 && privileged.stdout.trim()) recent = privileged.stdout.trim().split('\n').slice(-30).join('\n').slice(-6000);
    } catch { /* Never let journal access hide the restart failure. */ }
  }
  throw new StepAborted(`${unit}: ${reason}\nRecent journal:\n${recent}`);
}

/** Resolve the systemd scope the recorded service artifact ran in. No recorded
 *  artifact (older record, or the step was check()-satisfied): prefer the scope
 *  whose unit file actually exists (`userUnitExists` — the caller reads it
 *  beside its other OS-user unit paths) — the user unit is the install
 *  default, so defaulting to `system` would sudo-restart a unit that was
 *  never installed. */
export function resolveRedeployScope(ctx: InstallContext, userUnitExists: boolean): 'user' | 'system' {
  const svc = (ctx.state.steps['autostart']?.created?.artifacts ?? []).find((a) => a.type === 'service');
  return svc?.scope === 'user' || svc?.scope === 'system' ? svc.scope : userUnitExists ? 'user' : 'system';
}

/** User-scope restart: reload and restart without sudo, then snapshot. */
export async function restartUserService(
  ctx: InstallContext,
  unit: string,
  fail: (reason: string) => Promise<never>,
): Promise<ServiceSnapshot> {
  await ctx.runner.interactive('systemctl', ['--user', 'daemon-reload']);
  const code = await ctx.runner.interactive('systemctl', ['--user', 'restart', unit]);
  if (code !== 0) await fail(`restart returned code ${code}`);
  return await serviceSnapshot(ctx, 'user', unit);
}

/** System-scope restart through `sudoStep`: the verify callback snapshots the
 *  unit while `sudo` records that the privileged command ran (a later journal
 *  diagnosis may then read it with sudo), and a `StepAborted` from the step is
 *  translated into the same failure report a manual restart would give. */
export async function restartSystemService(
  ctx: InstallContext,
  unit: string,
  before: ServiceSnapshot,
  sudo: { used: boolean },
  fail: (reason: string) => Promise<never>,
): Promise<ServiceSnapshot> {
  const scope = 'system' as const;
  let verified: ServiceSnapshot | undefined;
  let restartCode: number | undefined;
  try {
    await sudoStep(ctx, {
      description: `Reload systemd and restart the ${productName('cezar')} service.`,
      command: `systemctl daemon-reload && systemctl restart ${unit}`,
      verify: async (c, commandCode) => {
        restartCode = commandCode;
        if (commandCode !== undefined) sudo.used = true;
        verified = await serviceSnapshot(c, scope, unit);
        return (commandCode === undefined || commandCode === 0) &&
          verified.active === 'active' && before.started !== null && verified.started !== null && verified.started > before.started;
      },
    });
  } catch (err) {
    if (!(err instanceof StepAborted)) throw err;
    const reason = restartCode !== undefined && restartCode !== 0
      ? `restart returned code ${restartCode}`
      : verified?.active !== 'active'
      ? `service is ${verified?.active ?? 'inactive or unreadable'}`
      : before.started === null || verified.started === null
        ? 'start timestamp unavailable; cannot verify a fresh restart'
        : 'start timestamp unchanged after restart';
    await fail(reason);
  }
  return verified ?? await serviceSnapshot(ctx, scope, unit);
}

/** The restart proof: the unit must be active and its monotonic start stamp
 *  must have moved past `before` (and not be a zero/unknown stamp). Any miss
 *  reports through `fail` and never returns. */
export async function freshRestartOrFail(
  before: ServiceSnapshot,
  snapshot: ServiceSnapshot,
  fail: (reason: string) => Promise<never>,
): Promise<void> {
  if (snapshot.active !== 'active') await fail(`service is ${snapshot.active ?? 'inactive or unreadable'}`);
  if (before.started === null || snapshot.started === null || snapshot.started === 0n) {
    await fail('start timestamp unavailable; cannot verify a fresh restart');
  }
  if (before.started !== null && snapshot.started !== null && snapshot.started <= before.started) {
    await fail('start timestamp unchanged after restart');
  }
}

/** The status and journal commands `confirmSquawkRunning` runs for the scope. */
export function serviceDiagnostics(scope: 'user' | 'system', unit: string): { statusCmd: string; logsCmd: string } {
  return scope === 'user'
    ? { statusCmd: `systemctl --user status ${unit}`, logsCmd: `journalctl --user -u ${unit} -n 50 --no-pager` }
    : { statusCmd: `sudo systemctl status ${unit}`, logsCmd: `sudo journalctl -u ${unit} -n 50 --no-pager` };
}
