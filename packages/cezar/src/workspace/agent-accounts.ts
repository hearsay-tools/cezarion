import { logPrefix } from '../home/display.ts';
import type { Home } from '../home/home.ts';
import { HomeOutsideWriteError, HomeStore, readHomeFile } from '../home/store.ts';
import { realpathSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { z } from 'zod';
import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-contract/agent-profiles';
import { PROVIDER_IDS, type ProviderId } from '../core/provider-auth.ts';
import { ompProfileName, supportsProfiles } from '../core/agent-profiles.ts';

/**
 * Optional agent-account store with root-keyed selections. Preserve unknown keys and salvage
 * entries; write atomically at 0600. Corruption degrades to empty with a warning. Keep account
 * removal and selection cleanup in one write.
 */

/** `id` slug rule — the project rule, for the same URL/segment-safety reason. */
export const AGENT_ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Reserved discovered-default id, never allocated or stored as an account. Re-export the
 * contract’s value so requests and storage share one spelling.
 */
export { DEFAULT_AGENT_ACCOUNT_ID };

/**
 * Is `configDir` absolute on `platform`? The account routes' only path rule, and the reason it is a
 * named function rather than a test written inline.
 *
 * A relative dir would resolve against whatever cwd the agent happens to be spawned in — for a task
 * that is a throwaway worktree — so it has to be refused. But the obvious spelling of that refusal,
 * a leading-`/` test, refuses every real Windows path too: `C:\Users\me\.claude-work` starts with
 * neither `/` nor `~`. That is not a corner case: `core/shell-env.ts` renders `set "VAR=v"` for
 * `cmd.exe` precisely so an account survives a Windows terminal handoff, and the Add-account dialog
 * delegates ALL path validation to the server, so a string test would leave the whole feature
 * unreachable on the one platform the rest of this work went out of its way to support.
 *
 * `platform` is a parameter so both answers stay testable from either OS.
 */
export function isAbsoluteConfigDir(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (platform === 'win32' ? win32 : posix).isAbsolute(configDir);
}

/** C0 controls + DEL. A path containing one is never legitimate and would be interpolated into a
 *  shell command by the CLI handoff, so it is refused at the schema, not just at the route. */
export const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * One extra config dir for a provider — a second login of the same CLI
 * (`CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude`), see `src/core/agent-profiles.ts`.
 *
 * `id`, `provider` and `configDir` are load-bearing and carry no `.catch`: a row missing any of
 * them names no account, so the per-entry salvage below drops it. Display fields degrade per key.
 *
 * `configDir` is stored AS WRITTEN — a literal `~` survives — and every consumer expands it
 * through `expandTilde`.
 */
const agentAccountSchema = z
  .object({
    id: z.string().regex(AGENT_ACCOUNT_ID_RE).refine((v) => v !== DEFAULT_AGENT_ACCOUNT_ID, {
      message: `"${DEFAULT_AGENT_ACCOUNT_ID}" is reserved for the discovered account`,
    }),
    // Refused at the SCHEMA, not just at the route, for the same reason the reserved `default` id
    // is: this file is designed to survive hand edits, foreign writers and the legacy import, and a
    // provider whose credentials do not follow its config dir resolves to a LIE — `profileEnv`
    // returns `{}` for it, so the step records the account, the UI names it, and the CLI runs on
    // the default login anyway. Dropped by the per-entry salvage instead, which is the one
    // degradation that cannot mislead.
    provider: z.enum(PROVIDER_IDS).refine(supportsProfiles, {
      message: 'this agent cannot carry more than one account (its credentials do not follow its config dir)',
    }),
    configDir: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !CONTROL_CHARS_RE.test(v), 'configDir must not contain control characters'),
    label: z.string().max(200).catch(''),
    addedAt: z.string().max(64).catch(''),
  })
  .passthrough()
  // An omp account is an omp PROFILE: `OMP_PROFILE` takes a name, so a folder that is not
  // `…/profiles/<name>` would resolve to `{}` and run on the default login — the provider lie
  // above in another shape, dropped by the same salvage. Shape only; the route also checks the
  // folder is under omp's current root (`ompProfileDirError`).
  .refine((account) => account.provider !== 'omp' || ompProfileName(account.configDir) !== null, {
    message: 'an omp account folder must be an omp profile: <omp root>/profiles/<name>',
  });

