import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANCEL, PreflightError, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact, type StepCreated } from '../types.ts';
import { brewInstallTool, brewRemoveHint, depCheckStep, HOSTNAME_RE, owned, shared, StepAborted, StepCancelled, verifyCommand } from '../steps.ts';
import { REBRAND_SWITCH } from '../../home/switch.ts';
import { migrateLaunchd, rollbackLaunchdMigration } from './macosx-migration.ts';
import { refreshNpxCacheForRedeploy } from '../npx-cache.ts';

/**
 * The `macosx-ngrok` strategy: the app runs locally on a Mac and ngrok is the
 * public front, in place of nginx+certbot. ngrok's built-in `--basic-auth` is
 * the identity gate (the htpasswd equivalent), and a launchd agent is the
 * autostart (the systemd equivalent). Proves the engine seam with a genuinely
 * different platform — same engine, different steps.
 */

/** Keep OS-user discovery at one injectable boundary. */
function launchAgentsDir(ctx: InstallContext): string {
  return ctx.launchAgentsDir?.() ?? join(homedir(), 'Library', 'LaunchAgents');
}

function labelFor(agent: 'ngrok' | 'cockpit', rebrand: boolean): string {
  return `${rebrand ? 'tools.hearsay.squawk' : 'ai.cezar'}.${agent}`;
}

type LaunchAgent = StepArtifact & { name: string; path: string };

function agentCandidates(ctx: InstallContext, step: string, rebrand: boolean, created: StepCreated | undefined): LaunchAgent[] {
  const agent = step === 'ngrok' ? 'ngrok' : 'cockpit';
  const selected = labelFor(agent, rebrand);
  const artifact = (name: string): LaunchAgent => ({ kind: 'owned', type: 'launchd', name, path: join(launchAgentsDir(ctx), `${name}.plist`) });
  const recorded = created?.artifacts.find((a) => a.kind === 'owned' && a.type === 'launchd');
  // A ledger is authoritative: static fallback must not claim an unrelated old agent.
  if (recorded) {
    const fallback = artifact(recorded.name ?? selected);
    return [{ ...recorded, ...fallback, path: recorded.path ?? fallback.path }];
  }
  return rebrand ? [artifact(selected), artifact(labelFor(agent, false))] : [artifact(selected)];
}

function agentArtifact(ctx: InstallContext, step: string, rebrand: boolean): LaunchAgent {
  const candidates = agentCandidates(ctx, step, rebrand, ctx.state.steps[step]?.created);
  return candidates.find((a) => existsSync(a.path)) ?? candidates[0]!;
}

async function removeAgents(ctx: InstallContext, step: string, rebrand: boolean, created: StepCreated): Promise<void> {
  const candidates = agentCandidates(ctx, step, rebrand, created);
  const existing = candidates.filter((a) => existsSync(a.path));
  // Keep the historical bootout even when the plist was already removed.
  const targets = existing.length > 0 ? existing : [candidates[0]!];
  const uid = process.getuid ? process.getuid() : 0;
  for (const { name, path } of targets) {
    await ctx.runner.capture('launchctl', ['bootout', `gui/${uid}/${name}`]);
    rmSync(path, { force: true });
  }
}

/**
 * `launchctl bootstrap` + proof the agent actually loaded. A discarded
 * bootstrap exit code (malformed plist, spawn failure) used to record the
 * step `done` — install reported complete with nothing running.
 */
async function bootstrapVerified(ctx: InstallContext, uid: number, label: string, path: string, what: string): Promise<void> {
  const code = await ctx.runner.interactive('launchctl', ['bootstrap', `gui/${uid}`, path]);
  const loaded = (await ctx.runner.capture('launchctl', ['print', `gui/${uid}/${label}`])).code === 0;
  if (code !== 0 || !loaded) {
    throw new StepAborted(
      `launchctl could not load ${what} (bootstrap exit ${code}) — inspect it with: launchctl print gui/${uid}/${label}`,
    );
  }
}

/** Both agents use private plists; ngrok's plist contains plaintext credentials. */
async function installAgent(ctx: InstallContext, name: string, path: string, xml: string, what: string): Promise<void> {
  mkdirSync(launchAgentsDir(ctx), { recursive: true });
  writeFileSync(path, xml, { encoding: 'utf8', mode: 0o600 });
  // mode only applies on create; protect re-installs over an existing 0644 plist too.
  chmodSync(path, 0o600);
  const uid = process.getuid ? process.getuid() : 0;
  // Modern launchctl avoids legacy load's EIO on current macOS. Unload before re-install.
  await ctx.runner.capture('launchctl', ['bootout', `gui/${uid}/${name}`]);
  await bootstrapVerified(ctx, uid, name, path, what);
}

