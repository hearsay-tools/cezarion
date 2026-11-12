import { logPrefix } from '../home/display.ts';
import { productEnv } from '../core/product-env.ts';
import type { Home } from '../home/home.ts';
import { HomeStore, homeFileRoot, readHomeFile } from '../home/store.ts';
import { z } from 'zod';
// Contract VALUES, like `workspaceUiStateSchema` in workspace/migrations.ts: the tag bounds this
// file must not `.catch` away are the same constants the PATCH route validates against, so they
// are imported rather than repeated.
import {
  PROJECT_ID_PATTERN,
  PROJECT_TAGS_MAX,
  PROJECT_TAG_MAX_LENGTH,
  PROJECT_WEBHOOK_DESCRIPTION_MAX_LENGTH,
  PROJECT_WEBHOOK_ID_PATTERN,
  PROJECT_WEBHOOK_NAME_MAX_LENGTH,
  PROJECT_WEBHOOK_TOKEN_MAX_LENGTH,
  PROJECT_WEBHOOKS_MAX,
} from '@open-mercato/cezar-contract/project-limits';
import { WEBHOOK_TRIGGERS, type WebhookTrigger } from '@open-mercato/cezar-contract/attention';
import { projectWebhookUrlSchema } from '@open-mercato/cezar-contract/projects';
import { PROVIDER_IDS, type ProviderId } from '../core/provider-auth.ts';

/**
 * `~/.cezar/config.json` — the per-user workspace config + project registry
 * (spec 2026-07-20-multi-project-workspace). House rules from the spec's Data
 * Model, applied verbatim:
 *
 * - every field optional/defaulted with `.catch`, so a bad value degrades
 *   per-key instead of discarding the file;
 * - `.passthrough()` at every object level, so keys a *newer* cezar wrote
 *   survive a round-trip through an older one;
 * - `.max()` bounds on strings (this file is parsed on every boot);
 * - atomic tmp+rename writes with mode `0600` (dir `0700`);
 * - a corrupt file degrades to in-memory defaults plus ONE warning line — the
 *   registry rebuilds as projects are opened, so losing it is an
 *   inconvenience, not data loss. The corrupt file is left in place until the
 *   next successful merge-write replaces it.
 */

/** `id` slug rule — the contract's, which the activity query shares. */
export const PROJECT_ID_RE = PROJECT_ID_PATTERN;

/** The states that send a delivery (hearsay-tools/cezarion#1356). Absent means the default; `[]`
 *  stays `[]`. An unknown value (a newer cezar's option) is dropped on its own and the rest of the
 *  list kept, so one value never resets the selection. */
const storedTriggersSchema = z
  .array(z.unknown())
  .transform((values) => [...new Set(values.filter(isWebhookTrigger))])
  .optional()
  .catch(undefined);

/** The single task webhook a project stored before hearsay-tools/cezarion#1576 (#589). */
const legacyWebhookSchema = z
  .object({
    url: projectWebhookUrlSchema,
    token: z.string().max(PROJECT_WEBHOOK_TOKEN_MAX_LENGTH).optional().catch(undefined),
    triggers: storedTriggersSchema,
  })
  .passthrough();

/** One project webhook (hearsay-tools/cezarion#1576). The token lives here, in the per-user 0600
 *  registry, and never leaves the server: `toProjectListEntry` (projects.ts) swaps it for
 *  `tokenSet`. Bounds mirror the create and edit bodies, so a stored value is never caught away. */
const storedWebhookSchema = z
  .object({
    id: z.string().regex(PROJECT_WEBHOOK_ID_PATTERN),
    name: z.string().trim().min(1).max(PROJECT_WEBHOOK_NAME_MAX_LENGTH),
    description: z.string().max(PROJECT_WEBHOOK_DESCRIPTION_MAX_LENGTH).optional().catch(undefined),
    url: projectWebhookUrlSchema,
    token: z.string().max(PROJECT_WEBHOOK_TOKEN_MAX_LENGTH).optional().catch(undefined),
    tasks: z.boolean().catch(false),
    triggers: storedTriggersSchema,
    agent: z.boolean().catch(false),
  })
  .passthrough();

