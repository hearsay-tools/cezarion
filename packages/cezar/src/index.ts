#!/usr/bin/env node
import { productEnv } from './core/product-env.ts';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRepoInfo } from './server/git.ts';
import { armRepoHandle } from './runs/arm-repo-handle.ts';
import { RunStore } from './runs/store.ts';
import { RunStoreOpenError } from './runs/store-open-error.ts';
import { ensureDataGitignore } from './data-gitignore.ts';
import { warnLegacyEnv } from './home/deprecation.ts';
import { REBRAND_SWITCH } from './home/switch.ts';
import { resolveHome } from './home/resolve.ts';
import { operatorHomeEntry, prepareOperatorHome } from './home/entry.ts';
import { DEFAULT_SERVER_INSTANCE } from './paths.ts';
import type { Home } from './home/home.ts';
import { runSubcommand } from './subcommands.ts';
import { runManagedCommand } from './self-update/cli.ts';
import { runMigrations } from './workspace/migrations.ts';
import { registerProject, shouldRegisterProject } from './workspace/projects.ts';
import { runProjectsCommand } from './workspace/projects-cli.ts';
import { runHeadless, defaultHeadlessDeps, type TaskAccess } from './headless-run.ts';
import { serveCommand, defaultServeDeps } from './serve-command.ts';
import { onTerminal } from './serve-listener.ts';

const HELP = `cezar — local cockpit for AI agent tasks in your repo

Usage:
  cez                       start the cockpit (server + GUI) for the current repo
  cez run "<task>"          run a task headless in the terminal
  cez init                  scaffold .ai/cezar/ (example workflow + skill)
  cez projects              list the projects this cockpit serves
                            (also: projects add [<dir>] · projects remove|rm <id> ·
                             projects tag <id> [<tag>…])
  cez backup list [<file>]   list rotating registry and account backups
  cez backup restore <file> [--at <time>] restore JSON from a backup
  cez discover              list host runners, models, and advertised effort levels
  cez worker                manage owned workers (see: worker --help)
  cez message               message tasks (see: message --help)
  cez task                  start/watch/steer cockpit tasks from the terminal (see: task --help)
  cez automation            create and manage automations from a task (see: automation --help)
  cez webhook               list and send to the project webhooks open to agents (see: webhook --help)
  cez artifact publish <path> publish a local task artifact (see: artifact --help)
  cez server-install        interactive wizard to host cezar on a server
  cez server-deploy         redeploy a new version (reload the service) + verify
  cez server-uninstall      reverse a server-install
${REBRAND_SWITCH ? '  hsq migrate [--dry-run]  migrate the legacy home into the split layout\n  hsq migrate --resolve-legacy <file> restore|accept  resolve legacy recovery first\n' : ''}  cez remote-settings       enable|status|disable remote edits of agent config and worktree setup
  cez install | update      manage the desktop installation under ~/.cezar/versions
  cez versions | use <id>   list or switch managed versions
  cez link [dir] [--use]    link a built development checkout (unlink <id> removes it)

Options:
  -p, --port <n>              cockpit port (default 4321; server-install: this
                              instance's loopback port — auto-picked per domain)
      --repo <dir>            repo to operate on (default: cwd)
      --workflow <name>       workflow for \`run\` (default: quick-task)
      --model <model>         model override for \`run\`
      --no-workers            \`run\`: the task cannot start or resume Cezar workers
      --no-messaging          \`run\`: no new peer-task messages; worker messages and replies stay
      --no-open               don't open the browser
      --platform <id>         server-install target (ubuntu-vps | macosx-ngrok)
      --domain <host>         server-install (ubuntu-vps): host a SECOND, independent
                              cockpit for this domain (own nginx site + service + port).
                              A new domain never resumes/clobbers the first install.
      --external-proxy        server-install (ubuntu-vps): the box ALREADY has a
                              reverse proxy owning :80/:443 (Dokploy/Traefik, Coolify,
                              Caddy, your own nginx). Installs the service only — no
                              nginx, no certbot. That proxy must provide TLS + auth.
      --bind-host <host>      host the cockpit binds (default 127.0.0.1). Use with
                              --external-proxy when the proxy runs in a container and
                              cannot reach loopback (e.g. docker bridge 172.17.0.1).
                              cezar has NO built-in auth — never expose this publicly.
      --yes                   server-install: accept safe defaults (never auto-sudo)
      --reconfigure <ids>     server-install: force re-run of step id(s), comma-separated
      --reinstall             server-install: force re-run of every step (full reinstall)
  -h, --help                  show this help

Zero config: uses your logged-in \`claude\` CLI (and \`gh\` for GitHub bits).
Skills live in .ai/skills/, .ai/cezar/skills/ and your team skills repos
(team skills come from "skillsRepos" in .ai/cezar/config.json, which the Skills page edits; none by default);
workflows in .ai/cezar/workflows/.`;