/** Escape a value for inclusion in plist XML text. */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** launchd agent that keeps an authenticated ngrok tunnel to the local cockpit up. */
export function launchdPlist(port: number, basicAuth: string, domain?: string, ngrokBin = '/opt/homebrew/bin/ngrok', rebrand = REBRAND_SWITCH): string {
  const args = ['http', String(port), '--basic-auth', basicAuth];
  if (domain) args.push('--domain', domain);
  // Escape every arg — a password/domain with `&`, `<`, `>` would otherwise
  // produce invalid plist XML and launchctl would silently fail to load it.
  const argXml = [ngrokBin, ...args]
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Managed by cezar server-install — do not edit by hand. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${labelFor('ngrok', rebrand)}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

const ngrokStep = (rebrand: boolean): InstallStep => ({
  id: 'ngrok',
  title: 'ngrok tunnel (authtoken + domain + basic-auth)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    return verifyCommand(ctx, 'test', ['-f', agentArtifact(ctx, 'ngrok', rebrand).path]);
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // 1) ngrok present?
    const present = await verifyCommand(ctx, 'ngrok', ['version']);
    if (!present) {
      if (ctx.dryRun) ctx.ui.info('DRY RUN — would run: brew install ngrok/ngrok/ngrok');
      else await ctx.runner.interactive('brew', ['install', 'ngrok/ngrok/ngrok']);
    }

    // 2) authtoken (a secret — never stored in server.json; it lives in ngrok's own config)
    const token = await ctx.ui.password({
      message: 'Paste your ngrok authtoken (dashboard.ngrok.com → Your Authtoken)',
      validate: (v) => (v.trim() ? undefined : 'authtoken is required'),
    });
    if (token === CANCEL) throw new StepCancelled();
    // The token expands INSIDE the child shell: argv carries only the literal
    // string `"$NGROK_AUTHTOKEN"`, so `ps` never sees the secret. It lands in
    // ngrok's own config (~/Library/Application Support/ngrok/ngrok.yml, 0600
    // by ngrok itself), never in server.json.
    if (!ctx.dryRun) {
      const code = await ctx.runner.interactive('bash', ['-c', 'ngrok config add-authtoken "$NGROK_AUTHTOKEN"'], {
        env: { NGROK_AUTHTOKEN: String(token) },
      });
      if (code !== 0) throw new StepAborted('ngrok rejected the authtoken (`ngrok config add-authtoken` failed) — check the token and re-run');
    }

    // 3) reserved domain (optional → ephemeral URL)
    const domainInput = await ctx.ui.text({
      message: 'Reserved ngrok domain (leave blank for an ephemeral URL that changes on restart)',
      placeholder: 'cezar.ngrok.app',
      // Bare hostname only — `https://…` here used to yield `--domain https://…`
      // in the plist and a `https://https://…` publicUrl.
      validate: (v) => (!v.trim() || HOSTNAME_RE.test(v.trim()) ? undefined : 'enter a bare hostname (no scheme), e.g. cezar.ngrok.app'),
    });
    if (domainInput === CANCEL) throw new StepCancelled();
    // Guard against `String(undefined)` → `"undefined"` — @clack/prompts can
    // return undefined when the user accepts without typing over the placeholder.
    const domain = typeof domainInput === 'string' && domainInput.trim() ? domainInput.trim() : undefined;

    // 4) basic-auth identity
    const user = await ctx.ui.text({
      message: 'Basic-auth username for the tunnel',
      placeholder: 'ops',
      validate: (v) => (v.trim() ? undefined : 'username is required'),
    });
    if (user === CANCEL) throw new StepCancelled();
    const password = await ctx.ui.password({
      message: `Basic-auth password for "${user}"`,
      validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
    });
    if (password === CANCEL) throw new StepCancelled();
    if (!ctx.dryRun && String(password).length < 6) {
      throw new StepAborted('a basic-auth password (≥6 chars) is required — run server-install without --yes to set one');
    }
    const basicAuth = `${String(user)}:${String(password)}`;

    // 5) launchd agent (the plist embeds the basic-auth creds, like htpasswd on Linux)
    const name = labelFor('ngrok', rebrand);
    const path = join(launchAgentsDir(ctx), `${name}.plist`);
    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would write ${path} and launchctl bootstrap it.`);
    } else {
      // Resolve the real ngrok binary path so the plist works on both Apple
      // Silicon (/opt/homebrew/bin) and Intel (/usr/local/bin) Macs.
      const ngrokBin = (await ctx.runner.capture('bash', ['-lc', 'command -v ngrok'])).stdout.trim() || '/opt/homebrew/bin/ngrok';

      await installAgent(ctx, name, path, launchdPlist(ctx.state.primaryPort, basicAuth, domain, ngrokBin, rebrand), 'the ngrok tunnel agent');
    }

    if (domain) {
      ctx.state.publicUrl = `https://${domain}`;
      ctx.state.ephemeral = false;
    } else {
      ctx.state.ephemeral = true;
      ctx.ui.note('No reserved domain — the tunnel URL is ephemeral and changes each restart. Find it at http://localhost:4040.', 'ngrok');
    }

    return {
      artifacts: [
        shared('ngrok-config', { name: 'authtoken', removeHint: 'ngrok config add-authtoken "" (or edit ~/Library/Application Support/ngrok/ngrok.yml)' }),
        owned('launchd', { name, path }),
      ],
    };
  },
  async undo(ctx, created) {
    // Prefer the recorded identity; check() can leave created:null, so keep the
    // selected-label fallback to remove credential-bearing agents in that case.
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would launchctl bootout and remove the ngrok agent.');
    } else {
      await removeAgents(ctx, 'ngrok', rebrand, created);
    }
    const cfg = (created?.artifacts ?? []).find((a) => a.type === 'ngrok-config');
    if (cfg) {
      ctx.ui.note(
        `The ngrok authtoken was left in ngrok's own config — remove it yourself if you want it gone:\n${cfg.removeHint ?? ''}`,
        'ngrok',
      );
    }
  },
});

