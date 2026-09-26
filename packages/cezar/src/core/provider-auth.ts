import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AGENT_MODELS_LOCKED_ENV } from './agent-model-policy.ts';
import { profileEnv } from './agent-profiles.ts';
import { withEnvPrefix } from './shell-env.ts';

export const PROVIDER_IDS = ['claude', 'codex', 'opencode', 'pi', 'cursor'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ProviderConnectionState =
  | 'connected'
  | 'disconnected'
  | 'not-installed'
  | 'unknown';

export interface ProviderStatus {
  provider: ProviderId;
  status: ProviderConnectionState;
  enabled?: boolean;
  hint?: string;
  authFailureId?: string;
  /** Which agent account this row describes (spec 2026-07-29-agent-profiles). Absent on the rows
   *  `status()` builds — that route answers for the discovered default only, and stays exactly
   *  as wide as it has always been. Stamped in by `profileStatus()`. */
  profileId?: string;
}

export interface ProviderStatusResponse {
  providers: ProviderStatus[];
}

export interface ProviderCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
  timedOut?: boolean;
}

export type RunProviderCommand = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  /** Extra environment for the probe — how an agent profile's config dir reaches the CLI (spec
   *  2026-07-29-agent-profiles). Optional so every existing caller and the test kit keep their
   *  three-argument signature; absent means the default profile, which needs nothing. */
  env?: Record<string, string>,
) => Promise<ProviderCommandResult>;

/**
 * The explicit environment lock delegates model and credential configuration
 * to each native coding agent. In that mode Cezar must not second-guess the
 * agent's own credentials through the provider checks introduced by #652.
 *
 * Config-file model locks intentionally do not disable the checks: this bypass
 * is an operator-level process policy and only the exact documented `1` opts in.
 */
export function providerAuthChecksDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[AGENT_MODELS_LOCKED_ENV] === '1';
}

interface ProviderDescriptor {
  id: ProviderId;
  executable: () => string;
  statusArgs: readonly string[];
  loginArgs: readonly string[];
  installHint: string;
  parse: (result: ProviderCommandResult) => ProviderConnectionState | null;
}

const COMMAND_TIMEOUT_MS = 10_000;
/**
 * How long a probe result stands before it is re-checked — deliberately ASYMMETRIC.
 *
 * Which login an agent is signed into is operating knowledge: it matters for every run, and it
 * changes only when someone runs `claude auth login`. Re-probing it every few seconds cost a CLI
 * shell-out per provider and per account on every page load, for an answer that had almost
 * certainly not changed. So a CONNECTED answer is kept for minutes.
 *
 * A NOT-CONNECTED answer is re-checked sooner, for ONE reason: display self-healing. If you log in
 * from a terminal, cezar cannot see it happen, so a card that says "disconnected" must eventually
 * find out on its own. The window is a minute rather than seconds because reading is now
 * stale-while-revalidate (see `status`): every expiry costs a background probe, and a cockpit
 * polling this endpoint would turn a five-second window into a spawn every five seconds, forever,
 * on any machine where one provider is logged out — which is most of them.
 *
 * What this window is NOT is a correctness mechanism for starting runs. `provider-action-gate.ts`
 * refuses to start a run against a provider it believes disconnected, and it re-verifies before it
 * refuses (`providerActionError` in `server.ts`) rather than trusting an aging negative. That
 * inversion is what makes a long window safe here: the only reader that must not be wrong pays for
 * its own certainty, on the rare path where it is about to say no.
 *
 * A stale CONNECTED answer needs no window at all: the run starts, and a credential that really has
 * gone bad surfaces as a runtime auth failure, which is latched and overrides this cache on the spot
 * (`withRuntimeFailures`).
 *
 * Anything cezar CAN observe invalidates explicitly instead of waiting for either window: opening a
 * login (`POST /providers/connect`), repointing or removing an account (`forgetProfileStatus`), and
 * a runtime rejection.
 */
const CONNECTED_TTL_MS = 10 * 60_000;
const UNSETTLED_TTL_MS = 60_000;

/**
 * How long before the same provider may be self-checked again after a runtime rejection
 * (`verifyRuntimeAuthFailure`).
 *
 * A latch is raised from a PATTERN MATCH on a runner's error text, and a single failing run can emit
 * several auth-shaped lines in a row. Without a floor, each line that re-latches after a successful
 * self-check would buy its own CLI spawn. One self-check a minute is plenty for the case this exists
 * for — a rejection that was transient against credentials that are still valid — and it bounds the
 * pathological case (a CLI that reports logged in while the vendor keeps rejecting the token) to one
 * probe per minute instead of one per error line.
 */
const RUNTIME_AUTH_VERIFY_COOLDOWN_MS = 60_000;