export type AgentAccount = z.infer<typeof agentAccountSchema>;

/** Shared salvage and first-wins policy; migration also needs the discarded duplicate rows. */
export function parseAgentAccountEntries(entries: unknown[]): { accounts: AgentAccount[]; duplicates: AgentAccount[]; selectedIndices: number[] } {
  const accounts: AgentAccount[] = [], duplicates: AgentAccount[] = [], selectedIndices: number[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const parsed = agentAccountSchema.safeParse(entry);
    if (!parsed.success) return;
    if (seen.has(parsed.data.id)) { duplicates.push(parsed.data); return; }
    seen.add(parsed.data.id);
    accounts.push(parsed.data);
    selectedIndices.push(index);
  });
  return { accounts, duplicates, selectedIndices };
}

/** One project's choice, per provider. Explicit keys so `PROVIDER_IDS` stays the one source of
 *  truth and the value is bounded. An absent key means the discovered default. */
const selectionSchema = z
  .object({
    claude: z.string().max(64).optional().catch(undefined),
    codex: z.string().max(64).optional().catch(undefined),
    opencode: z.string().max(64).optional().catch(undefined),
    pi: z.string().max(64).optional().catch(undefined),
    cursor: z.string().max(64).optional().catch(undefined),
    omp: z.string().max(64).optional().catch(undefined),
  })
  .passthrough();

export type AgentAccountSelection = z.infer<typeof selectionSchema>;

/** The raw rows the salvage reads: anything that is not an array names no account. */
const accountRowsSchema = z
  .array(z.unknown())
  .default(() => [])
  .catch(() => []);

export const storeSchema = z
  .object({
    /** Format cursor for THIS file, independent of `config.json`'s `schemaVersion`. Nothing reads
     *  it yet; it exists so a future shape change has somewhere to say so. */
    version: z.number().int().min(0).default(1).catch(1),
    accounts: accountRowsSchema.transform((entries) => parseAgentAccountEntries(entries).accounts),
    /**
     * The per-provider account a repo with no selection of its own uses.
     *
     * A machine-wide answer to "which login do I work under", so a second account does not have to
     * be re-chosen for every checkout. Consulted only where `selections` is silent for that repo
     * and provider — a repo that HAS chosen keeps its choice, which is what makes this a default
     * rather than an override.
     */
    defaults: selectionSchema.default(() => ({})).catch(() => ({})),
    /** Repo root → per-provider choice. Per-entry salvage: a bad row is dropped, the rest stay. */
    selections: z
      .record(z.string(), z.unknown())
      .default(() => ({}))
      .catch(() => ({}))
      .transform((raw) => {
        const out: Record<string, AgentAccountSelection> = {};
        for (const [root, value] of Object.entries(raw)) {
          const parsed = selectionSchema.safeParse(value);
          if (parsed.success) out[root] = parsed.data;
        }
        return out;
      }),
  })
  .passthrough();

export type AgentAccountStore = z.infer<typeof storeSchema>;

/** The in-memory default — what a missing file behaves like, and the zero-config state. */
export function defaultAgentAccountStore(): AgentAccountStore {
  return storeSchema.parse({});
}

/**
 * Read the store on demand — never cached, never throws.
 *
 * Not cached because `~/.cezar/` is shared by every Squawk process on the machine, so a snapshot is
 * a staleness bug; one small JSON read is free next to spawning a CLI.
 *
 * A missing file is the zero-config default (silent). A corrupt one degrades to the default with a
 * one-line warning and is left on disk untouched, so the user can repair it by hand — the next
 * successful merge-write is what replaces it.
 */
