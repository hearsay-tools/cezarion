import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InstallContext, InstallStep, PlatformMigrationReport, StepArtifact } from '../types.ts';
import { shquote, StepAborted, sudoStep, verifyCommand } from '../steps.ts';
import { ledgerSite, recordedSite, recordedUnit, ubuntuNames } from './ubuntu-vps-names.ts';

/**
 * `server-migrate` for ubuntu-vps (spec 2026-11-06 §4 "Server installs"). The unit moves by copy;
 * the old unit file stays as `<old>.migrated`. An owned nginx site is the old site file copied
 * with only its name and `auth_basic_user_file` changed; the htpasswd is copied and the old file
 * stays. An `--external-proxy` install moves only its unit. State and persistence belong to the
 * caller. The caller journals the dry-run plan before the first move, so every planned
 * destination was absent when the plan was saved: rollback works from disk state alone.
 */

type Move = PlatformMigrationReport['moved'][number];
const emptyReport = (): PlatformMigrationReport => ({ moved: [], leftAloneForeign: [], errors: [] });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const INSTALLER_ENV = new Set(['CEZ_REMOTE', 'HSQ_REMOTE', 'PATH']);

interface UnitPlan { move: Move; next: string; scope: 'user' | 'system'; details: string[] }
interface SitePlan { moves: Move[]; next: string; details: string[] }

async function exists(ctx: InstallContext, path: string): Promise<boolean> {
  return (await ctx.runner.capture('test', ['-e', path])).code === 0;
}

/** Units and sites are world-readable. User units sit at their recorded path in the OS-user home. */
async function readText(ctx: InstallContext, path: string, scope?: string): Promise<string> {
  if (scope === 'user') {
    if (!existsSync(path)) throw new Error(`Unit file missing: ${path}`);
    return readFileSync(path, 'utf8');
  }
  const result = await ctx.runner.capture('cat', [path]);
  if (result.code !== 0) throw new Error(`Cannot read ${path}`);
  return result.stdout;
}