/** The lifetime for a set of rows: minutes only when EVERY row is connected. A mixed answer takes
 *  the short window, because the not-connected row in it is the one that might self-heal.
 *
 *  KNOWN COARSENESS: the window applies to the whole three-provider response, so one logged-out
 *  provider drags the two connected ones into re-probing with it. That is wasted work rather than a
 *  wrong answer, and it is now paid in the background; fixing it properly means per-provider
 *  timestamps and merging partial probe results. */
function cacheTtlFor(rows: readonly ProviderStatus[]): number {
  return rows.every((row) => row.status === 'connected') ? CONNECTED_TTL_MS : UNSETTLED_TTL_MS;
}
const UNKNOWN_HINT = 'Authentication could not be verified. Try again.';
const TIMEOUT_HINT = 'Authentication check timed out. Try again.';
const RUNTIME_AUTH_HINT =
  'Authentication was rejected during a run. Reconnect, then try again.';
const ANSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const RUNTIME_AUTH_FAILURE_PATTERNS = [
  /\b(?:failed to authenticate|authentication failed|unauthenticated|unauthorized)\b/i,
  /\bproviderautherror\b/i,
  /\b(?:oauth|access|refresh)?\s*token\b.{0,80}\b(?:revoked|expired|invalid)\b/i,
  /\b(?:revoked|expired|invalid)\b.{0,80}\b(?:oauth|access|refresh)?\s*token\b/i,
  /\b(?:oauth|token|credential|unauthorized|unauthenticated)\b.{0,80}\b401\b/i,
  /\b401\b.{0,80}\b(?:oauth|token|credential|unauthorized|unauthenticated)\b/i,
] as const;
const RUNTIME_API_KEY_FAILURE_PATTERNS = [
  // Vendor-shaped errors can carry a process prefix before the actual
  // authentication error, so anchor on that explicit error label.
  /\b(?:api|authentication|auth)\s*error\b\s*[:=-]\s*(?:(?:http\s+)?401\b[\s:=-]*)?(?:(?:revoked|expired|invalid)\s+(?:api[-\s]?key|x-api-key)|(?:api[-\s]?key|x-api-key)\s*(?:(?:is|was|has been)\s+|[:=-]\s*)?(?:revoked|expired|invalid))\b/i,
  // Otherwise require the credential rejection to be the complete line,
  // optionally introduced by a generic error label or 401 status. This keeps
  // implementation notes such as "coverage for invalid API key handling"
  // from looking like live authentication failures.
  /(?:^|\r?\n)\s*(?:error\s*[:=-]\s*)?(?:(?:http\s+)?401\b[\s:=-]*)?(?:(?:revoked|expired|invalid)\s+(?:api[-\s]?key|x-api-key)|(?:api[-\s]?key|x-api-key)\s+(?:(?:is|was|has been)\s+)?(?:revoked|expired|invalid))\s*(?:[.!]|$)/im,
] as const;

export function isRuntimeProviderAuthFailure(message: string): boolean {
  return [...RUNTIME_AUTH_FAILURE_PATTERNS, ...RUNTIME_API_KEY_FAILURE_PATTERNS]
    .some((pattern) => pattern.test(message));
}

function normalizedOutput(stdout: string): string {
  return stdout.replace(ANSI_SEQUENCE, '').trim().toLowerCase();
}

function normalizedLines(...outputs: string[]): string[] {
  return outputs.flatMap((output) => normalizedOutput(output).split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseClaudeStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  try {
    const value = JSON.parse(result.stdout) as { loggedIn?: unknown };
    if (value.loggedIn === true && result.exitCode === 0) return 'connected';
    if (value.loggedIn === false && result.exitCode === 1) return 'disconnected';
    return null;
  } catch {
    return null;
  }
}

function parseCodexStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  const answers = normalizedLines(result.stdout, result.stderr)
    .map((line): ProviderConnectionState | null => {
      if (
        line === 'logged in using chatgpt'
        || line === 'logged in using an api key'
        || line === 'logged in using agent identity'
        || line === 'logged in using access token'
        || line === 'logged in using personal access token'
        || line === 'logged in using amazon bedrock api key'
        || /^logged in using an api key - (?:\*{3}|\S{8}\*{3}\S{5})$/.test(line)
      ) {
        return 'connected';
      }
      if (line === 'not logged in' || line === 'run codex login to authenticate') {
        return 'disconnected';
      }
      return null;
    })
    .filter((answer): answer is ProviderConnectionState => answer !== null);
  if (answers.length !== 1) return null;
  if (answers[0] === 'connected' && result.exitCode === 0) return 'connected';
  if (answers[0] === 'disconnected' && result.exitCode === 1) return 'disconnected';
  return null;
}

function parseOpenCodeStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  if (result.exitCode !== 0) return null;
  const lines = normalizedLines(result.stdout);
  const storedSummaries = lines
    .map((line) => line.match(/^[^a-z0-9]*(\d+)\s+credentials?$/)?.[1])
    .filter((count): count is string => count !== undefined);
  if (storedSummaries.length !== 1) return null;
  const storedCount = Number(storedSummaries[0]);
  if (!Number.isSafeInteger(storedCount)) return null;

  const environmentSummaries = lines
    .map((line) => line.match(/^[^a-z0-9]*(\d+)\s+environment\s+variables?$/)?.[1])
    .filter((count): count is string => count !== undefined);
  const hasEnvironmentBlock = lines.some((line) => /^[^a-z0-9]*environment$/.test(line));
  if (environmentSummaries.length > 1) return null;
  if (hasEnvironmentBlock !== (environmentSummaries.length === 1)) return null;
  const environmentCount = environmentSummaries.length === 1
    ? Number(environmentSummaries[0])
    : 0;
  if (!Number.isSafeInteger(environmentCount)) return null;

  return storedCount > 0 || environmentCount > 0 ? 'connected' : 'disconnected';
}

function parsePiStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  if (result.exitCode !== 0) return null;
  const lines = normalizedLines(result.stdout);
  if (lines.some((line) => /^provider\s+model\s+context\s+max-out\s+thinking\s+images$/.test(line))) {
    return 'connected';
  }
  if (
    lines.some((line) => line.includes('no models available'))
    && lines.some((line) => line.includes('/login'))
  ) {
    return 'disconnected';
  }
  return null;
}

// Verified against Cursor CLI 2026.09.15 status --format json implementation.
function parseCursorStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  try {
    const value = JSON.parse(result.stdout) as { isAuthenticated?: unknown; status?: unknown };
    // `agent status` checks stored login tokens only (CLI 2026.09.15), while ACP
    // also accepts environment credentials. Like OpenCode's environment count,
    // configured credentials permit a run; a vendor rejection is latched at runtime.
    if (result.exitCode === 0 && (process.env.CURSOR_API_KEY?.trim() || process.env.CURSOR_AUTH_TOKEN?.trim())) {
      return 'connected';
    }
    if (value.isAuthenticated === true && result.exitCode === 0) return 'connected';
    if (value.isAuthenticated === false && result.exitCode === 0
      && (value.status === 'unauthenticated' || value.status === 'partially-authenticated')) return 'disconnected';
    return null;
  } catch {
    return null;
  }
}

const DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    id: 'claude',
    executable: () => process.env.CEZ_CLAUDE_BIN ?? 'claude',
    statusArgs: ['auth', 'status', '--json'],
    loginArgs: ['auth', 'login'],
    installHint: 'Install Claude Code, then run `claude auth login`.',
    parse: parseClaudeStatus,
  },
  {
    id: 'codex',
    executable: () => process.env.CEZ_CODEX_BIN ?? 'codex',
    statusArgs: ['login', 'status'],
    loginArgs: ['login'],
    installHint: 'Install the Codex CLI, then run `codex login`.',
    parse: parseCodexStatus,
  },
  {
    id: 'opencode',
    executable: () => process.env.CEZ_OPENCODE_BIN ?? 'opencode',
    statusArgs: ['auth', 'list'],
    loginArgs: ['auth', 'login'],
    installHint: 'Install OpenCode, then run `opencode auth login`.',
    parse: parseOpenCodeStatus,
  },
  {
    id: 'pi',
    executable: () => process.env.CEZ_PI_BIN ?? 'pi',
    statusArgs: ['--list-models'],
    loginArgs: ['/login'],
    installHint: 'Install pi, then run `pi /login`.',
    parse: parsePiStatus,
  },
  {
    id: 'cursor',
    executable: () => process.env.CEZ_CURSOR_BIN ?? 'agent',
    statusArgs: ['status', '--format', 'json'],
    loginArgs: ['login'],
    installHint: 'Install Cursor CLI, then run `agent login`.',
    parse: parseCursorStatus,
  },
];

function defaultRunProviderCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<ProviderCommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 256 * 1024,
        // Inherit, then override: an auth probe is a short read-only CLI call, not a spawned
        // agent, so it does not go through `buildChildEnv`'s allowlist — the CLI still needs the
        // host's PATH and HOME to run at all. `env` is only ever a profile's config-dir variable.
        ...(env && Object.keys(env).length > 0 ? { env: { ...process.env, ...env } } : {}),
      },
      (error, stdout, stderr) => {
        const commandError = error as (NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: string | null;
        }) | null;
        const code = commandError?.code;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: typeof code === 'number' ? code : error ? null : 0,
          errorCode: typeof code === 'string' ? code : undefined,
          timedOut: commandError?.code === 'ETIMEDOUT'
            || (commandError?.killed === true && commandError.signal === 'SIGTERM'),
        });
      },
    );
  });
}

