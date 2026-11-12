import { logPrefix } from './home/display.ts';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentHomePaths } from './agent-config/catalog.ts';
import { isOmpProfileName } from './core/agent-profiles.ts';

import { assertOutsideAccountHome } from './home/protected-roots.ts';
import type { Home } from './home/home.ts';

/**
 * Test writers must never reach the account's real cezar home. HOME can be a
 * sandbox, so read the account home from the OS. Runner detection belongs to
 * the process: a caller's custom env must not disable this guard.
 */
export function assertSquawkHomeWriteIsSandboxed(path: string, _env: NodeJS.ProcessEnv = process.env): void {
  const testing = process.env.VITEST || process.env.NODE_TEST_CONTEXT || process.env.JEST_WORKER_ID
    || Object.keys(process.env).some((key) => key.startsWith('STRYKER_'));
  if (!testing) return;
  assertOutsideAccountHome(path, () => new Error(
    `${logPrefix()} refusing to write ${path} from a test run — CEZ_HOME is not pinned to a sandbox. ` +
      'Pin it to a test sandbox so the suite never touches the real cezar home.',
  ));
}

/**
 * The default server-install instance id. An install with no `--domain` (the
 * original single-cockpit-per-host flow) is this instance, and it keeps the
 * legacy `~/.cezar/server.json` path so existing hosts upgrade in place.
 */
export const DEFAULT_SERVER_INSTANCE = 'default';

/**
 * Turn a public domain into a stable, filesystem- and systemd-safe instance
 * slug — the key that lets one host run several independent cockpits, each for
 * a different domain (nginx site `cezar-<slug>`, unit `cezar-<slug>.service`,
 * state file `server-instances/<slug>.json`). Lowercased; every run of
 * non-`[a-z0-9]` becomes a single `-`; leading/trailing `-` trimmed. A `.` in a
 * systemd unit name is a type separator, so dots collapse to `-` too. Returns
 * `default` for empty/degenerate input so a bad value can never escape the
 * instance namespace.
 */
export function instanceSlug(domain: string | undefined | null): string {
  const slug = String(domain ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || DEFAULT_SERVER_INSTANCE;
}

/** The directory holding per-domain (named) server-install state files. */
export function serverInstancesDir(home: Home): string {
  return home.serverInstances;
}

/**
 * Host-level record written by `server-install` (spec 2026-07-16-server-installer).
 * The `default` instance keeps the original `~/.cezar/server.json`; a named
 * (domain-keyed) instance lives at `~/.cezar/server-instances/<slug>.json`, so
 * a second install for a different domain never resumes or clobbers the first.
 * Distinct from the per-user project registry the multi-project workspace keeps
 * inside `~/.cezar/config.json` (see `workspaceConfigPath`) — they coexist.
 */
export function serverStatePath(instance: string = DEFAULT_SERVER_INSTANCE, home: Home): string {
  return home.serverState(instance);
}

/**
 * Per-user workspace config (spec 2026-07-20-multi-project-workspace): schema
 * version, global defaults, and the project registry — every repo cezar has
 * been booted in. The legacy layout keeps it under `Home.root`, so the `CEZ_HOME`
 * override applies (tests/containers never touch a real home dir).
 */
export function workspaceConfigPath(env: NodeJS.ProcessEnv = process.env, home: Home): string {
  return home.workspaceConfig;
}

/**
 * Global GUI state — the workspace twin of the per-repo
 * `.ai/cezar/ui-state.json`. Cross-project UI prefs live here; per-project
 * state (pinned runs, templates) stays in each repo's file.
 */
export function workspaceUiStatePath(home: Home): string {
  return home.workspaceUiState;
}

/**
 * Agent accounts and per-project selections use their own file. Account deletion and selection
 * cleanup share one atomic write.
 */
export function agentAccountsPath(home: Home): string {
  return home.agentAccounts;
}

/**
 * Expand a leading `~` to the user's home. Lives here with the other homedir
 * logic (see the module note above — one place owns `homedir()`): the
 * workspace browse/checkout roots are stored as the user wrote them (a literal `~`), so
 * every consumer that must touch the REAL directory — the writability probe on
 * `PUT /api/workspace/config`, the browse root in
 * `src/server/fs-browse.ts` — expands it through this one helper.
 */
export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * Single-writer lock the installer/uninstaller hold for a whole run. Per
 * instance, so installing/uninstalling one cockpit never blocks work on another
 * on the same host. The host-level installer is not concurrency-safe with
 * itself *for the same instance*.
 */
export function serverLockPath(instance: string = DEFAULT_SERVER_INSTANCE, home: Home): string {
  return home.serverLock(instance);
}

/**
 * Where each coding agent keeps its per-user config, honouring the env vars the
 * vendors document: `$CLAUDE_CONFIG_DIR` relocates Claude Code's home;
 * `$CODEX_HOME` relocates Codex's; `$XDG_CONFIG_HOME` relocates OpenCode's config
 * dir (falling back to `~/.config`); `$PI_CODING_AGENT_DIR` relocates Pi's agent dir
 * (default `~/.pi/agent`); OMP reads that variable too unless `$OMP_PROFILE` selects a profile
 * (`ompAgentDir`). Read per call so tests and ops can set env live.
 *
 * These are the DEFAULT profile's dirs. A second login of the same CLI is an
 * agent profile (`src/core/agent-profiles.ts`) and resolves through
 * `agentHomePathsForProfiles` instead — what this function answers is what the
 * host is configured for when nothing overrides it.
 */
export function agentHomePaths(env: NodeJS.ProcessEnv = process.env): AgentHomePaths {
  const home = env.HOME || env.USERPROFILE || homedir();
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return {
    claude: env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'),
    codex: env.CODEX_HOME?.trim() || join(home, '.codex'),
    opencodeConfig: join(xdgConfig, 'opencode'),
    pi: env.PI_CODING_AGENT_DIR?.trim() || join(home, '.pi', 'agent'),
    cursor: env.CURSOR_CONFIG_DIR?.trim()
      || ((process.platform === 'linux' || process.platform === 'freebsd') && env.XDG_CONFIG_HOME?.trim()
        ? join(env.XDG_CONFIG_HOME.trim(), 'cursor') : join(home, '.cursor')),
    omp: ompAgentDir(env, home),
  };
}

/**
 * OMP's (Oh My Pi's) agent dir under `env`, mirroring how omp 18.8.0 resolves it
 * (`packages/utils/src/dirs.ts`):
 *
 * - a profile — `OMP_PROFILE` when it is set at all, else `PI_PROFILE` — selects
 *   `<root>/profiles/<name>/agent`, and omp then ignores `PI_CODING_AGENT_DIR`;
 * - otherwise `PI_CODING_AGENT_DIR`, else `<root>/agent`;
 *
 * where `<root>` is `~/<PI_CONFIG_DIR or .omp>`. A host that exports a profile therefore moves the
 * DEFAULT account (see `PROFILE_ENV_VAR` in `core/agent-profiles.ts`). `default`, a blank value
 * and a name omp would refuse select no profile.
 */
function ompAgentDir(env: NodeJS.ProcessEnv, home: string): string {
  const root = ompRootDir(env, home);
  const selected = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  if (selected && isOmpProfileName(selected)) return join(root, 'profiles', selected, 'agent');
  return env.PI_CODING_AGENT_DIR?.trim() || join(root, 'agent');
}

function ompRootDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(home, env.PI_CONFIG_DIR?.trim() || '.omp');
}