/** Name every operator Environment= assignment; show only CEZ_HOME's value, a path. */
export function environmentDetails(unit: string): string[] {
  const details: string[] = [];
  for (const line of unit.split('\n')) {
    if (!line.startsWith('Environment=')) continue;
    for (const [, name, value] of line.slice('Environment='.length).matchAll(/"?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|\S*)/g)) {
      if (!name || INSTALLER_ENV.has(name)) continue;
      details.push(name === 'CEZ_HOME' ? `environment CEZ_HOME=${value!.replace(/"/g, '')} carried` : `environment ${name} carried (value not shown)`);
    }
  }
  return details;
}

async function planUnit(ctx: InstallContext): Promise<UnitPlan | undefined> {
  const recorded = ctx.state.steps.autostart?.created?.artifacts.find((a) => a.kind === 'owned' && a.type === 'service');
  if (!recorded?.name) throw new Error('No recorded autostart unit');
  const from = { ...recorded, name: recorded.name };
  const names = ubuntuNames(ctx.instance, true);
  if (from.name === names.unit) return undefined;
  if (from.name !== ubuntuNames(ctx.instance, false).unit) throw new Error(`Unexpected unit name: ${from.name}`);
  if (!from.path || (from.scope !== 'user' && from.scope !== 'system')) throw new Error(`No recorded unit path for ${from.name}`);
  const to: StepArtifact = { ...from, name: names.unit, path: join(dirname(from.path), names.unit) };
  const backup: StepArtifact = { kind: 'owned', type: 'file', path: `${from.path}.migrated` };
  const next = await readText(ctx, from.path, from.scope);
  for (const path of [to.path!, backup.path!]) {
    if (from.scope === 'user' ? existsSync(path) : await exists(ctx, path)) throw new Error(`Destination already exists: ${path}`);
  }
  const details = [`unit ${from.scope} ${from.name} → ${names.unit} (old file kept as ${backup.path})`, ...environmentDetails(next)];
  return { move: { stepId: 'autostart', from, to, backup }, next, scope: from.scope, details };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
function siteCopy(content: string, from: string, to: string): string {
  const pattern = new RegExp(`(auth_basic_user_file\\s+)${escapeRegExp(from)}(\\s*;)`, 'g');
  if (!pattern.test(content)) throw new Error(`The site does not read ${from}`);
  return content.replace(pattern, `$1${to}$2`);
}

function recordedArtifact(ctx: InstallContext, type: string, path: string): StepArtifact {
  return ctx.state.steps['nginx-proxy']?.created?.artifacts.find((a) => a.kind === 'owned' && a.type === type && a.path === path)
    ?? { kind: 'owned', type, path };
}

async function planSite(ctx: InstallContext): Promise<SitePlan | undefined> {
  const from = ledgerSite(ctx);
  const to = ubuntuNames(ctx.instance, true);
  if (from.vhostAvailable === to.vhostAvailable) return undefined;
  if (!ctx.state.steps['nginx-proxy']) throw new Error('No recorded nginx-proxy step');
  const next = siteCopy(await readText(ctx, from.vhostAvailable), from.htpasswd, to.htpasswd);
  for (const path of [to.vhostAvailable, to.vhostEnabled, to.htpasswd]) {
    if (await exists(ctx, path)) throw new Error(`Destination already exists: ${path}`);
  }
  const moves: Move[] = (['vhostAvailable', 'vhostEnabled', 'htpasswd'] as const).map((key) => {
    const type = key === 'vhostAvailable' ? 'file' : key === 'vhostEnabled' ? 'symlink' : 'htpasswd';
    const old = recordedArtifact(ctx, type, from[key]);
    return { stepId: 'nginx-proxy', from: old, to: { ...old, path: to[key] } };
  });
  return { moves, next, details: [
    `site ${from.vhostAvailable} → ${to.vhostAvailable} (copied; auth_basic_user_file ${from.htpasswd} → ${to.htpasswd})`,
    `enabled site ${from.vhostEnabled} → ${to.vhostEnabled}`,
    `file ${from.htpasswd} → ${to.htpasswd} (copied; old file kept)`,
  ] };
}

async function moveUnit(ctx: InstallContext, { move: { from, to, backup }, next, scope }: UnitPlan): Promise<void> {
  if (scope === 'user') {
    writeFileSync(to.path!, next, { encoding: 'utf8', flag: 'wx' });
    await ctx.runner.interactive('systemctl', ['--user', 'disable', from.name!]);
    renameSync(from.path!, backup!.path!);
    await ctx.runner.interactive('systemctl', ['--user', 'daemon-reload']);
    await ctx.runner.interactive('systemctl', ['--user', 'enable', to.name!]);
    if ((await ctx.runner.capture('systemctl', ['--user', 'is-enabled', to.name!])).code !== 0) throw new Error(`Could not enable ${to.name}`);
    return;
  }
  const b64 = Buffer.from(next, 'utf8').toString('base64');
  await sudoStep(ctx, {
    description: `Install ${to.name} as a copy of ${from.name}, disable the old unit and keep it as ${backup!.path}.`,
    command: `printf %s ${shquote(b64)} | base64 --decode > ${shquote(to.path!)} && systemctl disable ${shquote(from.name!)} && ` +
      `mv ${shquote(from.path!)} ${shquote(backup!.path!)} && systemctl daemon-reload && systemctl enable ${shquote(to.name!)}`,
    verify: async (c, code) => {
      return (code === undefined || code === 0) && await verifyCommand(c, 'systemctl', ['is-enabled', to.name!]);
    },
  });
}

async function moveSite(ctx: InstallContext, { moves, next }: SitePlan): Promise<void> {
  const [available, enabled, htpasswd] = moves as [Move, Move, Move];
  const b64 = Buffer.from(next, 'utf8').toString('base64');
  await sudoStep(ctx, {
    description: `Copy the nginx site to ${available.to.path} and its htpasswd to ${htpasswd.to.path}, switch the enabled site, reload nginx.`,
    command: `install -d -m 0755 ${shquote(dirname(htpasswd.to.path!))} && cp -p ${shquote(htpasswd.from.path!)} ${shquote(htpasswd.to.path!)} && ` +
      `printf %s ${shquote(b64)} | base64 --decode > ${shquote(available.to.path!)} && ln -s ${shquote(available.to.path!)} ${shquote(enabled.to.path!)} && ` +
      `rm -f ${shquote(enabled.from.path!)} && nginx -t && systemctl reload nginx`,
    verify: async (c, code) => {
      if (code !== undefined && code !== 0) return false;
      return verifyCommand(c, 'sh', ['-c', `test -L ${shquote(enabled.to.path!)} && ! test -e ${shquote(enabled.from.path!)}`]);
    },
  });
}

/** What startUbuntuService checks after the move: the bind address behind an external proxy, else the public site. */
async function healthDetail(ctx: InstallContext, site: SitePlan | undefined): Promise<string> {
  const port = ctx.state.primaryPort;
  if (ctx.state.externalProxy) return `health check: http://${ctx.state.bindHost?.trim() || '127.0.0.1'}:${port}/ answers (the bind address; the proxy is not checked)`;
  const { url } = publicTarget(ctx, site?.next ?? await readText(ctx, recordedSite(ctx, true).vhostAvailable));
  const tls = url.startsWith('https:') ? 'HTTPS, the site has TLS' : 'HTTP, the site has no TLS';
  return `health check: port ${port} answers, then ${url} (${tls}) asks for a login and accepts a probe login`;
}

/** Move only recorded cezar resources. Dry runs plan the same moves and change nothing. */
export async function migrateUbuntu(ctx: InstallContext, rebrand: boolean): Promise<PlatformMigrationReport> {
  const report = emptyReport();
  if (!rebrand) return report;
  let unit: UnitPlan | undefined;
  let site: SitePlan | undefined;
  try {
    unit = await planUnit(ctx);
    site = ctx.state.externalProxy ? undefined : await planSite(ctx);
  } catch (error) {
    report.errors.push({ artifact: recordedUnit(ctx, true), message: message(error) });
    return report;
  }
  report.details = [...unit?.details ?? [], ...site?.details ?? []];
  if (ctx.state.externalProxy && unit) report.details.push('external proxy: its routes, TLS and authentication stay with the operator');
  try {
    report.details.push(await healthDetail(ctx, site));
  } catch (error) {
    report.errors.push({ artifact: recordedUnit(ctx, true), message: message(error) });
    return report;
  }
  const steps: Array<[Move[], () => Promise<void>]> = [];
  if (unit) steps.push([[unit.move], () => moveUnit(ctx, unit)]);
  if (site) steps.push([site.moves, () => moveSite(ctx, site)]);
  for (const [moves, run] of steps) {
    try {
      if (!ctx.dryRun) await run();
      report.moved.push(...moves);
    } catch (error) {
      report.errors.push({ artifact: moves[0]!.from, message: message(error) });
      break;
    }
  }
  return report;
}

/** A journal entry names only this instance's new resources; anything else is refused. */
function assertRollbackEntry(ctx: InstallContext, moves: Move[]): void {
  const names = ubuntuNames(ctx.instance, true);
  for (const { stepId, from, to, backup } of moves) {
    const valid = stepId === 'autostart'
      ? to.name === names.unit && to.path === join(dirname(from.path ?? ''), names.unit) && backup?.path === `${from.path}.migrated`
      : stepId === 'nginx-proxy' && [names.vhostAvailable, names.vhostEnabled, names.htpasswd].includes(to.path ?? '');
    if (!valid) throw new Error(`Invalid ubuntu-vps rollback entry: ${to.path ?? to.name}`);
  }
}

/** True while a unit is active or enabled. A rollback must not leave a new unit running. */
async function unitRuns(ctx: InstallContext, scope: 'user' | 'system', name: string): Promise<boolean> {
  const user = scope === 'user' ? ['--user'] : [];
  for (const verb of ['is-active', 'is-enabled']) {
    if ((await ctx.runner.capture('systemctl', [...user, verb, '--quiet', name])).code === 0) return true;
  }
  return false;
}

async function restoreUnit(ctx: InstallContext, { from, to, backup }: Move): Promise<void> {
  if (from.scope === 'user') {
    if (existsSync(to.path!)) {
      await ctx.runner.interactive('systemctl', ['--user', 'disable', '--now', to.name!]);
      if (await unitRuns(ctx, 'user', to.name!)) throw new Error(`Could not stop and disable ${to.name}`);
      rmSync(to.path!);
    }
    if (existsSync(backup!.path!)) {
      if (existsSync(from.path!)) throw new Error(`Both ${from.path} and its backup exist`);
      renameSync(backup!.path!, from.path!);
    }
    await ctx.runner.interactive('systemctl', ['--user', 'daemon-reload']);
    await ctx.runner.interactive('systemctl', ['--user', 'enable', from.name!]);
    if ((await ctx.runner.capture('systemctl', ['--user', 'is-enabled', from.name!])).code !== 0) throw new Error(`Could not enable ${from.name}`);
    return;
  }
  await sudoStep(ctx, {
    description: `Remove ${to.name} and restore ${from.name}.`,
    command: `{ systemctl disable --now ${shquote(to.name!)} || true; } && rm -f ${shquote(to.path!)} && ` +
      `{ test -e ${shquote(from.path!)} || mv ${shquote(backup!.path!)} ${shquote(from.path!)}; } && systemctl daemon-reload && systemctl enable ${shquote(from.name!)}`,
    verify: async (c, code) => {
      if (code !== undefined && code !== 0) return false;
      return await verifyCommand(c, 'systemctl', ['is-enabled', from.name!]) && !(await unitRuns(c, 'system', to.name!))
        && verifyCommand(c, 'sh', ['-c', `! test -e ${shquote(to.path!)}`]);
    },
  });
}

async function restoreSite(ctx: InstallContext, moves: Move[]): Promise<void> {
  const path = (type: string, side: 'from' | 'to') => moves.find((m) => m.from.type === type)?.[side].path;
  const [oldAvailable, oldEnabled] = [path('file', 'from'), path('symlink', 'from')];
  const removed = [path('symlink', 'to'), path('file', 'to'), path('htpasswd', 'to')].filter((p): p is string => !!p);
  const relink = oldAvailable && oldEnabled ? ` && ln -sfn ${shquote(oldAvailable)} ${shquote(oldEnabled)}` : '';
  const directory = path('htpasswd', 'to');
  await sudoStep(ctx, {
    description: 'Remove the copied nginx site and htpasswd, enable the old site again, reload nginx.',
    command: `rm -f ${removed.map(shquote).join(' ')}${relink}` +
      `${directory ? ` && { rmdir ${shquote(dirname(directory))} || true; }` : ''} && nginx -t && systemctl reload nginx`,
    verify: async (c, code) => {
      if (code !== undefined && code !== 0) return false;
      return verifyCommand(c, 'sh', ['-c', removed.map((p) => `! test -e ${shquote(p)}`).join(' && ')]);
    },
  });
}

/** Reverse planned or completed moves from disk state. Repeat calls are safe. */
export async function rollbackUbuntuMigration(ctx: InstallContext, migrated: PlatformMigrationReport, rebrand: boolean): Promise<PlatformMigrationReport> {
  const report = emptyReport();
  if (!rebrand) return report;
  const site = migrated.moved.filter((m) => m.stepId === 'nginx-proxy');
  const unit = migrated.moved.filter((m) => m.stepId === 'autostart');
  const undo: Array<[Move[], () => Promise<void>]> = [];
  if (site.length) undo.push([site, () => restoreSite(ctx, site)]);
  for (const move of unit) undo.push([[move], () => restoreUnit(ctx, move)]);
  for (const [moves, run] of undo) {
    try {
      assertRollbackEntry(ctx, moves);
      if (!ctx.dryRun) await run();
      report.moved.push(...moves.map((m) => ({ stepId: m.stepId, from: m.to, to: m.from, ...(m.backup ? { backup: m.backup } : {}) })));
    } catch (error) {
      report.errors.push({ artifact: moves[0]!.to, message: message(error) });
    }
  }
  return report;
}

async function systemctl(ctx: InstallContext, verb: 'start' | 'stop', rebrand: boolean): Promise<void> {
  const unit = recordedUnit(ctx, rebrand);
  if (ctx.dryRun) { ctx.ui.info(`DRY RUN — would ${verb} ${unit.name}.`); return; }
  const active = async (c: InstallContext) => {
    return (await c.runner.capture('systemctl', [...(unit.scope === 'user' ? ['--user'] : []), 'is-active', '--quiet', unit.name])).code === 0;
  };
  if (unit.scope === 'user') {
    await ctx.runner.interactive('systemctl', ['--user', verb, unit.name]);
    if (await active(ctx) !== (verb === 'start')) throw new StepAborted(`Could not ${verb} ${unit.name}`);
    return;
  }
  await sudoStep(ctx, {
    description: `${verb === 'start' ? 'Start' : 'Stop'} ${unit.name}.`,
    command: `systemctl ${verb} ${shquote(unit.name)}`,
    verify: async (c) => await active(c) === (verb === 'start'),
  });
}

export function stopUbuntuService(ctx: InstallContext, rebrand: boolean): Promise<void> {
  return systemctl(ctx, 'stop', rebrand);
}

export interface UbuntuHealth {
  identity: InstallStep;
  waitForSquawk(ctx: InstallContext, port: number): Promise<boolean>;
}

/** Prove nginx reads the recorded htpasswd: a probe login added there must pass the public site.
 *  `finally` removes it; after a crash, journal recovery removes the whole new htpasswd copy. */
async function withProbeLogin(ctx: InstallContext, htpasswd: string, run: (login: Login) => Promise<void>): Promise<void> {
  const user = `cez-migrate-probe-${randomBytes(6).toString('hex')}`;
  // 192 random bits, sent only on stdin to openssl and curl; never printed or saved.
  const password = randomBytes(24).toString('base64url');
  const hashed = await ctx.runner.capture('openssl', ['passwd', '-apr1', '-stdin'], { input: `${password}\n` });
  if (hashed.code !== 0 || !hashed.stdout.trim()) throw new StepAborted('failed to hash the probe password (openssl)');
  const present = (c: InstallContext) => verifyCommand(c, 'test', ['-f', htpasswd]);
  await sudoStep(ctx, {
    description: `Add a temporary probe login to ${htpasswd}.`,
    command: `cat >> ${shquote(htpasswd)}`, input: `${user}:${hashed.stdout.trim()}\n`, inputLabel: 'probe credential line', verify: present,
  });
  const previous = ctx.prefs.cockpit;
  try {
    ctx.prefs.cockpit = { user, password };
    await run({ user, password });
  } finally {
    if (previous) ctx.prefs.cockpit = previous;
    else delete ctx.prefs.cockpit;
    await sudoStep(ctx, { description: `Remove the probe login from ${htpasswd}.`, command: `sed -i ${shquote(`/^${user}:/d`)} ${shquote(htpasswd)}`, verify: present });
  }
}

interface Login { user: string; password: string }
interface PublicTarget { url: string; resolve?: string }

/** The address to probe, from the site's listeners for `port`: an IPv4 wildcard (or no address) is
 *  127.0.0.1 and wins, a concrete address stays as given (IPv6 in brackets), an IPv6 wildcard is [::1]. */
export function listenAddress(site: string, port: number): string {
  const found = { v4: false, v6: false, concrete: undefined as string | undefined };
  for (const [, where] of site.matchAll(/^\s*listen\s+([^;\s]+)[^;]*;/gm)) {
    const match = /^(?:(.+):)?(\d+)$/.exec(where!);
    if (!match || Number(match[2]) !== port) continue;
    const address = match[1];
    if (!address || address === '*' || address === '0.0.0.0') found.v4 = true;
    else if (address === '[::]') found.v6 = true;
    else found.concrete ??= address;
  }
  if (found.v4) return '127.0.0.1';
  return found.concrete ?? (found.v6 ? '[::1]' : '127.0.0.1');
}

/** The recorded public URL: HTTPS when the site has TLS. curl --resolve keeps SNI and Host public. */
export function publicTarget(ctx: InstallContext, site: string): PublicTarget {
  const domain = ctx.state.domain;
  if (!domain) return { url: 'http://127.0.0.1/' };
  const tls = /^\s*ssl_certificate\s/m.test(site);
  const port = tls ? 443 : 80;
  return { url: `${tls ? 'https' : 'http'}://${domain}/`, resolve: `${domain}:${port}:${listenAddress(site, port)}` };
}

const curlConfig = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

async function publicStatus(ctx: InstallContext, target: PublicTarget, login?: Login): Promise<string> {
  const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}', ...(target.resolve ? ['--resolve', target.resolve] : []), ...(login ? ['-K', '-'] : []), target.url];
  const input = login ? `user = "${curlConfig(login.user)}:${curlConfig(login.password)}"\n` : undefined;
  return (await ctx.runner.capture('curl', args, input ? { input } : undefined)).stdout.trim() || '000';
}

/** Through the public URL: an anonymous request must be challenged, and the login must reach cezar. */
async function checkPublicSite(ctx: InstallContext, vhostAvailable: string, login?: Login): Promise<void> {
  const target = publicTarget(ctx, await readText(ctx, vhostAvailable));
  const anonymous = await publicStatus(ctx, target);
  if (anonymous !== '401') throw new StepAborted(`${target.url} did not ask for a login (got ${anonymous})`);
  if (!login) return;
  const code = await publicStatus(ctx, target, login);
  if (!/^[23]\d\d$/.test(code)) throw new StepAborted(`${target.url} refused the probe login (got ${code})`);
}

/** Start the recorded unit and check health: the bind address for an external proxy, else the public site. */
export async function startUbuntuService(ctx: InstallContext, health: UbuntuHealth, rebrand: boolean, opts: { probeAuth?: boolean } = {}): Promise<void> {
  await systemctl(ctx, 'start', rebrand);
  if (ctx.dryRun) return;
  if (ctx.state.externalProxy) { await health.identity.run(ctx); return; }
  const unit = recordedUnit(ctx, rebrand).name;
  if (!(await health.waitForSquawk(ctx, ctx.state.primaryPort))) throw new StepAborted(`${unit} did not answer on port ${ctx.state.primaryPort}`);
  const { vhostAvailable, htpasswd } = recordedSite(ctx, rebrand);
  if (opts.probeAuth) await withProbeLogin(ctx, htpasswd, (login) => checkPublicSite(ctx, vhostAvailable, login));
  else await checkPublicSite(ctx, vhostAvailable);
}