function quoteExecutable(executable: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `"${executable.replace(/[%&!"]/g, '^$&')}"`;
  }
  return `'${executable.replaceAll("'", "'\\''")}'`;
}

/** The per-account cache key. ONE definition: a probe that wrote under a different spelling than
 *  a peek reads would silently make every peek a miss, and every page load pay for a CLI spawn. */
function profileCacheKey(provider: ProviderId, profileId: string): string {
  return `${provider}\u0000${profileId}`;
}

function descriptorFor(provider: ProviderId): ProviderDescriptor {
  const descriptor = DESCRIPTORS.find(({ id }) => id === provider);
  if (!descriptor) throw new Error(`Unknown provider: ${provider}`);
  return descriptor;
}

interface RuntimeAuthFailure {
  generation: number;
  authFailureId: string;
}

/** One authoritative runtime authentication incident. The identifier is opaque
 * and stable until the user explicitly acknowledges that exact incident. */
export interface RuntimeAuthFailureReport {
  status: ProviderStatus & {
    status: 'disconnected';
    authFailureId: string;
  };
  /** The incident's generation at report time. A self-check that starts asynchronously (the
   *  runtime watcher resolves the failing account first) carries it through so the check can
   *  stand down when a newer failure replaced the incident it was triggered by. */
  generation: number;
  /** True only for the global latch edge, so callers can fan out one coarse
   * status update while every affected task still records its own callout. */
  transitioned: boolean;
}

/** One deferred re-verification when the cooldown declines a check. Detached and unref'd by
 *  default; tests capture the retry instead of waiting out the window. */
