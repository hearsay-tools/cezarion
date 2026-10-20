import { join } from 'node:path';
import type { ProviderId } from './provider-auth.ts';

/**
 * Agent profiles — a second (third, …) login of the SAME agent CLI.
 *
 * The binary never changes; only the environment does. `CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude`
 * is the same Claude Code talking to a different account, because that one variable relocates the
 * agent's ENTIRE per-user home: credentials, settings, projects and — the part that bites —
 * `sessions/`, so a session id only means something inside the dir it was created in.
 *
 * This module is the single maintenance surface for that vendor knowledge, and it is deliberately
 * the SIBLING of `src/agent-config/catalog.ts` rather than part of it: the catalog owns config
 * *file* knowledge (paths, formats, verbatim precedence strings), this owns the *home-relocation*
 * variable. Splitting them also keeps the layering honest — `agent-config/` may import `paths.ts`,
 * while this is imported BY the runners, provider auth and the terminal handoff.
 *
 * Pure by construction: no filesystem, no `process.env`, nothing to stub. Resolution against the
 * workspace config lives in `src/workspace/agent-profiles.ts`.
 *
 * Facts verified against the shipped CLIs on 2026-07-29 (Claude, Codex) and 2026-10-19 (pi, omp,
 * OpenCode).
 */

/**
 * Which env var moves each agent onto another account.
 *
 * For every provider but omp the variable relocates the agent's whole per-user home and takes a
 * folder; omp's takes a profile NAME (see `profileEnv`). `null` means the agent has no such
 * variable and therefore cannot carry profiles.
 *
 * - **claude** → `CLAUDE_CONFIG_DIR`. Documented; moves credentials, settings, projects, sessions.
 * - **codex** → `CODEX_HOME`. Documented; `auth.json` lives inside it, so identity moves too.
 * - **pi** → `PI_CODING_AGENT_DIR` (pi 1.0.4: `pi --help` "Config directory (default:
 *   ~/.pi/agent)"; source `auth-storage.js`, `package-manager.js`). Moves the whole pi home:
 *   `auth.json`, `mcp-auth.json`, models, settings, trust, sessions, packages, skills,
 *   extensions and `AGENTS.md`. It does NOT move `~/.agents/skills`, which every account still
 *   reads — skills are content, not identity, which is the line this feature already draws.
 *   Tested 2026-10-19 (hearsay-tools/cezarion#1283): after one real turn in a fresh dir it held
 *   `auth.json`, `models-store.json` and `sessions/`, and `~/.pi/agent` was untouched; a session
 *   only resumes inside the dir that created it.
 * - **omp** → `OMP_PROFILE` (omp 18.8.0, same as `--profile`). Selects
 *   `~/<PI_CONFIG_DIR or .omp>/profiles/<name>/`, whose `agent/agent.db` is the credential store
 *   (`auth_credentials`), beside sessions, logs, cache and settings. Tested 2026-10-19: the
 *   profile entry may be a symlink to a folder elsewhere; `~/.omp/natives` stays shared, and
 *   `~/.claude/plugins` and `~/.agents/skills` are still read. Under a profile omp ignores
 *   `PI_CODING_AGENT_DIR`.
 * - **opencode** → nothing usable. Provider credentials live in `$XDG_DATA_HOME/opencode/auth.json`
 *   (plus `mcp-auth.json`); `opencode.db` beside it holds sessions. `OPENCODE_CONFIG_DIR` /
 *   `OPENCODE_CONFIG` move config only and `OPENCODE_DB` moves only the database (OpenCode 1.18.35,
 *   `core/src/global.ts`, `database.ts`; tested 2026-10-19). A config-dir-only profile would swap
 *   settings while still billing the other account — the UI would say "Work" and the run would
 *   not be — so OpenCode is unsupported until one variable moves both. `XDG_DATA_HOME` /
 *   `XDG_CONFIG_HOME` are rejected regardless: they are machine-wide and would relocate every
 *   other XDG-aware tool the agent's own Bash calls touch.
 *
 * ## A host that already exports the variable
 *
 * `agent-env.ts` passes `PI_*` to pi and `OMP_*`/`PI_*` to omp, so a value the cezar process
 * carries reaches every session of that agent. The rule is the one Claude and Codex follow:
 *
 * - the host value moves the DEFAULT account. `agentHomePaths()` discovers it, and the default is
 *   spawned with nothing added, so the child inherits it. For omp that means a host `OMP_PROFILE`
 *   (or `PI_PROFILE` when `OMP_PROFILE` is unset) makes that profile the default, and a host
 *   `PI_CODING_AGENT_DIR` moves the default only while no profile is selected;
 * - a named account's variable is applied after the allowlist (`buildChildEnv`'s `extraEnv`), so
 *   it replaces the host value for that session. omp then rewrites `PI_CODING_AGENT_DIR` to the
 *   profile's own agent dir itself, so a host value cannot leak into a named profile;
 * - the default's own folder cannot also be added as a named account (`conflictingProfile`).
 *
 * A host `PI_CONFIG_DIR` moves omp's root, so it also decides where named omp profiles must live
 * (`ompProfilesDir`).
 */
export const PROFILE_ENV_VAR: Record<ProviderId, string | null> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  opencode: null,
  pi: 'PI_CODING_AGENT_DIR',
  // CURSOR_CONFIG_DIR relocates configuration, not a verified whole account home.
  cursor: null,
  omp: 'OMP_PROFILE',
};

