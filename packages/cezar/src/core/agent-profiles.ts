import { join } from 'node:path';
import type { ProviderId } from './provider-auth.ts';

/**
 * Pure native account-home mappings. Keep file-catalog knowledge separate from account
 * relocation. Workspace code resolves saved accounts; runners, auth and terminal handoff consume
 * this mapping.
 */

/**
 * Account relocation variables used by cezar. null means named accounts are unsupported. omp
 * takes a profile name; other supported mappings take a folder. Host values define the default;
 * named overrides apply last. Refuse a named omp folder outside the current profile root.
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
 * Build a provider-specific account override, or an empty object for the discovered default. omp
 * takes a profile name parsed from its folder. Never emit another provider’s variable.
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
