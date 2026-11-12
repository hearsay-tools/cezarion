import { productName } from './home/display.ts';
import { commandText, oldCommandNotice } from './home/command.ts';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { productEnv } from './core/product-env.ts';
import { operatorHomeEntry, prepareOperatorHome } from './home/entry.ts';
import { REBRAND_SWITCH } from './home/switch.ts';
import type { Home } from './home/home.ts';
import { runSubcommand } from './subcommands.ts';
import { getRepoInfo } from './server/git.ts';
import { runProjectsCommand } from './workspace/projects-cli.ts';
import { projectPaths } from './project-paths.ts';
import { assertProjectAdmitted, projectAdmissionRefusal } from './server/cockpit-ownership.ts';
import type { serverCommand } from './server-command.ts';
import type { TaskAccess } from './headless-run.ts';

export const defaultCliDeps = {
  parseArgs, productEnv, operatorHomeEntry, prepareOperatorHome,
  runSubcommand, getRepoInfo, runProjectsCommand, process, console,
};

export type CliDeps = typeof defaultCliDeps & {
  resolveCliHome: () => Home;
  readOwnVersion: () => string;
  serveCommand: (home: Home, root: string, port: number, open: boolean, bindHost: string | undefined, restartExact: boolean) => Promise<void>;
  serverCommand: typeof serverCommand;
  runCommand: (home: Home, root: string, task: string, workflow: string | undefined, model: string | undefined, access: TaskAccess) => Promise<void>;
  initCommand: (root: string) => void | Promise<void>;
  initWorkspace: (root: string, home: Home) => Promise<string | undefined>;
};

function cliHelp(rebrand: boolean): string {
  return `${productName('cezar', rebrand)} — local cockpit for AI agent tasks in your repo

Usage:
  cez                       start the cockpit (server + GUI) for the current repo
  cez run "<task>"          run a task headless in the terminal
  cez init                  scaffold .ai/${rebrand ? 'squawk' : 'cezar'}/ (example workflow + skill)
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
  cez job start <name> -- <cmd> run a long command that outlives the agent session (see: job --help)
  cez server-install        interactive wizard to host ${productName('cezar', rebrand)} on a server
  cez server-deploy         redeploy a new version (reload the service) + verify
  cez server-uninstall      reverse a server-install
${rebrand ? '  hsq migrate [--dry-run]  migrate the legacy home into the split layout\n  hsq migrate --resolve-legacy <file> restore|accept  resolve legacy recovery first\n' : ''}${rebrand ? '  hsq migrate-project [--dry-run] move this project\'s state from .ai/cezar/ to .ai/squawk/, offline\n' : ''}  cez remote-settings       enable|status|disable remote edits of agent config and worktree setup

Options:
  -p, --port <n>              cockpit port (default 4321; server-install: this
                              instance's loopback port — auto-picked per domain)
      --repo <dir>            repo to operate on (default: cwd)
      --workflow <name>       workflow for \`run\` (default: quick-task)
      --model <model>         model override for \`run\`
      --no-workers            \`run\`: the task cannot start or resume ${productName('Cezar', rebrand)} workers
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
                              ${productName('cezar', rebrand)} has NO built-in auth — never expose this publicly.
      --yes                   server-install: accept safe defaults (never auto-sudo)
      --reconfigure <ids>     server-install: force re-run of step id(s), comma-separated
      --reinstall             server-install: force re-run of every step (full reinstall)
  -v, --version               show the package version
  -h, --help                  show this help

Zero config: uses your logged-in \`claude\` CLI (and \`gh\` for GitHub bits).
${projectFilesHelp(rebrand)}`;
}

function projectFilesHelp(rebrand: boolean): string {
  const dir = rebrand ? '.ai/squawk' : '.ai/cezar';
  return `Skills live in .ai/skills/, ${dir}/skills/ and your team skills repos
(team skills come from "skillsRepos" in ${dir}/config.json, which the Skills page edits; none by default);
workflows in ${dir}/workflows/.${rebrand ? ' A project also reads .ai/cezar/, the old folder name.' : ''}`;
}

/** Project commands finish an unfinished migration journal, then refuse a project under a
 *  migration fence before they touch it; each re-checks right before its first project write.
 *  `serve` recovers and checks in its ownership claim. The recovery module loads only when a
 *  journal exists. */
async function admitProjectCommand(command: string, args: readonly string[], repoRoot: string, singleProject: boolean): Promise<void> {
  const projectList = command === 'projects' && singleProject && (args.length === 0 || args[0] === 'list');
  if (command !== 'run' && command !== 'init' && !projectList) return;
  const dataDir = projectPaths(repoRoot).write;
  if (projectAdmissionRefusal(dataDir)?.reason === 'journal') await (await import('./project-migration/recovery.ts')).recoverProjectMigration(repoRoot);
  assertProjectAdmitted(dataDir);
}

