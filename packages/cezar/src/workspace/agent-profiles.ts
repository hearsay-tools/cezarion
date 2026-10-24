import { realpathSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isOmpProfileName, ompProfileName, profileEnv, looksLikeProfileDir } from '../core/agent-profiles.ts';
import type { ProviderId } from '../core/provider-auth.ts';
import { agentHomePaths, expandTilde, ompProfilesDir } from '../paths.ts';
import {
  DEFAULT_AGENT_ACCOUNT_ID,
  loadAgentAccounts,
  selectionFor,
  type AgentAccount,
  type AgentAccountStore,
} from './agent-accounts.ts';

/**
 * Resolving an agent account against `~/.cezar/agent-accounts.json` — the I/O half of
 * `src/core/agent-profiles.ts` (which stays pure and owns the vendor knowledge).
 *
 * Nothing here is cached. `~/.cezar/` is shared by every cezar process on the machine (a `serve`
 * per repo, headless `cezar run`s, a settings PUT), so a snapshot is a staleness bug waiting to
 * happen — and one small JSON read is free next to spawning an agent CLI.
 */

/** An account as the rest of the codebase consumes it: id, provider, and the dir to point at. */
export interface ResolvedAgentProfile {
  id: string;
  provider: ProviderId;
  label: string;
  /** As stored (`~` kept) — what the user typed, or the discovered default's path. */
  configDir: string;
  /** Expanded absolute path — what actually gets handed to the CLI. */
  path: string;
  /** True for the discovered account, which is never stored and cannot be edited or deleted. */
  isDefault: boolean;
}

/**
 * The implicit account for a provider: whatever `agentHomePaths()` discovers, which already
 * honours the vendors' own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME`. Setting one of
 * those on the cezar process therefore moves the DEFAULT account rather than being ignored.
 */