/**
 * Where omp keeps its named profiles, `~/<PI_CONFIG_DIR or .omp>/profiles`. A named omp account
 * is one folder in here: `OMP_PROFILE` takes a name, so a folder anywhere else could not be
 * selected (see `ompProfileDirError` in `workspace/agent-profiles.ts`).
 */
export function ompProfilesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ompRootDir(env, env.HOME || env.USERPROFILE || homedir()), 'profiles');
}

/**
 * Where Claude Code keeps `.claude.json` — its MCP/state file — for a given config dir. The
 * location is NOT uniform: by default the file is a SIBLING of `~/.claude`, but under a
 * `CLAUDE_CONFIG_DIR` override it moves INSIDE the overridden dir (verified against the shipped CLI
 * 2026-07-29, and against a real second-account dir on disk). Reading it from `dirname(configDir)`
 * unconditionally — as this repo did — lands on `~/.claude.json` for a `~/.claude-klaudiusz`
 * profile, i.e. the wrong account's file.
 *
 * The condition below reads like two heuristics OR-ed together; it is one exact rule. The file sits
 * inside precisely when the CLI will SEE `CLAUDE_CONFIG_DIR` for this dir, and cezar knows when
 * that is:
 *
 *   - a stored account is always spawned with it (`profileEnv`), and its dir is by construction not
 *     `~/.claude` — the route refuses a dir that is already the discovered account's;
 *   - the DISCOVERED account is spawned with nothing added, so it sees the variable only when the
 *     cezar process itself carries one — and it does reach the child, because `CLAUDE_` is in
 *     `BACKEND_ALLOW_PREFIXES`.
 *
 * One case is worth naming because it looks like a bug and is not. Start cezar with
 * `CLAUDE_CONFIG_DIR=/opt/work` and add `~/.claude` as a NAMED account (legal — the discovered
 * account is `/opt/work`, so `~/.claude` is not a duplicate). This answers `~/.claude/.claude.json`,
 * not the sibling `~/.claude.json`, and "Show details" can therefore say "not signed in" for a
 * folder a bare `claude` would treat as signed in. That is correct rather than unfortunate: cezar
 * will run that account as `CLAUDE_CONFIG_DIR=~/.claude claude`, and under that invocation the
 * state file the CLI reads and writes IS the one inside. Reporting the sibling would describe a
 * login this account will never use.
 */
export function claudeStateFilePath(claudeHome: string, env: NodeJS.ProcessEnv = process.env): string {
  const seesOverride = (env.CLAUDE_CONFIG_DIR?.trim() || '') !== ''
    || claudeHome !== join(env.HOME || env.USERPROFILE || homedir(), '.claude');
  return seesOverride ? join(claudeHome, '.claude.json') : join(dirname(claudeHome), '.claude.json');
}