/** Keep every entry that parses, at most `PROJECT_WEBHOOKS_MAX`, and the first of a repeated id. */
function salvageWebhooks(values: unknown[]): StoredProjectWebhook[] {
  const kept: StoredProjectWebhook[] = [];
  for (const value of values) {
    const parsed = storedWebhookSchema.safeParse(value);
    if (!parsed.success || kept.some((entry) => entry.id === parsed.data.id)) continue;
    kept.push(parsed.data);
    if (kept.length === PROJECT_WEBHOOKS_MAX) break;
  }
  return kept;
}

/**
 * One registry entry. `id` + `root` are load-bearing (an entry without them is
 * useless and gets dropped by the per-entry salvage below); the display fields
 * degrade per-key so one bad value never evicts the project.
 */
const workspaceProjectSchema = z
  .object({
    /** Unique slug — URL segment, sidebar key, worktree namespace. */
    id: z.string().regex(PROJECT_ID_RE),
    /** Absolute, realpath-normalized repo root (normalization is the writer's
     *  job — `registerProject` in step 1.3; the schema only demands absolute). */
    root: z.string().min(1).max(4096).refine((p) => p.startsWith('/'), 'root must be absolute'),
    /** Display name (basename by default). `''` = caller derives a fallback. */
    name: z.string().max(200).catch(''),
    addedAt: z.string().max(64).catch(''),
    lastOpenedAt: z.string().max(64).catch(''),
    source: z.enum(['local', 'checkout']).catch('local'),
    /** Per-project cap on concurrently running tasks. Absent = inherit the
     *  workspace `resources.maxParallel`. Bounded like the workspace cap; a bad
     *  value degrades to "inherit" (`.catch(undefined)`) rather than a hard
     *  default, and `.passthrough()` preserves the key across cezar round-trips. */
    maxParallel: z.number().int().min(1).max(16).optional().catch(undefined),
    /** Free-form labels grouping connected repositories (`storefront`, `infra`), used by the
     *  global Tasks page to filter and group across projects. Absent = untagged; the writers
     *  (`PATCH /api/projects/:id`, `cezar projects tag`) delete the key rather than storing `[]`,
     *  so an untagged project costs nothing in the file. Bounds mirror the PATCH schema exactly,
     *  so a value that route accepts can never be degraded away by the next load's `.catch`. */
    tags: z
      .array(z.string().trim().min(1).max(PROJECT_TAG_MAX_LENGTH))
      .max(PROJECT_TAGS_MAX)
      .optional()
      .catch(undefined),
    /** The task webhook (#589): where this project's opted-in runs POST their status changes,
     *  and the Bearer token they send. The token lives here, in the per-user 0600 registry, and
     *  never in the repo's own `.ai/cezar/config.json`, which some teams commit. It never leaves
     *  the server either: `redactProjectEntry` (projects.ts) swaps it for `tokenSet`. */
    webhook: legacyWebhookSchema.optional().catch(undefined),
    /** The project webhooks (hearsay-tools/cezarion#1576), in the order they were added. When
     *  present it replaces `webhook`, which a write through the webhook routes deletes; read both
     *  through `projectWebhooks` (workspace/webhooks.ts). One bad entry is dropped on its own. */
    webhooks: z
      .array(z.unknown())
      .transform((values) => salvageWebhooks(values))
      .optional()
      .catch(undefined),
  })
  .passthrough();

export type WorkspaceProject = z.infer<typeof workspaceProjectSchema>;
export type StoredProjectWebhook = z.infer<typeof storedWebhookSchema>;

function isWebhookTrigger(value: unknown): value is WebhookTrigger {
  return (WEBHOOK_TRIGGERS as readonly unknown[]).includes(value);
}