/* ── autostart: run cezar itself as a launchd agent ─────────────────── */

const OFFICIAL_CLI_PKG = 'cezarion';

/** Live launchd `ProgramArguments` joined into one string so the shared npx-cache
 *  helper can classify the launch form the same way ubuntu-vps classifies ExecStart.
 *  Empty string when the plist can't be read — callers then skip the cache refresh
 *  rather than guessing. */
function readCezarProgramArguments(path: string): string {
  try {
    const xml = readFileSync(path, 'utf8');
    const inner = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
    if (inner === undefined) return '';
    return [...inner.matchAll(/<string>([\s\S]*?)<\/string>/g)]
      .map((m) => (m[1] ?? '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'))
      .join(' ');
  } catch {
    return '';
  }
}

/** Resolve the argv array for the cezar launchd agent, mirroring how the CLI was launched. */
async function resolveCezarArgv(ctx: InstallContext): Promise<string[]> {
  const node = process.execPath;
  const pkgRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const entry = join(pkgRoot, 'dist', 'index.js');
  const npxPath = join(dirname(node), 'npx');

  if (/[/\\]_npx[/\\]/.test(pkgRoot)) return [npxPath, '--yes', OFFICIAL_CLI_PKG];
  if (ctx.dryRun || existsSync(entry)) return [node, entry];

  const out = (await ctx.runner.capture('bash', ['-lc', `command -v ${OFFICIAL_CLI_PKG} || command -v cez`])).stdout.trim();
  const globalBin = out.split('\n').map((s) => s.trim()).filter(Boolean).pop();
  if (globalBin) return [node, globalBin];

  // No runnable cezar → installing a KeepAlive agent would make launchd
  // respawn-throttle a permanently failing job across reboots. Fail the step.
  throw new StepAborted(
    `could not locate a runnable cezar (${entry} missing, no global ${OFFICIAL_CLI_PKG}) — ` +
      `install it (npm i -g ${OFFICIAL_CLI_PKG}) or build the checkout, then re-run with --reconfigure autostart`,
  );
}

/** launchd agent that keeps the cezar cockpit running on the given port. */
export function cezarLaunchdPlist(repoRoot: string, port: number, argv: string[], rebrand = REBRAND_SWITCH): string {
  // Give the agent the operator's PATH so cezar can spawn claude/gh/codex.
  const pathDirs = [dirname(process.execPath), ...(process.env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((d, i, a) => d && d !== '.' && a.indexOf(d) === i);
  const fullArgv = [...argv, 'serve', '--no-open', '--port', String(port)];
  const argXml = fullArgv.map((a) => `      <string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Managed by cezar server-install — do not edit by hand. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${labelFor('cockpit', rebrand)}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(repoRoot)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CEZ_REMOTE</key>
      <string>1</string>
      <key>PATH</key>
      <string>${escapeXml(pathDirs.join(':'))}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

const autostartStep = (rebrand: boolean): InstallStep => ({
  id: 'autostart',
  title: 'Run cezar as a service (launchd — starts now + on boot)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    return verifyCommand(ctx, 'test', ['-f', agentArtifact(ctx, 'autostart', rebrand).path]);
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    const argv = await resolveCezarArgv(ctx);
    const name = labelFor('cockpit', rebrand);
    const path = join(launchAgentsDir(ctx), `${name}.plist`);
    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would write ${path} and launchctl bootstrap it.`);
    } else {
      await installAgent(ctx, name, path, cezarLaunchdPlist(ctx.repoRoot, ctx.state.primaryPort, argv, rebrand), 'the cezar cockpit agent');
    }
    return { artifacts: [owned('launchd', { name, path })] };
  },
  async undo(ctx, created) {
    // Recorded identity, with the same null-ledger fallback as ngrok.
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would launchctl bootout and remove the cezar agent.');
    } else {
      await removeAgents(ctx, 'autostart', rebrand, created);
    }
  },
});

