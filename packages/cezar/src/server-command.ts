import { commandText } from './home/command.ts';
import { execFileSync } from 'node:child_process';
import { productEnv } from './core/product-env.ts';
import { DEFAULT_SERVER_INSTANCE } from './paths.ts';
import type { Home } from './home/home.ts';

// ---- server-install / server-uninstall --------------------------------------
// The whole server-install module (and its @clack/prompts dependency) is loaded
// lazily here so it never enters the `serve`/`run`/`init` import graph — the
// runtime server stack stays tiny (AGENTS.md).

/**
 * Prepend the operator's login-shell PATH to this process's PATH so tool
 * detection and installs find things in ~/.local/bin, nvm, and other
 * profile-added dirs even when the installer was launched non-interactively.
 * Best-effort: a shell that errors or hangs leaves PATH untouched.
 */
function augmentPathFromLoginShell(): void {
  try {
    const out = execFileSync('bash', ['-lc', 'printf %s "$PATH"'], { timeout: 5000, encoding: 'utf8' });
    const loginPath = out.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
    if (!loginPath) return;
    const seen = new Set<string>();
    process.env.PATH = [...loginPath.split(':'), ...(process.env.PATH ?? '').split(':')]
      .filter((d) => d && !seen.has(d) && seen.add(d))
      .join(':');
  } catch {
    // best effort — keep the existing PATH
  }
}

/** The three server commands share one mode switch: install, deploy, uninstall. */
export type ServerCommandMode = 'install' | 'uninstall' | 'deploy';

/** Flags of the `server-install` / `server-deploy` / `server-uninstall` commands. */
export interface ServerCommandFlags {
  yes: boolean;
  reconfigure?: string | undefined;
  reinstall?: boolean;
  domain?: string | undefined;
  port?: number | undefined;
  externalProxy?: boolean;
  bindHost?: string | undefined;
}

/** The lazily-imported server-install modules serverCommand's helpers need.
 *  Type-only: the imports themselves stay inside serverCommand, so the whole
 *  server-install module never enters the serve/run/init import graph. */
type ServerCommandDeps = Pick<typeof import('./server-install/strategies.ts'), 'getStrategy'>
  & Pick<typeof import('./server-install/engine.ts'), 'runInstall' | 'runDeploy' | 'runUninstall'>
  & Pick<typeof import('./server-install/state.ts'), 'loadServerState' | 'listServerInstances' | 'nextFreeInstancePort'>;

/** The engine options serverCommand builds for one install/deploy/uninstall run. */
type ServerRunOptions = import('./server-install/engine.ts').RunOptions;

type ServerStrategy = NonNullable<ReturnType<ServerCommandDeps['getStrategy']>>;

/** An interactive install on a host that already runs a cockpit, entered with
 *  no --domain, offers to stand up a second, independent instance — the exact
 *  "it asks me to reinstall" case. Returns the NEW domain to use, or undefined
 *  to manage the existing one; any prompt failure falls back the same way. */
async function promptSecondInstanceDomain(): Promise<string | undefined> {
  try {
    const { createClackUi } = await import('./server-install/ui.ts');
    const answer = await createClackUi().text({
      message:
        'This host already runs a cezar cockpit. Enter a NEW domain to host a second, independent instance — ' +
        'or leave blank to manage/redeploy the existing one.',
      placeholder: 'shop.example.com',
    });
    if (typeof answer === 'string' && answer.trim()) return answer.trim();
  } catch {
    // any prompt failure → fall back to managing the default instance
  }
  return undefined;
}

/** Resolve the platform and its strategy for one server command. Uninstall and
 *  deploy can read the platform from THIS instance's record when omitted. Each
 *  refusal keeps its exact message and sets the exit code; undefined means the
 *  command cannot run. */
function resolveServerStrategy(
  deps: ServerCommandDeps,
  mode: ServerCommandMode,
  instance: string,
  platform: string | undefined,
  home: Home,
  ids: string[],
): { strategy: ServerStrategy; chosen: string } | undefined {
  let chosen = platform;
  if ((mode === 'uninstall' || mode === 'deploy') && !chosen) {
    chosen = deps.loadServerState(instance, home).platform;
  }
  if (!chosen) {
    console.error(`--platform is required. Valid platforms: ${ids.join(', ')}`);
    process.exitCode = 1;
    return undefined;
  }
  const strategy = deps.getStrategy(chosen);
  if (!strategy) {
    console.error(`unknown platform: ${chosen} (valid: ${ids.join(', ')})`);
    process.exitCode = 1;
    return undefined;
  }
  // Domain-keyed multi-instance is an ubuntu-vps feature (shared nginx front).
  if (instance !== DEFAULT_SERVER_INSTANCE && chosen !== 'ubuntu-vps') {
    console.error(`--domain (multi-instance) is only supported on ubuntu-vps, not ${chosen}.`);
    process.exitCode = 1;
    return undefined;
  }
  return { strategy, chosen };
}

/** Port: an explicit --port always wins; a brand-new named instance otherwise
 *  auto-picks the next free loopback port so it can't collide with the first. */
function resolveServerPort(
  deps: ServerCommandDeps,
  mode: ServerCommandMode,
  instance: string,
  domain: string | undefined,
  flags: ServerCommandFlags,
  home: Home,
): number | undefined {
  let port = flags.port;
  if (mode === 'install' && instance !== DEFAULT_SERVER_INSTANCE && port === undefined) {
    const known = deps.listServerInstances(home).some((i) => i.instance === instance);
    if (!known) {
      port = deps.nextFreeInstancePort(undefined, home);
      console.log(`\n  New instance "${instance}" (${domain}) → loopback port ${port} (override with --port).`);
    }
  }
  return port;
}