/**
 * Zero-config cadence, in minutes, for re-checking a monitoring run (#810): the
 * live-workers re-check and a `ScheduleWakeup` without a delay. The single
 * source of truth for that default — the schema below and `WorkspaceSemaphore`'s fallback both read it, so an install
 * with no `~/.cezar/config.json` and a semaphore built without boot wiring
 * agree. `null` (explicit park) is a user choice and is never replaced by it.
 */
export const DEFAULT_MONITORING_WAKE_MINUTES = 5;

const resourcesSchema = z
  .object({
    /** Workspace-wide parallel-task cap (moved from per-repo config.json). */
    maxParallel: z.number().int().min(1).max(16).default(2).catch(2),
    /** Extra durable monitoring sessions exempt from the active-task cap. */
    maxMonitoringSessions: z.number().int().min(0).max(16).default(2).catch(2),
    /**
     * Cadence for re-checking monitored work; `null` parks at zero model cost until a
     * user (or an external integration) resumes the session.
     *
     * Default-ON at 5 minutes (#810). It shipped as `null` and that made monitoring a
     * dead end: #661 removed the 15-minute idle timer that used to bound a parked
     * monitor, so with no wake timer a monitoring run had NO timer at all — and
     * cezar has no other resume path (no process-exit callback, no CI webhook, no
     * sub-agent-completion event). Tasks sat in `monitoring` for hours until a human
     * typed something. Same reasoning as `autoResumeOnUsageLimit` below: it spends
     * nothing while the downstream work is genuinely pending and it finishes the work
     * the user already asked for. `MAX_AUTO_CONTINUES` still caps a forgotten loop, and
     * an explicit `null` (Settings → Resources → "Park until resumed") is preserved.
     */
    monitoringWakeIntervalMinutes: z
      .number()
      .int()
      .min(1)
      .max(60)
      .nullable()
      .default(DEFAULT_MONITORING_WAKE_MINUTES)
      .catch(DEFAULT_MONITORING_WAKE_MINUTES),
    /**
     * Resume a task the provider's usage limit stopped, once that limit resets
     * (spec 2026-08-03-auto-resume-after-usage-limit). ON by default, which is the one
     * cost-bearing automation in this file that is: it spends nothing while it waits, and it
     * finishes the work the user already asked for rather than starting any of its own. Switching
     * it off leaves the run `failed` with its Continue button, exactly as before the feature.
     */
    autoResumeOnUsageLimit: z.boolean().default(true).catch(true),
    /** Per-task memory ceiling in MiB; null = no limit (matches the file's
     *  literal `"memoryLimitMb": null` in the spec's Data Model). */
    memoryLimitMb: z.number().int().min(0).max(1_048_576).nullable().default(null).catch(null),
    /** Default worktree retention for projects that don't override it. */
    worktreeRetentionDefault: z.number().int().min(0).max(1000).default(10).catch(10),
  })
  .passthrough();

const composerDefaultsSchema = z
  .object({
    autonomous: z.boolean().optional().catch(undefined),
    worktree: z.boolean().optional().catch(undefined),
  })
  .passthrough();

/**
 * What a repo that has said nothing runs (spec 2026-07-29-agent-profiles).
 *
 * The point is not to configure every checkout: a repo's own `.ai/cezar/config.json` still wins
 * key by key, and this is only consulted where that file is SILENT. Which is why every key here is
 * optional with no default — an absent `runner` has to stay distinguishable from one someone chose,
 * or "fall back to the machine default" collapses into "always claude".
 *
 * Personal and per-machine, like everything else in this file. The repo config is the team's; this
 * is yours.
 */