const identityStep: InstallStep = {
  id: 'identity',
  title: 'Identity check (ngrok basic-auth active)',
  async check() {
    return false;
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would confirm the ngrok tunnel is up and basic-auth is enforced.');
      return { artifacts: [] };
    }
    // ngrok needs a moment after launchctl bootstrap to bind to :4040.
    // Retry a few times with a short delay before giving up.
    let up = false;
    for (let attempt = 0; attempt < 5 && !up; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      up = await verifyCommand(ctx, 'curl', ['-s', 'http://localhost:4040/api/tunnels'], (r) => r.stdout.includes('public_url'));
    }
    if (up) ctx.ui.success('ngrok tunnel is up (basic-auth enforced at the ngrok edge).');
    else ctx.ui.warn('Could not reach the ngrok local API (localhost:4040) — check the tunnel started.');
    return { artifacts: [] };
  },
  async undo() {
    // nothing created
  },
};

/** Explicit selection lets tests cover the release without mocking its switch. */
export function createMacosxNgrok({ rebrand = REBRAND_SWITCH } = {}): PlatformStrategy {
  return {
    id: 'macosx-ngrok',
    label: 'macOS + ngrok',
    async preflight(ctx: InstallContext) {
      if (ctx.dryRun) {
        ctx.ui.info('DRY RUN — skipping OS preflight.');
        return;
      }
      if (!(await ctx.runner.capture('uname', ['-s'])).stdout.includes('Darwin')) {
        throw new PreflightError('macosx-ngrok requires macOS. On a Linux VPS use --platform ubuntu-vps.');
      }
    },
    steps(): InstallStep[] {
      return [
        depCheckStep({ installTool: brewInstallTool, removeHint: brewRemoveHint }),
        autostartStep(rebrand),
        ngrokStep(rebrand),
        identityStep,
      ];
    },
    async redeploy(ctx: InstallContext) {
      // #32: an npx-launched agent re-execs its cached build on kickstart, so a
      // deploy that doesn't invalidate the npx cache never actually updates.
      // Clear the cezarion cache first (read the live ProgramArguments to know the
      // launch form); a checkout / global agent is left alone.
      refreshNpxCacheForRedeploy(ctx, readCezarProgramArguments(agentArtifact(ctx, 'autostart', rebrand).path), {
        reconfigureHint: `  cez server-install --platform macosx-ngrok --reconfigure autostart`,
      });
      // Restart both the cezar cockpit and the ngrok tunnel, then re-verify.
      if (ctx.dryRun) {
        ctx.ui.info('DRY RUN — would restart the cezar and ngrok launchd agents and re-verify.');
        return;
      }
      const cockpit = agentArtifact(ctx, 'autostart', rebrand);
      const ngrok = agentArtifact(ctx, 'ngrok', rebrand);
      const uid = process.getuid ? process.getuid() : 0;
      ctx.ui.info('Redeploying — restarting the cezar cockpit.');
      const cezarCode = await ctx.runner.interactive('launchctl', ['kickstart', '-k', `gui/${uid}/${cockpit.name}`]);
      if (cezarCode !== 0) ctx.ui.warn(`launchctl kickstart returned non-zero — check \`launchctl print gui/${uid}/${cockpit.name}\`.`);
      ctx.ui.info('Redeploying — restarting the ngrok tunnel.');
      const code = await ctx.runner.interactive('launchctl', ['kickstart', '-k', `gui/${uid}/${ngrok.name}`]);
      if (code !== 0) ctx.ui.warn(`launchctl kickstart returned non-zero — check \`launchctl print gui/${uid}/${ngrok.name}\`.`);
      await identityStep.run(ctx);
    },
    migrate: (ctx) => migrateLaunchd(ctx, launchAgentsDir(ctx), rebrand),
    rollbackMigration: (ctx, report) => rollbackLaunchdMigration(ctx, report, rebrand),
  };
}

export const macosxNgrok = createMacosxNgrok();