/** `run` without a task is a usage error: runCommand prints usage, and Home stays unprepared. */
function commandHomeEntry(command: string, task: string): string {
  return command === 'run' && !task ? 'run-usage' : command;
}

export async function main(deps: CliDeps, rebrand = REBRAND_SWITCH): Promise<void> {
  const notice = oldCommandNotice(deps.process.argv[1], rebrand);
  if (notice) deps.console.error(notice);
  return dispatch(deps, rebrand);
}

/** Metadata exits before project admission or home preparation. */
function printCliMetadata(deps: CliDeps, values: { version?: boolean; help?: boolean }, help: () => string): boolean {
  if (values.version) {
    deps.console.log(deps.readOwnVersion());
    deps.process.exitCode = 0;
    return true;
  }
  if (values.help) {
    deps.console.log(help());
    return true;
  }
  return false;
}

async function dispatch(deps: CliDeps, rebrand: boolean): Promise<void> {
  // Help reads resolved paths only. Task commands and version output never need a Home.
  const help = () => commandText(cliHelp(rebrand), deps.process.argv[1], rebrand);
  let resolvedHome: Home | undefined;
  let homeEntry = deps.operatorHomeEntry(deps.process.argv.slice(2));
  // Dispatch task commands without invoking this factory or giving them a Home.
  const home = () => resolvedHome ??= deps.prepareOperatorHome(deps.resolveCliHome(), homeEntry);
  // Subcommands with flags of their own run before the global parseArgs (#504, #774, #1576).
  const subcommandExit = await deps.runSubcommand(deps.process.argv.slice(2), deps.process.env, home);
  if (subcommandExit !== undefined) {
    deps.process.exitCode = subcommandExit;
    return;
  }
  const { values, positionals } = deps.parseArgs({
    args: deps.process.argv.slice(2),
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
      version: { type: 'boolean', short: 'v', default: false },
      'restart-exact': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  // `port` carries a default, so its presence can't tell an explicit `--port`
  // from the fallback. server-install needs that distinction (explicit port
  // wins; otherwise a new named instance auto-picks a free one), so detect the
  // flag straight from argv.
  const portExplicit = deps.process.argv
    .slice(2)
    .some((a) => a === '-p' || a === '--port' || a.startsWith('--port=') || a.startsWith('-p='));

  if (printCliMetadata(deps, values, help)) return;

  const command = positionals[0] ?? 'serve';
  const task = positionals.slice(1).join(' ').trim();
  homeEntry = commandHomeEntry(command, task);
  const cwd = resolve(values.repo ?? deps.process.cwd());
  const repoInfo = await deps.getRepoInfo(cwd);
  const repoRoot = repoInfo?.root ?? cwd;
  await admitProjectCommand(command, positionals.slice(1), repoRoot, deps.productEnv('SINGLE_PROJECT') === '1');

  switch (command) {
    case 'serve':
      await deps.serveCommand(home(), repoRoot, Number(values.port), !values['no-open'], values['bind-host'], Boolean(values['restart-exact']));
      return;
    case 'run':
      await deps.runCommand(home(), repoRoot, task, values.workflow, values.model,
        { allowWorkers: !values['no-workers'], allowMessaging: !values['no-messaging'] });
      return;
    case 'init':
      home();
      await deps.initCommand(repoRoot);
      return;
    case 'projects': {
      // Registry-only (no server, no HTTP) — see workspace/projects-cli.ts.
      // In single-project mode a listing is a launch-context read: register
      // the boot repo through the normal self-healing path and pin the output
      // to that explicit identity. Mutations are left to their own guards.
      const projectArgs = positionals.slice(1);
      const isList = projectArgs.length === 0 || projectArgs[0] === 'list';
      const bootProjectId = deps.productEnv('SINGLE_PROJECT') === '1' && isList
        ? await deps.initWorkspace(repoRoot, home())
        : undefined;
      deps.process.exitCode = await deps.runProjectsCommand(projectArgs, { defaultRoot: repoRoot, bootProjectId, home: home() });
      return;
    }
    case 'server-install':
      await deps.serverCommand('install', home(), repoRoot, values.platform, {
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
      await deps.serverCommand('deploy', home(), repoRoot, values.platform, {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
      return;
    case 'server-uninstall':
      await deps.serverCommand('uninstall', home(), repoRoot, values.platform, {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
      return;
    default:
      deps.console.error(`unknown command: ${command}\n`);
      deps.console.log(help());
      deps.process.exitCode = 1;
  }
}