const agentDefaultsSchema = z
  .object({
    runner: z.enum(PROVIDER_IDS).optional().catch(undefined),
    models: z
      .object({
        claude: z.string().trim().min(1).max(200).optional().catch(undefined),
        codex: z.string().trim().min(1).max(200).optional().catch(undefined),
        opencode: z.string().trim().min(1).max(200).optional().catch(undefined),
        pi: z.string().trim().min(1).max(200).optional().catch(undefined),
        cursor: z.string().trim().min(1).max(200).optional().catch(undefined),
        omp: z.string().trim().min(1).max(200).optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

const workspacePathSchema = (read: () => string | undefined, fallback: string) => {
  const defaultValue = () => read()?.trim() || fallback;
  return z.string().min(1).max(4096).default(defaultValue).catch(defaultValue);
};

const providerIdSet = new Set<string>(PROVIDER_IDS);

const disabledProvidersSchema = z
  .array(z.unknown())
  .default(() => [])
  .catch(() => [])
  .transform((values): ProviderId[] => {
    const seen = new Set<ProviderId>();
    for (const value of values) {
      if (typeof value !== 'string' || !providerIdSet.has(value)) continue;
      seen.add(value as ProviderId);
    }
    return PROVIDER_IDS.filter((provider) => seen.has(provider));
  });

export const workspaceConfigSchema = z
  .object({
    /** Migration cursor (src/workspace/migrations.ts). Absent/bad → 0, which
     *  means "run every migration" — each one is idempotent, so that is safe. */
    schemaVersion: z.number().int().min(0).default(0).catch(0),
    /** Root exposed by the Add project folder browser. Environment supplies
     *  the zero-config default; an explicit workspace value wins thereafter. */
    browseRoot: workspacePathSchema(() => productEnv('BROWSE_ROOT'), '~/'),
    /** Checkout root for GUI-cloned projects. Stored as written (a literal
     *  `~` is expanded by the checkout flow, not here); validated writable
     *  when *changed*, never at load. */
    projectsDir: workspacePathSchema(() => productEnv('PROJECTS_DIR'), '~/cezar/projects'),
    archiveOnMerge: z.boolean().optional().catch(undefined),
    /** Global opt-in model policy. The native coding-agent model becomes
     * authoritative while runner choice remains available. */
    modelsLocked: z.boolean().optional().catch(undefined),
    // Function-form default/catch: mutators (step 1.3's registerProject) edit
    // these objects in place, so parses must never share one reference.
    resources: resourcesSchema.prefault(() => ({})).catch(() => resourcesSchema.parse({})),
    /** Optional New Task policy. Missing keys inherit exact 0/1 environment seeds. */
    composerDefaults: composerDefaultsSchema.default(() => ({})).catch(() => ({})),
    /** Host-wide provider preferences; absent means every provider is enabled. */
    disabledProviders: disabledProvidersSchema,
    /** Machine-wide agent/model defaults for repos that set none of their own. */
    agentDefaults: agentDefaultsSchema.default(() => ({})).catch(() => ({})),
    /** Per-entry salvage: a corrupt entry is dropped, the rest of the registry
     *  survives (a whole-array `.catch([])` would evict every project over one
     *  bad row). */
    projects: z
      .array(z.unknown())
      .default(() => [])
      .catch(() => [])
      .transform((entries) =>
        entries.flatMap((entry) => {
          const parsed = workspaceProjectSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
  })
  .passthrough();

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export function effectiveComposerDefault(
  stored: boolean | undefined,
  envValue: string | undefined,
  fallback: boolean,
): boolean {
  if (stored !== undefined) return stored;
  if (envValue === '0') return false;
  if (envValue === '1') return true;
  return fallback;
}

/** The in-memory default — what a missing/corrupt file behaves like. */
export function defaultWorkspaceConfig(): WorkspaceConfig {
  return workspaceConfigSchema.parse({});
}

/**
 * Last successful registry snapshot, including empty writes. Reads may restore a non-empty
 * snapshot in memory. Delete the whole cezar home for a complete reset; older writers may leave
 * the snapshot behind.
 */
export function workspaceConfigBackupPath(path: string): string {
  return `${path}.bak`;
}

function parseWorkspaceConfig(raw: string): WorkspaceConfig | null {
  try {
    const parsed = workspaceConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The snapshot is only worth restoring while it still holds projects — an
 *  empty one carries no information the defaults do not already have. */
function loadWorkspaceConfigBackup(path: string, recovery?: { base?: Buffer }, read = readHomeFile): WorkspaceConfig | null {
  let raw: string;
  try {
    raw = read(workspaceConfigBackupPath(path));
  } catch {
    return null;
  }
  const parsed = parseWorkspaceConfig(raw);
  if (recovery && parsed && parsed.projects.length > 0) recovery.base = Buffer.from(raw);
  return parsed && parsed.projects.length > 0 ? parsed : null;
}

/**
 * Load on demand without writing. Recover a missing, empty or corrupt primary from a non-empty
 * backup; preserve a valid empty primary. Failures degrade to defaults. Merge writers pass their
 * once-resolved path.
 */
export function loadWorkspaceConfigSync(path: string, recovery?: { base?: Buffer }, read = readHomeFile): WorkspaceConfig {
  let raw: string | null = null;
  try {
    raw = read(path);
  } catch {
    // missing/unreadable — the backup below is the next chance
  }
  if (raw !== null && raw.trim() !== '') {
    const parsed = parseWorkspaceConfig(raw);
    if (parsed) return parsed;
  }
  const restored = loadWorkspaceConfigBackup(path, recovery, read);
  if (restored) {
    const cause = raw === null ? 'is missing' : 'is empty or corrupt';
    console.warn(
      `${logPrefix()} workspace config ${path} ${cause} — restored ${restored.projects.length} project(s) from ${workspaceConfigBackupPath(path)}`,
    );
    return restored;
  }
  if (raw === null) return defaultWorkspaceConfig();
  console.warn(`${logPrefix()} workspace config ${path} is corrupt — using defaults (registry rebuilds)`);
  return defaultWorkspaceConfig();
}

/** Async public contract; the transaction uses the same parser without yielding. */
export async function loadWorkspaceConfig(path: string): Promise<WorkspaceConfig> {
  return loadWorkspaceConfigSync(path);
}

// Kept for callers that inspect staging names; the HomeStore writer owns replacement.
export { atomicTmpPath } from '../home/private-files.ts';

/** Compatibility name for registry writers. It cannot bypass the install marker or journal. */
export function atomicWriteJsonSync(path: string, value: unknown): void {
  new HomeStore(homeFileRoot(path)).writeJson(path, value);
}

/**
 * Re-read, mutate and atomically replace one once-resolved config path under write.lock. Return the written config; throw on write
 * failure so callers choose degradation.
 */
export async function mergeWriteWorkspaceConfig(
  mutator: (config: WorkspaceConfig) => WorkspaceConfig | void,
  home: Home,
): Promise<WorkspaceConfig> {
  return mergeWriteWorkspaceConfigSync(mutator, home);
}

/** The migration uses the same recovery writer without yielding while it owns write.lock. */
export function mergeWriteWorkspaceConfigSync(
  mutator: (config: WorkspaceConfig) => WorkspaceConfig | void,
  home: Home,
): WorkspaceConfig {
  const store = new HomeStore(home);
  const backup = workspaceConfigBackupPath(home.workspaceConfig);
  let snapshotReady = true;
  try { store.assertBoundary([backup]); } catch (error) {
    snapshotReady = false;
    warnSnapshot(backup, error);
  }
  return store.transaction(() => {
    const path = home.workspaceConfig;
    const recovery: { base?: Buffer } = {};
    const current = loadWorkspaceConfigSync(path, recovery);
    const next = mutator(current) ?? current;
    store.writeJson(path, next, recovery.base);
    // Refresh after empty writes too, so recovery cannot resurrect removed projects.
    if (snapshotReady) try { store.writeJson(backup, next); } catch (error) {
      warnSnapshot(backup, error); // The primary is already safely committed.
    }
    return next;
  }, [home.workspaceConfig]);
}

const warnedSnapshots = new Set<string>();
function warnSnapshot(path: string, error: unknown): void {
  if (warnedSnapshots.has(path)) return;
  warnedSnapshots.add(path);
  console.warn(`${logPrefix()} workspace backup ${path} unavailable (${error instanceof Error ? error.message : String(error)}); continuing the write`);
}