export function defaultAgentProfile(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentProfile {
  const home = agentHomePaths(env);
  const path = { claude: home.claude, codex: home.codex, opencode: home.opencodeConfig, pi: home.pi, cursor: home.cursor, omp: home.omp }[provider];
  return {
    id: DEFAULT_AGENT_ACCOUNT_ID,
    provider,
    label: 'Default',
    configDir: path,
    path,
    isDefault: true,
  };
}

/** Expand a stored account into its resolved form. Pure; the caller supplies the row. */
export function resolveStoredProfile(account: AgentAccount): ResolvedAgentProfile {
  return {
    id: account.id,
    provider: account.provider,
    label: account.label || account.id,
    configDir: account.configDir,
    path: expandTilde(account.configDir),
    isDefault: false,
  };
}

/** Every account for `provider`, discovered default first, then the stored extras in file order. */
export function profilesForProvider(
  store: Pick<AgentAccountStore, 'accounts'>,
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentProfile[] {
  return [
    defaultAgentProfile(provider, env),
    ...store.accounts.filter((a) => a.provider === provider).map(resolveStoredProfile),
  ];
}

/** Every account across every provider — the listing route's source. */
export function listAgentProfiles(
  store: Pick<AgentAccountStore, 'accounts'>,
  providers: readonly ProviderId[],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentProfile[] {
  return providers.flatMap((provider) => profilesForProvider(store, provider, env));
}

/**
 * Resolve explicit choice, then project selection, then discovered default. Unknown selections
 * fall back here; a known unavailable named account must fail later availability checks.
 */
export function selectProfile(
  store: AgentAccountStore,
  options: { provider: ProviderId; repoRoot?: string; profileId?: string; env?: NodeJS.ProcessEnv },
): ResolvedAgentProfile {
  const { provider, repoRoot, profileId } = options;
  const env = options.env ?? process.env;
  const chosen = profileId ?? selectionFor(store, repoRoot, provider);
  if (chosen === undefined || chosen === DEFAULT_AGENT_ACCOUNT_ID) return defaultAgentProfile(provider, env);
  const stored = store.accounts.find((a) => a.id === chosen && a.provider === provider);
  return stored ? resolveStoredProfile(stored) : defaultAgentProfile(provider, env);
}

/**
 * The env a spawned `provider` process needs for the account selected by `repoRoot`/`profileId`.
 *
 * `{}` for the default account, which is the whole point: the zero-config path adds nothing to the
 * child environment. Reads the store per call (see the module note). An unreadable home degrades to
 * the default account, which is the behaviour cezar had before accounts existed. The one throw is
 * `AgentAccountUnavailableError`, for a named account that would open another folder than its own
 * (`namedAccountUnavailable`); spawning bare instead would bill the default while the UI names the
 * stored account.
 */
export async function resolveProfileEnvForRoot(
  repoRoot: string | undefined,
  provider: ProviderId,
  profileId?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: ResolvedAgentProfile; env: Record<string, string> }> {
  let store: AgentAccountStore;
  try {
    store = await loadAgentAccounts();
  } catch {
    return { profile: defaultAgentProfile(provider, env), env: {} };
  }
  const profile = selectProfile(store, { provider, repoRoot, profileId, env });
  // The default account contributes nothing: `agentHomePaths()` already reflects whatever the host
  // env says, so re-exporting it would be a no-op at best and a surprise at worst.
  if (profile.isDefault) return { profile, env: {} };
  const unavailable = namedAccountUnavailable(provider, profile.path, env);
  if (unavailable !== null) throw new AgentAccountUnavailableError(unavailable);
  return { profile, env: profileEnv(provider, profile.path) };
}

/** Whether an account's directory exists and looks like the agent wrote it. Never throws. */
export async function profileDirState(
  provider: ProviderId,
  path: string,
): Promise<{ exists: boolean; looksValid: boolean }> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return { exists: false, looksValid: false };
  }
  return { exists: true, looksValid: looksLikeProfileDir(provider, entries) };
}

/**
 * Which login a runtime-auth self-check must interrogate for a recorded `profileId`.
 *
 * Three answers, deliberately distinct because they demand different behavior from the caller:
 *
 * - `{ kind: 'default' }` — the step ran on the discovered account (no id, or the reserved
 *   `default`), so probing bare is correct and is the whole zero-config path.
 * - `{ kind: 'profile', … }` — a stored account; verify THAT login, not whichever one happens to
 *   be default. A named account can be rejected while the default is fine, and clearing the
 *   incident on the default's answer would let every future run on the broken account fail again.
 * - `null` — the id names no account we can see (dangling reference, unreadable store). The caller
 *   must KEEP the incident latched: an unverifiable rejection is not a recovered one, and
 *   `selectProfile`'s silent degrade-to-default is exactly the wrong policy here.
 */
export type RuntimeAuthVerificationTarget =
  | { kind: 'default' }
  | { kind: 'profile'; id: string; configDir: string };

export async function resolveRuntimeAuthVerificationTarget(
  provider: ProviderId,
  profileId: string | undefined,
): Promise<RuntimeAuthVerificationTarget | null> {
  if (profileId === undefined || profileId === DEFAULT_AGENT_ACCOUNT_ID) return { kind: 'default' };
  let store: AgentAccountStore;
  try {
    store = await loadAgentAccounts();
  } catch {
    return null;
  }
  const account = store.accounts.find((a) => a.id === profileId && a.provider === provider);
  return account
    ? { kind: 'profile', id: account.id, configDir: resolveStoredProfile(account).path }
    : null;
}

/**
 * Why `path` cannot be a named omp account, or `null` when it can. `path` is already expanded.
 *
 * An omp account is an omp profile, selected by NAME (`OMP_PROFILE`), and omp resolves that name
 * under its own root: `~/<PI_CONFIG_DIR or .omp>/profiles/<name>`. A folder anywhere else would
 * make omp open a different folder than the one Settings names, so it is refused here rather than
 * discovered at run time. The parent is compared through `realpath`, so the real spelling of a
 * profiles dir behind a symlinked home is the same place; the profile entry itself may be a symlink
 * to a folder elsewhere, which omp follows. Synchronous, because an owned worker's launch
 * (`boundWorkerAccountEnv`) repeats the check through `namedAccountUnavailable`.
 */
export function ompProfileDirError(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const profilesDir = ompProfilesDir(env);
  const name = ompProfileName(path);
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '');
  const last = segments[segments.length - 1] ?? '';
  if (name === null && segments[segments.length - 2] === 'profiles' && !isOmpProfileName(last)) {
    return `"${last}" is not an omp profile name: use lowercase letters, digits, ".", "_" or "-" (not "default")`;
  }
  const parent = dirname(resolve(path));
  if (name === null || !sameDirSync(parent, profilesDir)) {
    return `an omp account is an omp profile: the folder must be ${profilesDir}/<name>`;
  }
  return null;
}

/**
 * A named account cezar refuses to spawn as it stands. The caller fails the step or answers with
 * the message. It never falls back to the default account, which would bill an account the UI
 * does not name.
 */
export class AgentAccountUnavailableError extends Error {
  override readonly name = 'AgentAccountUnavailableError';
}

/**
 * Why a named account would open another folder than its own if spawned now, or `null`.
 *
 * Only omp can. Its account is a profile NAME, and omp resolves the name under the root it computes
 * at spawn from `HOME` and `PI_CONFIG_DIR`. The route checked the folder against the root of the
 * day it was added. After either variable changes, `OMP_PROFILE=<name>` opens
 * `<new root>/profiles/<name>`, another profile or a fresh empty one, while Settings still shows the
 * stored folder. Every other provider is handed the folder itself. `env` is the env the child takes
 * `HOME` and `PI_CONFIG_DIR` from.
 */
export function namedAccountUnavailable(
  provider: ProviderId,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (provider !== 'omp' || ompProfileDirError(path, env) === null) return null;
  return `omp would not open this account's folder ${path}: omp now reads profiles from ${ompProfilesDir(env)}, `
    + 'because HOME or PI_CONFIG_DIR changed after the account was added. Point the account at a profile there, '
    + 'or restore the old value.';
}

function sameDirSync(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Is `path` the same directory as an existing account's (or the default's)?
 *
 * Compared through `realpath` so two spellings of one dir — a symlink, a trailing slash — cannot
 * become two accounts that silently share a session store. A path that does not exist yet cannot
 * collide with anything, which is correct: the CLI has not created it, so it is nobody's home.
 */
export async function sameProfileDir(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}