function defaultScheduleRuntimeRetry(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export class ProviderAuthService {
  private readonly runCommand: RunProviderCommand;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly createAuthFailureId: () => string;
  private readonly scheduleRuntimeRetry: (fn: () => void, delayMs: number) => () => void;
  private readonly runtimeFailures = new Map<ProviderId, RuntimeAuthFailure>();
  /** One self-check at a time per provider, and not more often than the cooldown. Both guard the
   *  same thing — a CLI spawn per auth-shaped error line — from the two directions it can arrive
   *  from: concurrently, and in quick succession. */
  private readonly verifyingRuntimeFailures = new Set<ProviderId>();
  private readonly lastRuntimeVerification = new Map<ProviderId, number>();
  /** One pending cooldown-expiry re-check per provider, cancellable. See
   *  {@link ProviderAuthService.scheduleRuntimeVerification}. */
  private readonly deferredRuntimeVerifications = new Map<ProviderId, () => void>();
  private nextRuntimeFailureGeneration = 0;
  private nextProbeGeneration = 0;
  private completed?: {
    response: ProviderStatusResponse;
    timestamp: number;
    generation: number;
  };
  private inFlight?: {
    raw: Promise<ProviderStatusResponse>;
    visible: Promise<ProviderStatusResponse>;
  };
  /** Per-account probe results, keyed by `profileCacheKey` (spec 2026-07-29-agent-profiles).
   *  Separate from `completed` because a second Claude login is a different answer to the same
   *  question, and sharing one slot would let whichever probe ran last speak for both. Each
   *  entry carries the generation of the probe that wrote it, so an older probe landing after a
   *  newer verification cannot overwrite the correction — the fence `completed` gets from
   *  `startFreshProbe`/`rememberProbedRow`, on this cache's own key. */
  private readonly completedProfiles = new Map<string, { status: ProviderStatus; timestamp: number; generation: number }>();
  private readonly inFlightProfiles = new Map<string, Promise<ProviderStatus>>();

  constructor(options?: {
    runCommand?: RunProviderCommand;
    now?: () => number;
    platform?: NodeJS.Platform;
    createAuthFailureId?: () => string;
    scheduleRuntimeRetry?: (fn: () => void, delayMs: number) => () => void;
  }) {
    this.runCommand = options?.runCommand ?? defaultRunProviderCommand;
    this.now = options?.now ?? Date.now;
    this.platform = options?.platform ?? process.platform;
    this.createAuthFailureId = options?.createAuthFailureId ?? randomUUID;
    this.scheduleRuntimeRetry = options?.scheduleRuntimeRetry ?? defaultScheduleRuntimeRetry;
  }

  /**
   * Every provider's authentication state — STALE-WHILE-REVALIDATE, the same policy the health
   * snapshot uses.
   *
   * Once anything is known, a reader gets it immediately and an expired cache is refreshed BEHIND
   * the answer instead of in front of it. Awaiting the refresh is what made `GET
   * /providers/status` cost ~0.8s here (and ~3s on a slower box) every time the window lapsed:
   * the endpoint is read by the cockpit on a poll, so "occasionally slow" means "slow in the UI,
   * unpredictably". Only a genuinely cold cache waits, and after the boot warm there isn't one.
   *
   * `refresh: true` still blocks — it is what "Check again", `POST /providers/connect` and the
   * action gate's verify-before-refuse use, and they are asking precisely because they need an
   * answer that is true NOW.
   */
  status(options?: { refresh?: boolean }): Promise<ProviderStatusResponse> {
    if (process.env.CEZ_DRY_RUN === '1' || providerAuthChecksDisabled()) {
      return Promise.resolve({
        providers: PROVIDER_IDS.map((provider) => ({ provider, status: 'connected' })),
      });
    }

    if (options?.refresh) {
      // Joining a probe already running satisfies "true now" and preserves the in-flight identity
      // contract (one shared promise for concurrent callers).
      return this.inFlight ? this.inFlight.visible : this.startFreshProbe().visible;
    }
    if (this.completed) {
      // Checked BEFORE `inFlight` on purpose: a reader arriving during a background revalidation
      // must be served from cache, not attached to the probe it was meant to avoid.
      if (this.now() - this.completed.timestamp >= cacheTtlFor(this.completed.response.providers)) {
        if (!this.inFlight) void this.startFreshProbe().raw.catch(() => {});
      }
      return Promise.resolve(this.withRuntimeFailures(this.completed.response));
    }
    if (this.inFlight) return this.inFlight.visible;
    return this.startFreshProbe().visible;
  }

  reportRuntimeAuthFailure(provider: ProviderId): RuntimeAuthFailureReport | null {
    if (process.env.CEZ_DRY_RUN === '1' || providerAuthChecksDisabled()) return null;
    const current = this.runtimeFailures.get(provider);
    const failure: RuntimeAuthFailure = {
      generation: ++this.nextRuntimeFailureGeneration,
      authFailureId: current?.authFailureId ?? this.createAuthFailureId(),
    };
    this.runtimeFailures.set(provider, failure);
    return {
      status: {
        provider,
        status: 'disconnected',
        hint: RUNTIME_AUTH_HINT,
        authFailureId: failure.authFailureId,
      },
      generation: failure.generation,
      transitioned: current === undefined,
    };
  }

  /** Clear only the incident the caller actually observed. A stale retry must
   * never erase a rejection that arrived after the user began recovery. */
  clearRuntimeAuthFailure(provider: ProviderId, authFailureId: string): boolean {
    const current = this.runtimeFailures.get(provider);
    if (!current || current.authFailureId !== authFailureId) return false;
    this.runtimeFailures.delete(provider);
    return true;
  }

  /**
   * Ask the provider's OWN CLI whether a runtime rejection was real, and drop the incident when it
   * was not. Resolves to the recovered row when it cleared one, `null` otherwise.
   *
   * `profile` aims the self-check at the account the failing step actually ran under (spec
   * 2026-07-29-agent-profiles). Probing the bare default instead would answer a question nobody
   * asked: a named account can be rejected while the default login is fine, and clearing the latch
   * on the default's answer lets every future run on the broken account fail again. A named
   * verification writes the per-account cache and stamps its row `profileId`; the default
   * verification keeps folding into the whole-response cache exactly as before. The CALLER decides
   * what to do when the recorded account cannot be resolved — for the runtime watcher that is
   * "keep the latch" (an unverifiable incident is not a recovered one).
   *
   * A latch is raised by matching a runner's error text against
   * {@link isRuntimeProviderAuthFailure} — a heuristic over vendor prose — and it then outranks every
   * probe (`withRuntimeFailures`). Before this existed, `clearRuntimeAuthFailure` had exactly one
   * caller, `POST /providers/:provider/retry`, so the only way out of a latch was a human opening
   * Settings and pressing "Try again". That button clears the incident and re-probes, and it works,
   * which is the whole diagnosis: the credentials were still there. A transient 401 and a false
   * positive of the text match were both indistinguishable from a real logout, and both parked the
   * cockpit until someone clicked.
   *
   * So the latch stays authoritative — it is raised instantly, and `provider-action-gate` keeps
   * refusing to start runs against it — but it no longer stands unexamined. This is deliberately the
   * same two steps the retry route performs, minus the human: probe, then clear.
   *
   * What it will NOT do:
   * - clear an incident it did not observe. The id is captured before the probe and handed to
   *   `clearRuntimeAuthFailure`, so a rejection that arrives mid-probe survives the answer to an
   *   older question.
   * - clear on anything but `connected`. `disconnected`, `not-installed` and `unknown` all leave the
   *   latch alone; an inconclusive probe is not evidence of health.
    * - spawn more than one probe per provider per {@link RUNTIME_AUTH_VERIFY_COOLDOWN_MS}. A
    *   verification skipped by that cooldown returns `null`, leaves the latch standing, and arms ONE
    *   deferred re-verification at cooldown expiry
    *   ({@link ProviderAuthService.scheduleRuntimeVerification}) — the runtime watcher fires only on
    *   the latch edge, so without it a re-latch inside the window could never be re-checked.
    *
    * `observed` names the incident generation the CALLER saw when it decided to check. The runtime
    *   watcher resolves the failing account asynchronously before calling this, and a newer failure
    *   can replace the incident during that wait — a check for the older question then stands down
    *   at the door (no probe) instead of answering the newer one with the older aim.
    */
  async verifyRuntimeAuthFailure(
    provider: ProviderId,
    profile?: { id: string; configDir: string | null },
    observed?: { generation: number },
  ): Promise<ProviderStatus | null> {
    if (process.env.CEZ_DRY_RUN === '1' || providerAuthChecksDisabled()) return null;
    const failure = this.runtimeFailures.get(provider);
    if (!failure) return null;
    const expectedGeneration = observed?.generation ?? failure.generation;
    if (failure.generation !== expectedGeneration) return null;
    if (this.verifyingRuntimeFailures.has(provider)) return null;
    const lastVerifiedAt = this.lastRuntimeVerification.get(provider);
    if (lastVerifiedAt !== undefined && this.now() - lastVerifiedAt < RUNTIME_AUTH_VERIFY_COOLDOWN_MS) {
      this.scheduleRuntimeVerification(
        provider,
        profile,
        RUNTIME_AUTH_VERIFY_COOLDOWN_MS - (this.now() - lastVerifiedAt),
        expectedGeneration,
      );
      return null;
    }

    this.verifyingRuntimeFailures.add(provider);
    let probed: ProviderStatus;
    try {
      this.lastRuntimeVerification.set(provider, this.now());
      probed = await this.probe(descriptorFor(provider), profile?.configDir);
    } finally {
      this.verifyingRuntimeFailures.delete(provider);
    }

    if (probed.status !== 'connected') return null;
    // Fence the clear against the captured GENERATION, not just the id: while the latch stands a
    // new failure report keeps the same `authFailureId`, so an id comparison alone would let this
    // answer — gathered for the incident as it was — clear a newer failure reported mid-probe,
    // one the latch-edge watcher will never re-check. Generations are unique per report.
    const current = this.runtimeFailures.get(provider);
    if (!current || current.generation !== expectedGeneration) return null;
    if (!this.clearRuntimeAuthFailure(provider, failure.authFailureId)) return null;
    if (profile) {
      // Per-account knowledge goes to the per-account cache. Folding it into the whole-response
      // cache would let a named account's answer speak for the default row for the TTL that
      // follows — the same sharing bug the `(provider, profileId)` key was introduced to prevent.
      // The FRESH generation fences the write against an older per-account probe that is still in
      // flight and lands afterwards.
      const stamped: ProviderStatus = { ...probed, profileId: profile.id };
      this.completedProfiles.set(profileCacheKey(provider, profile.id), {
        status: stamped,
        timestamp: this.now(),
        generation: ++this.nextProbeGeneration,
      });
      return stamped;
    }
    this.rememberProbedRow(probed);
    return probed;
  }

  /**
   * A verification declined by the cooldown must not become a dead end. The runtime watcher fires
   * only on the latch edge — a rejection that re-latches right after a successful check gets its
   * check declined here, and nothing would ever re-ask the CLI: later error lines see a latch that
   * already stands, and only Settings' Try again could clear it. So the declined request arms ONE
   * deferred re-verification at cooldown expiry; later declined requests re-arm it (never stack
   * it), the newest aim and generation winning. The retry is bound to the incident it was
   * scheduled against: a newer failure that arrived meanwhile (a non-transition line the watcher
   * skips) stands when it fires, because the queued aim may no longer be the account that failed
   * and its answer must not clear what it was never asked about. Firing after the latch is gone
   * is equally a no-op — {@link ProviderAuthService.verifyRuntimeAuthFailure} returns before
   * probing — so the chain ends the moment the incident is answered.
   */
  private scheduleRuntimeVerification(
    provider: ProviderId,
    profile: { id: string; configDir: string | null } | undefined,
    delayMs: number,
    generation: number,
  ): void {
    this.deferredRuntimeVerifications.get(provider)?.();
    const cancel = this.scheduleRuntimeRetry(() => {
      this.deferredRuntimeVerifications.delete(provider);
      void this.verifyRuntimeAuthFailure(provider, profile, { generation }).catch(() => {});
    }, Math.max(delayMs, 0));
    this.deferredRuntimeVerifications.set(provider, cancel);
  }

  /**
   * Fold ONE freshly probed row into the cached response.
   *
   * Without this, dropping a latch would uncover whatever the last full probe happened to say about
   * that provider — which can be older than the answer we just got, and on a cold-ish cache can be
   * `unknown`. Clearing an incident only to reveal a stale contradiction would trade a red banner for
   * a grey one. The cache TIMESTAMP is deliberately untouched: this corrects one row, it is not a
   * full probe, and it must not extend the whole response's lifetime.
   *
   * The row also carries a FRESH generation, and a generation alone is not enough when the cache is
   * cold: a full probe already in flight would land afterwards and, being a complete response, would
   * replace the correction with rows gathered before the recovery was known (or discard it outright
   * when `completed` is still unset). So when nothing is cached yet, the merge waits for the
   * in-flight probe to land and folds over ITS answer — still generation-stamped, so a probe that
   * started even later wins on its own merits.
   */
  private rememberProbedRow(status: ProviderStatus): void {
    const generation = ++this.nextProbeGeneration;
    if (this.completed) {
      this.mergeProbedRow(status, generation);
      return;
    }
    const inFlight = this.inFlight;
    if (!inFlight) return;
    void inFlight.raw.catch(() => {}).then(() => {
      // A newer full probe landing first (its generation outranks ours) makes this a no-op: its
      // rows are the fresher answer and must not be patched by an older correction.
      if (!this.completed || this.completed.generation >= generation) return;
      this.mergeProbedRow(status, generation);
    });
  }

  private mergeProbedRow(status: ProviderStatus, generation: number): void {
    if (!this.completed) return;
    this.completed = {
      ...this.completed,
      generation,
      response: {
        providers: this.completed.response.providers.map((row) => (
          row.provider === status.provider ? status : row
        )),
      },
    };
  }

  /**
   * The command that logs `provider` in, as a copyable one-liner.
   *
   * `configDir` points the login at a specific agent account (spec 2026-07-29-agent-profiles) —
   * without it, "Connect" on a second Claude account would sign the user into the FIRST one and
   * report success. Returns `null` when the dir cannot be embedded safely on this platform, and
   * the caller must then refuse rather than fall back to the bare command: a login aimed at the
   * wrong account is the failure this whole path exists to prevent.
   */
  loginCommand(provider: ProviderId, configDir?: string | null): string | null {
    const descriptor = descriptorFor(provider);
    const command = [quoteExecutable(descriptor.executable(), this.platform), ...descriptor.loginArgs].join(' ');
    const env = configDir ? profileEnv(provider, configDir) : {};
    return withEnvPrefix(command, env, this.platform);
  }

  installHint(provider: ProviderId): string {
    return descriptorFor(provider).installHint;
  }

  private withRuntimeFailures(response: ProviderStatusResponse): ProviderStatusResponse {
    if (this.runtimeFailures.size === 0) return response;
    return {
      providers: response.providers.map((row) => {
        const failure = this.runtimeFailures.get(row.provider);
        return failure
          ? {
            provider: row.provider,
            status: 'disconnected',
            hint: RUNTIME_AUTH_HINT,
            authFailureId: failure.authFailureId,
          }
          : row;
      }),
    };
  }

  private startFreshProbe(): {
    raw: Promise<ProviderStatusResponse>;
    visible: Promise<ProviderStatusResponse>;
  } {
    const generation = ++this.nextProbeGeneration;
    const raw = Promise.all(DESCRIPTORS.map((descriptor) => this.probe(descriptor)))
      .then((providers) => {
        const response = { providers };
        if (!this.completed || generation >= this.completed.generation) {
          this.completed = { response, timestamp: this.now(), generation };
        }
        return response;
      });
    // One derived visible promise per raw probe preserves the historical
    // in-flight identity contract while still consulting the current latch
    // only after the async vendor commands resolve.
    const probe = {
      raw,
      visible: raw.then((response) => this.withRuntimeFailures(response)),
    };
    this.inFlight = probe;
    void raw.finally(() => {
      if (this.inFlight === probe) this.inFlight = undefined;
    });
    return probe;
  }

  /**
   * One NON-default agent account's authentication state (spec 2026-07-29-agent-profiles).
   *
   * Deliberately a separate entry point from `status()`, which keeps answering exactly one row
   * per provider — the discovered default — so `GET /api/v1/providers/status` is byte-identical
   * for anyone with no extra accounts. Per-account rows are carried by the agent-profiles route.
   *
   * Cached on the same asymmetric lifetime as `status()` (`cacheTtlFor`: minutes for a connected
   * answer, a minute for anything else), keyed by `(provider, profileId)` so two Claude accounts never read
   * each other's answer. The runtime-auth latch is deliberately NOT applied: it is a coarse
   * per-provider signal and stamping it onto every account of that provider would mark an
   * untouched account as broken.
   */
  async profileStatus(
    provider: ProviderId,
    profile: { id: string; configDir: string | null },
  ): Promise<ProviderStatus> {
    if (process.env.CEZ_DRY_RUN === '1') {
      return { provider, status: 'connected', profileId: profile.id };
    }
    const key = profileCacheKey(provider, profile.id);
    const cached = this.completedProfiles.get(key);
    if (cached && this.now() - cached.timestamp < cacheTtlFor([cached.status])) return cached.status;
    const pending = this.inFlightProfiles.get(key);
    if (pending) return pending;
    const generation = ++this.nextProbeGeneration;
    const probe = this.probe(descriptorFor(provider), profile.configDir)
      .then((status) => {
        const stamped: ProviderStatus = { ...status, profileId: profile.id };
        const current = this.completedProfiles.get(key);
        // A verification (or newer probe) that wrote while this probe was in flight keeps its
        // place: an older answer must not overwrite a fresher row, the same fence the default
        // cache's generation guard provides. The caller still gets this probe's own answer.
        if (current === undefined || generation >= current.generation) {
          this.completedProfiles.set(key, { status: stamped, timestamp: this.now(), generation });
        }
        return stamped;
      })
      .finally(() => {
        if (this.inFlightProfiles.get(key) === probe) this.inFlightProfiles.delete(key);
      });
    this.inFlightProfiles.set(key, probe);
    return probe;
  }

  /**
   * Drop a cached per-account answer — used when an account's dir changes under us.
   *
   * TARGETED by default, because this cache is warmed at boot and is meant to survive: clearing
   * every account because ONE was repointed would throw away knowledge that is still true and make
   * the other accounts re-probe. Called with no argument it clears everything, which is what a
   * shutdown or a whole-store reload wants.
   */
  forgetProfileStatus(provider?: ProviderId, profileId?: string): void {
    if (provider === undefined || profileId === undefined) {
      this.completedProfiles.clear();
      return;
    }
    this.completedProfiles.delete(profileCacheKey(provider, profileId));
  }

  /**
   * The cached answer for one account, or `undefined` when nothing is known yet — WITHOUT
   * spawning anything.
   *
   * Every probe shells out to an agent CLI, which costs hundreds of milliseconds per provider and
   * per account. A route whose real job is "what exists" must not pay that: `GET /api/v1/health`
   * already established this posture (it serves whatever the cache holds and never pays a `gh`
   * shell-out), and this is the same rule for auth.
   *
   * The peeks deliberately ignore the TTLs below — they answer with the last thing known, however
   * old. The short window exists to stop a stale NEGATIVE from blocking a run, and a peek blocks
   * nothing: it fills in a dot on a settings page that offers Connect and a re-check right beside
   * it. Applying the window here instead made the whole cache expire in five seconds on any machine
   * where a single provider is logged out — which is most of them, since few people are signed into
   * all three — and put the shell-out straight back on the page load this exists to protect.
   * Callers that need a guaranteed-fresh answer call {@link status} or pass `refresh`.
   */
  peekProfileStatus(provider: ProviderId, profileId: string): ProviderStatus | undefined {
    if (process.env.CEZ_DRY_RUN === '1') {
      return { provider, status: 'connected', profileId };
    }
    return this.completedProfiles.get(profileCacheKey(provider, profileId))?.status;
  }

  /** The cached default-profile rows, or `undefined` when the probe has never completed. Same
   *  no-spawn contract as {@link peekProfileStatus}. */
  peekStatus(): ProviderStatusResponse | undefined {
    if (process.env.CEZ_DRY_RUN === '1') {
      return { providers: PROVIDER_IDS.map((provider) => ({ provider, status: 'connected' })) };
    }
    if (!this.completed) return undefined;
    return this.withRuntimeFailures(this.completed.response);
  }

  private async probe(descriptor: ProviderDescriptor, configDir?: string | null): Promise<ProviderStatus> {
    let result: ProviderCommandResult;
    // The default profile is probed with the SAME three-argument call it always was — no
    // trailing `undefined`. `runCommand` is an injected seam, and handing every existing
    // implementation an extra argument it never asked for would be a change in the zero-config
    // path for no gain.
    const env = configDir ? profileEnv(descriptor.id, configDir) : undefined;
    try {
      result = await (env === undefined
        ? this.runCommand(descriptor.executable(), descriptor.statusArgs, COMMAND_TIMEOUT_MS)
        : this.runCommand(descriptor.executable(), descriptor.statusArgs, COMMAND_TIMEOUT_MS, env));
    } catch {
      return { provider: descriptor.id, status: 'unknown', hint: UNKNOWN_HINT };
    }
    if (result.errorCode === 'ENOENT') {
      return { provider: descriptor.id, status: 'not-installed', hint: descriptor.installHint };
    }
    if (result.timedOut) {
      return { provider: descriptor.id, status: 'unknown', hint: TIMEOUT_HINT };
    }
    if (result.errorCode) {
      return { provider: descriptor.id, status: 'unknown', hint: UNKNOWN_HINT };
    }
    const status = descriptor.parse(result);
    if (status !== null) return { provider: descriptor.id, status };
    return { provider: descriptor.id, status: 'unknown', hint: UNKNOWN_HINT };
  }
}