function loadAgentAccountsSync(home: Home): AgentAccountStore {
  const path = home.agentAccounts;
  let raw: string;
  try {
    raw = readHomeFile(path);
  } catch {
    // Absent — but accounts may predate this file (they lived in config.json on the branch that
    // introduced them), so give those one chance to come across.
    return importLegacyAccounts(home);
  }
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON — fall through to the warning + defaults
  }
  console.warn(`${logPrefix()} agent accounts ${path} is corrupt — ignoring it (every project falls back to its default account)`);
  return defaultAgentAccountStore();
}

/** Retain the async caller contract while transactions remain synchronous. */
export async function loadAgentAccounts(home: Home): Promise<AgentAccountStore> {
  return loadAgentAccountsSync(home);
}

/**
 * Read-modify-write merge: re-read, apply `mutator`, atomic-rename write.
 *
 * Every writer holds the root write.lock across the re-read and replacement, so concurrent
 * processes cannot drop each other's account changes. Throws on write failure (a
 * read-only home); degrading is the caller's policy.
 */
export async function mergeWriteAgentAccounts(
  mutator: (store: AgentAccountStore) => AgentAccountStore | void,
  home: Home,
): Promise<AgentAccountStore> {
  const store = new HomeStore(home);
  return store.transaction(() => {
    const current = loadAgentAccountsSync(home);
    const next = mutator(current) ?? current;
    store.writeJson(home.agentAccounts, next);
    return next;
  }, [home.agentAccounts]);
}

/**
 * One-time, non-destructive import of accounts that were written into `config.json` by the branch
 * that first introduced them (before they got their own file).
 *
 * Reads the RAW object rather than going through the workspace schema, because that schema no
 * longer names these keys — they only survive there as passthrough. Nothing is deleted from
 * `config.json`: an older Squawk sharing this home keeps reading what it has always read, and this
 * import is idempotent because it only runs while `agent-accounts.json` is absent.
 */
function importLegacyAccounts(home: Home): AgentAccountStore {
  // A load may have observed absence just before another process created the store.
  // Keep that recheck, import and publication inside one transaction as well.
  try {
    return new HomeStore(home).transaction(() => {
      try { readHomeFile(home.agentAccounts); return loadAgentAccountsSync(home); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return readLegacyAccounts(home, true);
    }, [home.agentAccounts]);
  } catch (error) {
    if (error instanceof HomeOutsideWriteError) console.warn(`${logPrefix()} ${error.message}; imported accounts are available in memory only`);
    // A missing marker or read-only home still permits the historical in-memory import.
    return readLegacyAccounts(home, false);
  }
}

/** The raw `config.json` keys the one-time import reads; undefined when there is nothing to read. */
function legacyAccountInput(home: Home, read: (path: string) => string): { accounts: unknown; selections: Record<string, unknown> } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(home.workspaceConfig));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const legacy = parsed as { agentProfiles?: unknown; projects?: unknown };
  const selections: Record<string, unknown> = {};
  if (Array.isArray(legacy.projects)) {
    for (const entry of legacy.projects) {
      if (!entry || typeof entry !== 'object') continue;
      const { root, agentProfile } = entry as { root?: unknown; agentProfile?: unknown };
      if (typeof root === 'string' && agentProfile && typeof agentProfile === 'object') {
        selections[root] = agentProfile;
      }
    }
  }
  return { accounts: legacy.agentProfiles, selections };
}

/**
 * What a load reads, without the import's write: the raw account rows its salvage selects from,
 * and the store value a rewrite starts from (the file as written, or the store an import would
 * persist). `value` is undefined for a corrupt file, which a load ignores and never overwrites.
 * The legacy-home migration inventories and relocates accounts through this.
 */