warnLegacyEnv(process.env);

async function main(): Promise<void> {
  let resolvedHome: Home | undefined;
  let homeEntry = operatorHomeEntry(process.argv.slice(2));
  // Dispatch task commands without invoking this factory or giving them a Home.
  const home = () => resolvedHome ??= prepareOperatorHome(resolveHome({ purpose: 'cli' }), homeEntry);
  const managedExit = await runManagedCommand(process.argv.slice(2), { pkgName: readOwnName(), version: readOwnVersion(), entry: resolve(process.argv[1] ?? '') }, home);
  if (managedExit !== undefined) {
    process.exitCode = managedExit;
    return;
  }
  // Subcommands with flags of their own run before the global parseArgs (#504, #774, #1576).
  const subcommandExit = await runSubcommand(process.argv.slice(2), process.env, home);
  if (subcommandExit !== undefined) {
    process.exitCode = subcommandExit;
    return;
  }
  const { values, positionals } = parseArgs({
    options: {
      port: { type: 'string', short: 'p', default: '4321' },
      repo: { type: 'string' },
      workflow: { type: 'string' },
      model: { type: 'string' },
      'no-workers': { type: 'boolean', default: false },
      'no-messaging': { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      platform: { type: 'string' },
      domain: { type: 'string' },
      'bind-host': { type: 'string' },
      'external-proxy': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      reconfigure: { type: 'string' },
      reinstall: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      'restart-exact': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  // `port` carries a default, so its presence can't tell an explicit `--port`
  // from the fallback. server-install needs that distinction (explicit port
  // wins; otherwise a new named instance auto-picks a free one), so detect the
  // flag straight from argv.
  const portExplicit = process.argv
    .slice(2)
    .some((a) => a === '-p' || a === '--port' || a.startsWith('--port=') || a.startsWith('-p='));

  if (values.help) {
    console.log(HELP);
    return;
  }

  const command = positionals[0] ?? 'serve';
  homeEntry = command;
  const cwd = resolve(values.repo ?? process.cwd());
  const repoInfo = await getRepoInfo(cwd);
  const repoRoot = repoInfo?.root ?? cwd;

  switch (command) {
    case 'serve':
      await serveCommand(home(), repoRoot, Number(values.port), !values['no-open'], values['bind-host'], Boolean(values['restart-exact']), { ...defaultServeDeps, initWorkspace, openBootStore, readOwnName, readOwnVersion });
      return;
    case 'run':
      await runCommand(home(), repoRoot, positionals.slice(1).join(' ').trim(), values.workflow, values.model,
        { allowWorkers: !values['no-workers'], allowMessaging: !values['no-messaging'] });
      return;
    case 'init':
      home();
      initCommand(repoRoot);
      return;
    case 'projects':
      // Registry-only (no server, no HTTP) — see workspace/projects-cli.ts.
      // In single-project mode a listing is a launch-context read: register
      // the boot repo through the normal self-healing path and pin the output
      // to that explicit identity. Mutations are left to their own guards.
      const projectArgs = positionals.slice(1);
      const isList = projectArgs.length === 0 || projectArgs[0] === 'list';
      const bootProjectId = productEnv('SINGLE_PROJECT') === '1' && isList
        ? await initWorkspace(repoRoot, home())
        : undefined;
      process.exitCode = await runProjectsCommand(projectArgs, { defaultRoot: repoRoot, bootProjectId, home: home() });
      return;
    case 'server-install':
      await serverCommand('install', home(), repoRoot, values.platform, {
        yes: Boolean(values.yes),
        reconfigure: values.reconfigure,
        reinstall: Boolean(values.reinstall),
        domain: values.domain,
        port: portExplicit ? Number(values.port) : undefined,
        externalProxy: Boolean(values['external-proxy']),
        bindHost: values['bind-host'],
      });
      return;
    case 'server-deploy':
      await serverCommand('deploy', home(), repoRoot, values.platform, {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
      return;
    case 'server-uninstall':
      await serverCommand('uninstall', home(), repoRoot, values.platform, {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

// ---- workspace boot ----------------------------------------------------------

/**
 * Boot-time workspace bookkeeping (spec 2026-07-20-multi-project-workspace,
 * "Boot flow"): run pending `~/.cezar` migrations first, then register the
 * boot repo in the per-user project registry. Registration is suppressed for
 * task worktrees and `$HOME` itself (`shouldRegisterProject`) — the process
 * still serves those folders normally. Strictly non-fatal: the zero-config
 * law says a broken or read-only home degrades to a smaller cockpit, never a
 * failed boot, so any workspace error logs one warning and boot continues.
 *
 * Returns the boot project's registry id when registration happened —
 * `serveCommand` plumbs it into the server (`ServerDeps.bootProjectId`) so
 * `/api/projects` and `/api/v1/health` can name the boot project without a
 * lookup. Undefined when registration was suppressed or the workspace is
 * unavailable; the server then derives a fallback on its own.
 */
async function initWorkspace(repoRoot: string, home: Home): Promise<string | undefined> {
  try {
    await runMigrations({ bootRepoRoot: repoRoot, home });
    if (await shouldRegisterProject(repoRoot)) return (await registerProject(repoRoot, 'local', home)).id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] workspace registry unavailable (${message}) — continuing without it`);
  }
  return undefined;
}

// ---- serve -----------------------------------------------------------------

// ---- run (headless) ----------------------------------------------------------

/**
 * The "a cockpit is running" hint for headless `run` (task-cli/hint.ts). Loaded lazily, never
 * awaited: discovery overlaps the run (hearsay-tools/cezarion#1039), and the returned stop
 * abandons it when the run ends, so it can neither delay the run nor keep the process alive.
 */
function hintRunningCockpit(repoRoot: string): () => void {
  let stopped = false;
  let stop: (() => void) | undefined;
  void import('./task-cli/hint.ts').then(({ startCockpitHint }) => {
    if (!stopped) stop = startCockpitHint(repoRoot);
  }, () => { /* best effort */ });
  return () => { stopped = true; stop?.(); };
}

async function runCommand(
  home: Home,
  repoRoot: string,
  task: string,
  workflowName: string | undefined,
  model: string | undefined,
  access: TaskAccess,
): Promise<void> {
  if (!task) {
    console.error('usage: cez run "<task>" [--workflow name] [--model model] [--no-workers] [--no-messaging]');
    process.exitCode = 1;
    return;
  }
  const stopHint = hintRunningCockpit(repoRoot);
  try {
    await runHeadless(home, repoRoot, task, workflowName, model, access, { ...defaultHeadlessDeps, initWorkspace, openStore, onTerminal });
  } finally {
    stopHint();
  }
}

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
type ServerCommandMode = 'install' | 'uninstall' | 'deploy';

/** Flags of the `server-install` / `server-deploy` / `server-uninstall` commands. */
interface ServerCommandFlags {
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
      console.log(`\n  cez server-install (${label}) complete.`);
      console.log(`  Redeploy a new version any time with: cez server-deploy --platform ${chosen}${domainFlag}\n`);
    } else if (mode === 'deploy' && result.status === 'complete') {
      console.log(`\n  cez server-deploy (${label}) complete — the service was reloaded and verified.\n`);
    } else if (mode === 'uninstall' && result.status === 'complete') {
      console.log(`\n  cez server-uninstall (${label}) complete — the changes it made were reversed.\n`);
    }
    // complete + cancelled (resumable) exit 0; failed exits 1.
    process.exitCode = result.status === 'failed' ? 1 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function serverCommand(
  mode: ServerCommandMode,
  home: Home,
  repoRoot: string,
  platform: string | undefined,
  flags: ServerCommandFlags,
): Promise<void> {
  // Detection (claude/gh/codex) and tool installs resolve executables off the
  // process PATH. When the installer is launched from a non-login shell (an
  // `ssh host cmd`, a script, a fresh service context), ~/.local/bin and nvm's
  // bin are absent, so tools the user actually has look "not installed". Merge
  // the login shell's PATH first so we see exactly what the operator sees.
  augmentPathFromLoginShell();

  const { getStrategy, availablePlatformIds } = await import('./server-install/strategies.ts');
  const { runInstall, runUninstall, runDeploy } = await import('./server-install/engine.ts');
  const { loadServerState, listServerInstances, nextFreeInstancePort } = await import('./server-install/state.ts');
  const { instanceSlug } = await import('./paths.ts');
  const deps: ServerCommandDeps = { getStrategy, runInstall, runUninstall, runDeploy, loadServerState, listServerInstances, nextFreeInstancePort };

  const ids = availablePlatformIds();

  // Resolve the instance from --domain (domain-keyed multi-instance). An
  // interactive install with an existing cockpit and no --domain also offers to
  // stand up a second instance — the exact "it asks me to reinstall" case.
  let domain = (flags.domain ?? '').trim() || undefined;
  if (mode === 'install' && !domain && !flags.yes && process.stdin.isTTY && loadServerState(DEFAULT_SERVER_INSTANCE, home).installed) {
    // `!domain` holds here, so the prompt result replaces it outright.
    domain = await promptSecondInstanceDomain();
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

// ---- init --------------------------------------------------------------------

function initCommand(repoRoot: string): void {
  const workflowsDir = join(repoRoot, '.ai/cezar', 'workflows');
  const skillsDir = join(repoRoot, '.ai/cezar', 'skills');
  mkdirSync(workflowsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  const examples: Array<{ path: string; content: string }> = [
    {
      path: join(workflowsDir, 'fix-and-verify.yaml'),
      content: `name: fix-and-verify
description: Implement the task, then run your test command; on failure the agent retries with the failing output.
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
  - id: verify
    name: Verify
    command: "echo 'replace me with: npm test / yarn test / pytest'"
    onFail:
      retry: implement
      max: 2
`,
    },
    {
      path: join(skillsDir, 'project-conventions.md'),
      content: `---
name: project-conventions
description: House rules the agent should follow in this repo.
---

# Project conventions

- Describe your stack, style and testing conventions here.
- Reference this skill from a workflow step via \`skill: project-conventions\`.
`,
    },
  ];

  for (const example of examples) {
    if (existsSync(example.path)) {
      console.log(`  = ${example.path} (exists, left untouched)`);
    } else {
      writeFileSync(example.path, example.content, 'utf8');
      console.log(`  + ${example.path}`);
    }
  }
  ensureDataGitignore(repoRoot);
  console.log('\nDone. Start the cockpit with: npx cezarion');
}

// ---- helpers -----------------------------------------------------------------

/** The project's run store, at the start of a process: a busy database is waited out
 *  (`retryBusy`), and a store that cannot open throws its `RunStoreOpenError`. */
function openStore(repoRoot: string, opts?: { keepLive?: boolean; repoHandleSignal?: AbortSignal }): RunStore {
  const dataDir = join(repoRoot, '.ai/cezar');
  // First: an open that fails may already have created the database and the history backups.
  ensureDataGitignore(repoRoot);
  const store = RunStore.open(dataDir, { keepLive: opts?.keepLive, retryBusy: true });
  // Repo-scope the referenced tier (#945) — see `armRepoHandle`. Background, never awaited: a
  // `gh`-less or offline machine keeps working exactly as it did, just unscoped.
  armRepoHandle(store, repoRoot, opts?.repoHandleSignal);
  return store;
}

/**
 * The boot project's store for `serve` (#779, plan step 4). One that cannot open does not stop the
 * cockpit: the boot project answers every route with the reason (`RunStore.unavailable`), the
 * other projects work, and a restart once the cause is gone opens it.
 */
function openBootStore(repoRoot: string): RunStore {
  try {
    return openStore(repoRoot, { keepLive: true });
  } catch (error) {
    if (!(error instanceof RunStoreOpenError)) throw error;
    console.error(`\n  ✗ ${error.message}\n`);
    return RunStore.unavailable(join(repoRoot, '.ai/cezar'), error);
  }
}

/** Own package name — for the npm-registry update check (#368). */
function readOwnName(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { name?: string };
    return pkg.name ?? '@wjarka/cezarion';
  } catch {
    return '@wjarka/cezarion';
  }
}

function readOwnVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