/** Providers that can carry more than one account — what the UI offers "Add account" for. */
export const PROFILE_CAPABLE_PROVIDERS: readonly ProviderId[] = (
  Object.keys(PROFILE_ENV_VAR) as ProviderId[]
).filter((provider) => PROFILE_ENV_VAR[provider] !== null);

export function supportsProfiles(provider: ProviderId): boolean {
  return PROFILE_ENV_VAR[provider] !== null;
}

/**
 * The env a spawned agent needs to run under `configDir`, or `{}` for the default profile.
 *
 * `{}` is load-bearing, not a convenience: `buildChildEnv` applies `extraEnv` AFTER its allowlist
 * and so bypasses it entirely, which makes this function the only thing standing between a
 * profile and the child environment. Returning nothing for the zero-config case means the
 * overwhelmingly common path adds literally no variable — the same environment cezar has always
 * spawned. It also means this can never emit one provider's variable for another provider's
 * process: the name comes from `PROFILE_ENV_VAR[provider]` and nowhere else.
 *
 * omp is the one provider whose variable takes a name rather than a folder: an omp account IS an
 * omp profile, so its folder is `<omp root>/profiles/<name>` and this emits `OMP_PROFILE=<name>`.
 * A folder that names no profile — the discovered default's agent dir among them — adds nothing;
 * the accounts store refuses such a folder for a NAMED account, so that branch never turns a named
 * account into the default.
 */
export function profileEnv(provider: ProviderId, configDir: string | null | undefined): Record<string, string> {
  const name = PROFILE_ENV_VAR[provider];
  const dir = configDir?.trim();
  if (name === null || !dir) return {};
  if (provider === 'omp') {
    const profile = ompProfileName(dir);
    return profile === null ? {} : { [name]: profile };
  }
  return { [name]: dir };
}

/** omp's own profile-name rule (omp 18.8.0, `packages/utils/src/dirs.ts`). */
const OMP_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Windows device names omp refuses as a profile, with or without an extension. */
const OMP_RESERVED_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * The omp profile a folder names, or `null` when it names none.
 *
 * A folder names a profile when its parent is called `profiles` and its own name passes every rule
 * omp applies, so cezar never hands omp a profile it would refuse at startup. `default` is refused
 * too: omp reads it as "no profile", so a named account under that name would be the default.
 *
 * Shape only — whether `profiles/` is the one under omp's CURRENT root needs the environment, and
 * `ompProfileDirError` (workspace) checks that. Both separators are accepted so a Windows folder
 * parses on any host.
 */
export function ompProfileName(dir: string): string | null {
  const segments = dir.split(/[\\/]+/).filter((segment) => segment !== '');
  if (segments.length < 2 || segments[segments.length - 2] !== 'profiles') return null;
  const name = segments[segments.length - 1]!;
  return isOmpProfileName(name) ? name : null;
}

/** Whether omp accepts `name` as a profile of its own; `default` is omp's "no profile". */
export function isOmpProfileName(name: string): boolean {
  return OMP_PROFILE_NAME_RE.test(name) && !name.endsWith('.') && name !== 'default'
    && !OMP_RESERVED_NAME_RE.test(name);
}

/**
 * Where the agent keeps its config inside an account folder: the folder itself, except omp, whose
 * profile folder keeps it in `agent/`. The discovered omp default is ALREADY an agent dir
 * (`agentHomePaths().omp`), so callers apply this to named accounts only.
 */
export function profileAgentDir(provider: ProviderId, dir: string): string {
  return provider === 'omp' ? join(dir, 'agent') : dir;
}

/**
 * Does `entries` look like a config dir this provider actually wrote?
 *
 * ADVISORY, never a gate. The honest first-run flow for a second account is *add the profile →
 * Connect → the CLI creates the dir on login*, so refusing an unrecognized directory would break
 * the very case the feature exists for. The answer drives a warning line in the UI, nothing more.
 *
 * Takes the directory listing rather than a path so it stays pure; the caller reads the dir.
 */
export function looksLikeProfileDir(provider: ProviderId, entries: readonly string[]): boolean {
  const present = new Set(entries);
  const markers = PROFILE_DIR_MARKERS[provider];
  return markers.some((marker) => present.has(marker));
}

/** What each agent drops into its home on first login. Any one is enough. */
const PROFILE_DIR_MARKERS: Record<ProviderId, readonly string[]> = {
  // `.claude.json` sits INSIDE the dir once it is overridden (see `claudeStateFilePath`), which
  // is exactly the case being probed here.
  claude: ['.claude.json', 'settings.json', 'projects', 'sessions'],
  codex: ['auth.json', 'config.toml'],
  // OpenCode cannot carry profiles (`PROFILE_ENV_VAR.opencode === null`); the discovered config
  // dir is probed, but nothing it holds marks a login.
  opencode: [],
  pi: ['auth.json', 'settings.json', 'models.json', 'sessions'],
  cursor: [],
  // A named account is a profile folder (`agent/`, `logs/`, `run/`, `cache/`); the discovered
  // default is an agent dir (`agent.db`, `config.yml`, `sessions/`). Either listing answers.
  omp: ['agent', 'agent.db', 'config.yml', 'sessions'],
};