export function readAgentAccountSource(home: Home, read: (path: string) => string = readHomeFile): { rows: unknown[]; value: Record<string, unknown> | undefined } {
  let raw: string;
  try {
    raw = read(home.agentAccounts);
  } catch {
    const input = legacyAccountInput(home, read);
    const imported = input ? storeSchema.safeParse(input) : undefined;
    return input && imported?.success ? { rows: accountRowsSchema.parse(input.accounts), value: imported.data } : { rows: [], value: undefined };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (storeSchema.safeParse(value).success) return { rows: accountRowsSchema.parse((value as { accounts?: unknown }).accounts), value: value as Record<string, unknown> };
  } catch {
    // malformed JSON names no account, as in the loader
  }
  return { rows: [], value: undefined };
}

function readLegacyAccounts(home: Home, persist: boolean): AgentAccountStore {
  const input = legacyAccountInput(home, readHomeFile);
  if (!input) return defaultAgentAccountStore();
  const imported = storeSchema.safeParse(input);
  if (!imported.success) return defaultAgentAccountStore();
  // Only worth persisting when there was something to carry over; an empty import must not create
  // a file, or the zero-config promise ("delete any of them and Squawk rebuilds") gains a file that
  // exists for no reason.
  if (!persist || imported.data.accounts.length === 0) return imported.data;
  try {
    const path = home.agentAccounts;
    new HomeStore(home).writeJson(path, imported.data);
  } catch (error) {
    if (error instanceof HomeOutsideWriteError) console.warn(`${logPrefix()} ${error.message}; imported accounts are available in memory only`);
    // read-only home: the import stays in memory for this process, which is still correct
  }
  return imported.data;
}

/**
 * The account `provider` uses for `repoRoot`, or undefined when nothing has an opinion.
 *
 * Repo first, then the machine-wide default. The order is the whole feature: a repo that chose is
 * never overruled by a later change to the default, and a repo that never chose follows it — so
 * adding a second login is a one-time act rather than one per checkout.
 */
export function selectionFor(
  store: Pick<AgentAccountStore, 'selections' | 'defaults'>,
  repoRoot: string | undefined,
  provider: ProviderId,
): string | undefined {
  const chosen = repoRoot === undefined ? undefined : selectionForRoot(store, repoRoot)?.[provider];
  return chosen ?? store.defaults[provider];
}

/**
 * The selection stored for `repoRoot`, matched on the literal spelling first and the realpath'd
 * one second.
 *
 * The keys come from the REGISTRY, which realpath-normalizes every root it stores
 * (`workspace/projects.ts` `normalizeRoot`); the readers hold whatever spelling their caller had —
 * `RunManager` is constructed with `repoInfo?.root ?? cwd` for the boot project, not with the
 * registry entry. `workspace/semaphore.ts` already normalizes at lookup for the per-project
 * concurrency map for exactly this reason. Doing it here too matters more, not less: a missed
 * concurrency override runs the task with the wrong ceiling, a missed account selection runs it on
 * the wrong subscription and says nothing.
 *
 * The literal probe comes first because it is free and answers the overwhelmingly common case; the
 * normalized one only pays a `realpathSync` when the literal key is absent.
 */
function selectionForRoot(
  store: Pick<AgentAccountStore, 'selections'>,
  repoRoot: string,
): AgentAccountSelection | undefined {
  const literal = store.selections[repoRoot];
  if (literal !== undefined) return literal;
  const normalized = normalizeRootSync(repoRoot);
  return normalized === repoRoot ? undefined : store.selections[normalized];
}

/** Realpath-normalize a root the way the registry does, but synchronously — this answers a run's
 *  per-step lookup and must not `await`. A path that cannot be realpath'd (gone, unreadable)
 *  degrades to `resolve()`, matching the registry's own fallback and `semaphore.ts`'s. */
function normalizeRootSync(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}