/** The engine options for one run. */
function buildRunOptions(
  mode: ServerCommandMode,
  home: Home,
  repoRoot: string,
  flags: ServerCommandFlags,
  instance: string,
  domain: string | undefined,
  port: number | undefined,
): ServerRunOptions {
  return {
    home,
    dryRun: productEnv('DRY_RUN') === '1',
    assumeYes: flags.yes,
    reconfigure: new Set((flags.reconfigure ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    reinstall: Boolean(flags.reinstall),
    repoRoot,
    now: new Date().toISOString(),
    instance,
    domain,
    port,
    // Only an install decides proxy mode; deploy/uninstall read it back from
    // the recorded state. Preserve an omitted flag as `undefined`: a flag-less
    // resume must keep an external-proxy install external instead of flipping
    // it back to cezar-managed nginx/SSL.
    ...(mode === 'install'
      ? { externalProxy: flags.externalProxy || undefined, bindHost: flags.bindHost }
      : {}),
  };
}

/** Run the install/deploy/uninstall engine and report the outcome: complete +
 *  cancelled (resumable) exit 0, failed exits 1; a thrown error prints its
 *  message and exits 1. */
async function runAndReportServerCommand(
  deps: ServerCommandDeps,
  mode: ServerCommandMode,
  strategy: ServerStrategy,
  runOpts: ServerRunOptions,
  label: string,
  chosen: string,
  domainFlag: string,
): Promise<void> {
  try {
    const result =
      mode === 'install'
        ? await deps.runInstall(strategy, runOpts)
        : mode === 'deploy'
          ? await deps.runDeploy(strategy, runOpts)
          : await deps.runUninstall(strategy, runOpts);
    if (mode === 'install' && result.status === 'complete') {
      console.log(commandText(`\n  cez server-install (${label}) complete.`));
      console.log(commandText(`  Redeploy a new version any time with: cez server-deploy --platform ${chosen}${domainFlag}\n`));
    } else if (mode === 'deploy' && result.status === 'complete') {
      console.log(commandText(`\n  cez server-deploy (${label}) complete — the service was reloaded and verified.\n`));
    } else if (mode === 'uninstall' && result.status === 'complete') {
      console.log(commandText(`\n  cez server-uninstall (${label}) complete — the changes it made were reversed.\n`));
    }
    // complete + cancelled (resumable) exit 0; failed exits 1.
    process.exitCode = result.status === 'failed' ? 1 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function serverCommand(
  mode: ServerCommandMode,
  home: Home,
  repoRoot: string,
  platform: string | undefined,
  flags: ServerCommandFlags,
  commandDeps = defaultServerCommandDeps,
): Promise<void> {
  // Detection (claude/gh/codex) and tool installs resolve executables off the
  // process PATH. When the installer is launched from a non-login shell (an
  // `ssh host cmd`, a script, a fresh service context), ~/.local/bin and nvm's
  // bin are absent, so tools the user actually has look "not installed". Merge
  // the login shell's PATH first so we see exactly what the operator sees.
  commandDeps.augmentPathFromLoginShell();

  const deps = await commandDeps.load();
  const { availablePlatformIds, loadServerState, instanceSlug } = deps;

  const ids = availablePlatformIds();

  // Resolve the instance from --domain (domain-keyed multi-instance). An
  // interactive install with an existing cockpit and no --domain also offers to
  // stand up a second instance — the exact "it asks me to reinstall" case.
  let domain = (flags.domain ?? '').trim() || undefined;
  if (mode === 'install' && !domain && !flags.yes && commandDeps.stdin.isTTY && loadServerState(DEFAULT_SERVER_INSTANCE, home).installed) {
    // `!domain` holds here, so the prompt result replaces it outright.
    domain = await commandDeps.promptSecondInstanceDomain();
  }
  const instance = domain ? instanceSlug(domain) : DEFAULT_SERVER_INSTANCE;

  const resolved = resolveServerStrategy(deps, mode, instance, platform, home, ids);
  if (!resolved) return;
  const { strategy, chosen } = resolved;

  const port = resolveServerPort(deps, mode, instance, domain, flags, home);
  const runOpts = buildRunOptions(mode, home, repoRoot, flags, instance, domain, port);

  // e.g. "ubuntu-vps" or "ubuntu-vps, shop.example.com" for a named instance.
  const label = instance === DEFAULT_SERVER_INSTANCE ? chosen : `${chosen}, ${domain}`;
  const domainFlag = instance === DEFAULT_SERVER_INSTANCE ? '' : ` --domain ${domain}`;

  await runAndReportServerCommand(deps, mode, strategy, runOpts, label, chosen, domainFlag);
}

async function loadServerCommandModules() {
  const { getStrategy, availablePlatformIds } = await import('./server-install/strategies.ts');
  const { runInstall, runUninstall, runDeploy } = await import('./server-install/engine.ts');
  const { loadServerState, listServerInstances, nextFreeInstancePort } = await import('./server-install/state.ts');
  const { instanceSlug } = await import('./paths.ts');
  return { getStrategy, availablePlatformIds, runInstall, runUninstall, runDeploy, loadServerState, listServerInstances, nextFreeInstancePort, instanceSlug };
}

export const defaultServerCommandDeps = { augmentPathFromLoginShell, load: loadServerCommandModules, promptSecondInstanceDomain, stdin: process.stdin };
