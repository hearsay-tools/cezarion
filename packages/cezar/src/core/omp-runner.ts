import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEffort } from '@open-mercato/cezar-contract/effort';
import { isRecord, parseRpcLine, piMessageText, ompRpcError as rpcError, string, toPiPrompt, truncate, waitForExit } from './pi-rpc-wire.ts';
import { armEndWatchdog, emitPiToolResult, type PiEndWatchdog, PiRpcInput, PiTextBlocks, recordPiToolCall } from './pi-rpc-turn.ts';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunSpecSupport,
  InputDelivery,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
  ToolGrant,
} from './agent-runner.js';
import { isSignalTerminationExit } from './agent-runner.js';
import { ompRequestedTools } from './runner-tool-grants.ts';
import { signalSession, spawnSessionLeader } from './session-process.js';
import { buildChildEnv } from './agent-env.js';
import type { UiEvent } from './ui-events.js';
import { cezarToolNames } from '../ci-wait/tools.js';
import { readNdjson } from './ndjson.js';
import {
  createOmpUiState,
  mapOmpRpcMessage,
  ompFlushProviderError,
  ompMessageUsage,
  ompProviderErrorMessage,
  ompTurnStarted,
} from './omp-ui-mapper.js';
import { summarizeRunnerStderr } from './runner-stderr.ts';
import { boundOutputDrainAfterExit, DEFAULT_RUN_TIMEOUT_MS, KILL_GRACE_MS } from './runner-runtime.js';

/**
 * OMP's built-in tool names at the pinned version (`src/tools/builtin-names.ts`, oh-my-pi
 * v18.4.11; the real binary lists the same 30 in its `--tools` rejection). `--tools` is an
 * allowlist validated against the registry, and an unknown name exits 2 before any frame, so
 * only these, cezar's mapped names and `mcp__*` ever reach it.
 */
export const OMP_BUILTIN_TOOL_NAMES: readonly string[] = [
  'read', 'bash', 'edit', 'ast_grep', 'ast_edit', 'ask', 'debug', 'ida', 'eval', 'github',
  'glob', 'grep', 'find', 'lsp', 'checkpoint', 'rewind', 'context_notes', 'new_context',
  'security_scan', 'task', 'wait', 'todo', 'web_search', 'write', 'memory_edit', 'retain',
  'recall', 'reflect', 'learn', 'manage_skill',
];

/**
 * The tools OMP v18.4.11 enables with no `--tools` and no user config (recorded from the real
 * binary's `get_state.dumpTools`). Only read under governed delegation, which must name a list
 * to leave `task`, `wait` and `eval` out of it.
 */
const OMP_DEFAULT_TOOL_NAMES: readonly string[] = [
  'read', 'bash', 'edit', 'eval', 'glob', 'grep', 'task', 'wait', 'todo', 'web_search', 'write',
];

/** cezar tool names with an OMP equivalent; OMP built-ins and `mcp__*` pass through as-is. */
const OMP_TOOL_MAP: Readonly<Record<string, string>> = {
  Read: 'read',
  Edit: 'edit',
  Write: 'write',
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  Subagent: 'task',
  Task: 'task',
  TodoWrite: 'todo',
  WebSearch: 'web_search',
  // No `WebFetch`: OMP v18.4.11 has no `fetch` built-in, and its `read` also reads local files,
  // so mapping a web-only grant onto it would widen the grant. It is dropped (fail closed).
};

/**
 * D1: tools that let the agent spawn agents outside cezar's governance. `wait` only joins `task`
 * work; `eval` has `agent()`/`workpool()` helpers and no v18.4.11 setting turns them off (Ruling 6).
 */
const OMP_DELEGATION_TOOLS: ReadonlySet<string> = new Set(['task', 'wait', 'eval']);

/**
 * What the omp CLI receives from each `AgentRunSpec` field (#284, spec § Spawn and spec
 * support). Held against the mock's recorded argv and RPC by the harness parity matrix.
 */
export const OMP_SPEC_SUPPORT: AgentRunSpecSupport = {
  cezarTools: { honored: true, via: 'explicit CI --extension; the cezar tools admitted when --tools is set' },
  systemPrompt: { honored: true, via: '--append-system-prompt' },
  userPrompt: { honored: true, via: 'RPC prompt.message' },
  images: { honored: true, via: "RPC prompt.images ({type:'image', data, mimeType})" },
  cwd: { honored: true, via: 'spawn cwd' },
  toolGrant: { honored: true, via: "--tools, mapped onto OMP names; unmapped names dropped (fail closed); a bashAllowlist has no prefix equivalent, so bash is dropped from --tools (Pi's rule), and an unset grant names OMP's default set first so bash can be left out" },
  restrictNativeDelegation: {
    honored: true,
    via: '--config overlay denying task, and task/wait left out of --tools (D1); eval is left out too, since OMP v18.4.11 has no setting that disables its agent()/workpool() helpers; with an unset grant D1 passes an explicit --tools list (OMP\'s default set minus those), failing closed rather than widening to the defaults',
  },
  additionalDirectories: { honored: true, via: '--add-dir per directory; an omp build that rejects --add-dir is respawned once without it, with a v1 note (Ruling 22)' },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: '--model provider/model' },
  effort: { honored: true, via: '--thinking, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch' },
  sessionId: { honored: true, via: '--resume <id> when resume is set; a fresh session mints its own id, reported from get_state' },
  resume: { honored: true, via: '--resume in place of a fresh session' },
  resumeFallbackSystemPrompt: { honored: false, reason: 'Continue already resends spec.systemPrompt on every process; a separate fallback prompt is unused' },
};

export interface OmpToolSelection {
  /** `tools` → `--tools <list>`, `no-tools` → `--no-tools`, `null` → OMP's own default set. */
  flag: 'tools' | 'no-tools' | null;
  tools: string[];
  /** Requested names with no OMP equivalent, reported once as a v1 note. */
  dropped: string[];
}

/**
 * Maps a grant's cezar tool names onto OMP's `--tools` allowlist (spec § Tools). Fails closed: a
 * non-empty request that maps to nothing disables every built-in rather than widening to OMP's
 * defaults, and every narrowing (`bashAllowlist`, D1) only ever removes names.
 */
export function ompTools(
  grant: ToolGrant,
  opts: {
    restrictNativeDelegation?: boolean | undefined;
    cezarTools?: boolean;
    /** Env the extension will read: `CEZ_PREVIEW=1` there decides which cezar tools it registers. */
    env?: NodeJS.ProcessEnv | undefined;
    /** OMP names the user's settings disabled (Ruling 13), removed from the list; never added to it. */
    exclude?: readonly string[] | undefined;
  },
): OmpToolSelection {
  const requested = ompRequestedTools(grant, OMP_DEFAULT_TOOL_NAMES, opts.restrictNativeDelegation);
  if (requested === undefined) return { flag: null, tools: [], dropped: [] };
  const tools = new Set<string>();
  const dropped = new Set<string>();
  for (const name of requested) {
    // `hasOwn`: a plain-object lookup would map `constructor` onto Object's own function.
    const mapped = Object.hasOwn(OMP_TOOL_MAP, name)
      ? OMP_TOOL_MAP[name]
      : name.startsWith(MCP_PREFIX) ? ompMcpToolName(name)
        : OMP_BUILTIN_TOOL_NAMES.includes(name) ? name : undefined;
    if (mapped === undefined) dropped.add(name);
    else tools.add(mapped);
  }
  // OMP can allow or deny the whole bash tool but has no command-prefix equivalent.
  if (grant.bashAllowlist && grant.bashAllowlist.length > 0) tools.delete('bash');
  if (opts.restrictNativeDelegation) for (const name of OMP_DELEGATION_TOOLS) tools.delete(name);
  if (tools.size === 0) return { flag: 'no-tools', tools: [], dropped: [...dropped] };
  // Narrow before the CI tool joins: a refusal never leaves a CI-only list where --no-tools belongs.
  for (const name of opts.exclude ?? []) tools.delete(name);
  if (tools.size === 0) return { flag: 'no-tools', tools: [], dropped: [...dropped] };
  // Exactly the names omp-ci-wait.mjs registers (Ruling 11): OMP exits 2 on an unknown --tools name.
  if (opts.cezarTools) for (const name of cezarToolNames(opts.env ?? {})) tools.add(name);
  return { flag: 'tools', tools: [...tools], dropped: [...dropped] };
}

const MCP_PREFIX = 'mcp__';

/**
 * OMP's name for an MCP tool granted in Claude's `mcp__<server>__<tool>` spelling (Ruling 20).
 * v18.4.11 registers `mcp__<server>_<tool>` (`qjn`): each part lowercased, runs of anything but
 * `[a-z0-9_]` and repeated underscores folded to one `_`, edges trimmed, and a tool name that
 * repeats its server's prefix stripped of it. `--tools` validation matches exact names, so the
 * Claude spelling would exit 2. A name without a second `__` is already OMP's spelling (OMP
 * folds every `__` in it) and passes verbatim. OMP shortens names past 64 characters with a
 * Bun hash cezar cannot reproduce; such a name stays unknown and the startup refusal drops it.
 */
function ompMcpToolName(name: string): string {
  const rest = name.slice(MCP_PREFIX.length);
  const split = rest.indexOf('__');
  if (split <= 0 || split + 2 >= rest.length) return name;
  const server = ompMcpNamePart(rest.slice(0, split), 'server');
  const tool = ompMcpNamePart(rest.slice(split + 2), 'tool');
  return `${MCP_PREFIX}${server}_${tool.startsWith(`${server}_`) ? tool.slice(server.length + 1) : tool}`;
}

/** v18.4.11 `x7s` with digits kept, the variant OMP registers under. */
function ompMcpNamePart(value: string, fallback: string): string {
  const part = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return part.length > 0 ? part : fallback;
}

/** `omp --mode rpc` argv, in the order of the spec's spawn block. */
export function buildOmpArgs(
  spec: AgentRunSpec,
  excludeTools?: readonly string[],
  /** Ruling 22: an omp build that rejects `--add-dir` runs without the additional directories. */
  opts: { omitAddDir?: boolean } = {},
): string[] {
  const args = ['--mode', 'rpc'];
  if (spec.cezarTools) args.push('--extension', ompScriptPath('omp-ci-wait.mjs'));
  // OMP has no --session-id: a fresh session mints its id, which get_state reports.
  if (spec.resume && spec.sessionId) args.push('--resume', spec.sessionId);
  if (spec.systemPrompt) args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.model) args.push('--model', spec.model);
  const effort = parseEffort(spec.effort);
  if (effort) args.push('--thinking', effort);
  if (!opts.omitAddDir) for (const dir of spec.additionalDirectories ?? []) args.push('--add-dir', dir);
  if (spec.restrictNativeDelegation) args.push('--config', ompScriptPath('omp-restrict-delegation.yml'));
  const selection = ompTools(spec.toolGrant, {
    restrictNativeDelegation: spec.restrictNativeDelegation,
    cezarTools: spec.cezarTools !== undefined,
    env: spec.env,
    exclude: excludeTools,
  });
  if (selection.flag === 'tools') args.push('--tools', selection.tools.join(','));
  else if (selection.flag === 'no-tools') args.push('--no-tools');
  return args;
}

function ompScriptPath(name: string): string {
  return fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
}

export interface OmpRunnerOptions {
  /** Override the binary name/path; defaults to `omp` on PATH (`CEZ_OMP_BIN`). */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
  /** Grace before each shutdown signal escalates (ms); defaults to `KILL_GRACE_MS`. Tests shorten it. */
  killGraceMs?: number;
}

/**
 * Persistent subprocess adapter for OMP's RPC mode (#595), one `omp --mode rpc` child per
 * session. Structure follows `pi-runner.ts` step for step (Pi stays untouched); what OMP changes
 * is the turn boundary — `session_settled`, or the turn-opening prompt OMP completed without the
 * agent or rejected before admission (`ompTurnBoundary`, gated by prompt id in the mapper), never
 * `agent_end` — plus the startup commands and the error paths. v1 `turn-end` follows the mapper
 * closing its turn, so the two streams cannot disagree on a boundary.
 *
 * Contract: oh-my-pi v18.4.11 `docs/rpc.md`, `packages/coding-agent/src/modes/rpc/rpc-mode.ts`.
 * Design record and the implementation-time rulings: `.ai/specs/2026-10-02-omp-runner.md`.
 */
export class OmpRunner implements AgentRunner {
  readonly backend = 'omp' as const;
  readonly specSupport = OMP_SPEC_SUPPORT;
  readonly systemPromptOnResume = 'resent' as const;
  readonly inputDelivery: InputDelivery = {
    mode: 'steer', consumption: 'observable',
    via: 'prompt with streamingBehavior steer; set_steering_mode all at session start; user message_start with the submitted text',
  };
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: OmpRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.CEZ_OMP_BIN ?? (process.env.CEZ_DRY_RUN === '1' ? mockOmpPath() : 'omp');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    const killGraceMs = this.killGraceMs;
    let spawnError: Error | null = null;
    let inputError: Error | undefined;
    const stderr: string[] = [];
    const spawnOmp = (args: string[]): ChildProcessWithoutNullStreams => {
      const spawned = spawnSessionLeader(this.bin, args, {
        cwd: spec.cwd,
        env: buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
      });
      boundOutputDrainAfterExit(spawned);
      // Observe asynchronous write errors before any startup command can reach stdin.
      spawned.stdin.on('error', (error: Error) => failInput(spawned, error));
      spawned.on('error', (error: NodeJS.ErrnoException) => {
        spawnError = wrapSpawnError(error, this.bin);
      });
      spawned.stderr.setEncoding('utf8');
      spawned.stderr.on('data', (chunk: string) => stderr.push(chunk));
      return spawned;
    };
    // Reassigned at most once per refusal class: Ruling 13/20 narrow `--tools`, Ruling 22 drops
    // `--add-dir` for an omp build that does not accept it.
    const firstArgs = buildOmpArgs(spec);
    let spawnArgs = firstArgs;
    let child = spawnOmp(firstArgs);
    let toolsRetried = false;
    let flagsRetried = false;
    let refusedTools: string[] = [];
    let omitAddDir = false;
    let sawFrame = false;
    let closedByCaller = false;
    // A refused spawn must leave nothing in v2, so its events wait for the first stdout frame.
    // Held only when something can be dropped and retried: a `--tools` list or `--add-dir`.
    let uiHold: UiEvent[] | null = firstArgs.includes('--tools') || firstArgs.includes('--add-dir') ? [] : null;
    const emitUiEvent = (event: UiEvent): void => {
      if (uiHold) uiHold.push(event);
      else opts.onUiEvent?.(event);
    };
    const releaseUiHold = (): void => {
      const held = uiHold;
      uiHold = null;
      for (const event of held ?? []) opts.onUiEvent?.(event);
    };
    let open = true;
    let timedOut = false;
    let terminatedByCezar = false;
    let killWatchdog: PiEndWatchdog | undefined;
    let interruptKillTimer: NodeJS.Timeout | undefined;
    let ompUi = createOmpUiState();
    const textChunks: string[] = [];
    const textBlocks = new PiTextBlocks('omp-text', textChunks, onEvent);
    const flushText = (): void => textBlocks.flush();
    const toolCalls: AgentToolCallRecord[] = [];
    let sessionId = spec.sessionId;
    let startupStateChecked = false;
    let tokensUsed = 0;
    let latchedProviderError: string | undefined;
    const emitLatchedProviderError = (): void => {
      if (!latchedProviderError) return;
      onEvent?.({ type: 'error', message: latchedProviderError });
      latchedProviderError = undefined;
    };

    const emitUi = (value: unknown): void => {
      const mapped = mapOmpRpcMessage(value, ompUi);
      ompUi = mapped.state;
      for (const event of mapped.events) {
        emitUiEvent(event);
        if (event.type === 'turn.started') releaseHeldIntoTurn();
      }
    };
    /** Releases the mapper's provider-error latch when the stream ends without a settle. */
    const emitLatchedUiProviderError = (): void => {
      const mapped = ompFlushProviderError(ompUi);
      ompUi = mapped.state;
      for (const event of mapped.events) emitUiEvent(event);
    };
    const writeNow = (command: Record<string, unknown>): boolean => {
      if (inputError || !child.stdin.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
        return true;
      } catch (error) {
        failInput(child, error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    };
    // Until the current child speaks (OMP's `ready` frame) nothing is written to it: a spawn the
    // Ruling 13 refusal rejects exits without reading stdin, and what it was handed would be lost with
    // it. Accepted commands wait here, in order, and the respawned child gets the same ones.
    const outbox: Array<Record<string, unknown>> = [];
    const failInput = (failedChild: ChildProcessWithoutNullStreams, error: Error): void => {
      // EOF/abort teardown and an old refusal child's late errors are not new failures.
      if (failedChild !== child || closedByCaller || terminatedByCezar || inputError) return;
      inputError = new Error(`omp input stream failed: ${error.message}`);
      open = false;
      outbox.length = 0;
      rpcInput.rejectAgentAck(inputError);
      onEvent?.({ type: 'error', message: inputError.message });
      emitUiEvent({ type: 'session.error', message: inputError.message, fatal: true });
      // The output loop owns bounded process cleanup. Retain the error even if the child
      // exits zero before the destroyed output stream is observed.
      failedChild.stdout.destroy(inputError);
    };
    const flushOutbox = (): void => {
      for (const command of outbox.splice(0)) writeNow(command);
    };
    const write = (command: Record<string, unknown>): boolean => {
      if (!open) return false;
      if (!sawFrame) {
        outbox.push(command);
        return true;
      }
      return writeNow(command);
    };
    let humanSerial = 0;
    // Every prompt carries an id: a local completion or failure ends the turn only when it
    // answers the prompt that opened it, never a steer (the mapper gates on this id).
    const humanAcks = new Set<string>();
    // Agent input readiness, the pending agent receipt, carried input, the turn-end step and
    // auto-end live in the shared Pi-family core.
    const rpcInput = new PiRpcInput({
      cli: 'omp',
      opts,
      onEvent,
      textChunks,
      isOpen: () => open,
      turnId: () => ompUi.turnId,
      humanAcksPending: () => humanAcks.size > 0,
      end: () => end(),
      flushText,
      emitLatchedProviderError,
    });
    // Each human prompt stays held from its write until a normalized turn has it, because an
    // ack is not a turn boundary (hearsay-tools/cezarion#1112). Exits: its user message_start,
    // its ack while the turn it opened is still open, the first turn.started after its ack,
    // its prompt_result (OMP reports every admitted prompt at the terminal agent_end, before
    // session_settled), a rejected or local (`agentInvoked: false`) ack, or
    // discardQueuedMessages. A raw agent_start is not an exit: OMP's mapper reports nothing
    // for it (same rule as pi-runner.ts).
    const humanHeld = new Map<string, { text: string; acked: boolean; turnId?: string | undefined }>();
    /** A turn.started was just emitted: it reads every human prompt OMP acknowledged before it. */
    function releaseHeldIntoTurn(): void {
      for (const [id, held] of humanHeld) if (held.acked) humanHeld.delete(id);
    }
    const sendMessage = (content: ContentBlock[], requestId?: string, inputIds: readonly string[] = []): boolean => {
      if (!open) return false;
      // A steer joins the running turn; only an idle prompt opens one (#505).
      const opensTurn = !ompUi.turnId;
      rpcInput.beginPrompt(opensTurn);
      const { message, images } = toPiPrompt(content);
      const id = requestId ?? `cezar-prompt-${++humanSerial}`;
      rpcInput.cancelAutoEnd();
      if (
        !write({
          type: 'prompt',
          id,
          message,
          ...(images.length > 0 ? { images } : {}),
          ...(ompUi.turnId ? { streamingBehavior: 'steer' } : {}),
        })
      ) {
        return false;
      }
      if (requestId) rpcInput.submissions.accept(requestId, inputIds, message);
      if (!ompUi.turnId) {
        const mapped = ompTurnStarted(ompUi, id);
        ompUi = mapped.state;
        for (const event of mapped.events) emitUiEvent(event);
      }
      // An idle prompt names the turn it opened: its ack releases it while that turn is open.
      if (!requestId) {
        humanAcks.add(id);
        humanHeld.set(id, { text: message, acked: false, ...(opensTurn ? { turnId: ompUi.turnId ?? undefined } : {}) });
      }
      return true;
    };
    const end = (): void => {
      if (!open) return;
      open = false;
      closedByCaller = true;
      rpcInput.rejectAgentAck();
      flushOutbox();
      child.stdin.end();
      killWatchdog = armEndWatchdog(() => child, killGraceMs, () => { terminatedByCezar = true; });
    };
    const interrupt = (): void => {
      if (!open) return;
      if (sawFrame) writeNow({ type: 'abort' });
      open = false;
      closedByCaller = true;
      rpcInput.rejectAgentAck();
      terminatedByCezar = true;
      signalSession(child, 'SIGTERM');
      interruptKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalSession(child, 'SIGKILL');
      }, killGraceMs);
      interruptKillTimer.unref?.();
    };

    const dropped = ompTools(spec.toolGrant, {
      restrictNativeDelegation: spec.restrictNativeDelegation,
    }).dropped;
    if (dropped.length > 0) {
      onEvent?.({ type: 'note', message: `omp: dropped tools with no OMP equivalent: ${dropped.join(', ')}` });
    }
    const startup = (): void => {
      // Spec § Session lifecycle: OMP queues these until it is ready.
      write({ id: 'cezar-state', type: 'get_state' });
      // #551 parity: OMP defaults steeringMode to one-at-a-time, and sendAgentMessage requires
      // every accepted steer at the next model call.
      write({ id: 'cezar-steering', type: 'set_steering_mode', mode: 'all' });
      write({ id: 'cezar-subagents', type: 'set_subagent_subscription', level: 'events' });
      // Drops the per-delta `partial` snapshot; the coalescer and the mapper read deltas only.
      write({ id: 'cezar-event-filter', type: 'set_event_filter', events: null, messageUpdates: 'delta' });
      sendMessage([...(spec.images ?? []), { type: 'text', text: spec.userPrompt }]);
    };
    startup();

    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    // One wall-clock limit for the whole run: a Ruling 13 respawn re-arms with what is left.
    const deadlineAt = Date.now() + limitMs;
    const armDeadline = (): NodeJS.Timeout | undefined => {
      const timer =
        limitMs > 0
          ? setTimeout(() => {
              timedOut = true;
              interrupt();
            }, Math.max(0, deadlineAt - Date.now()))
          : undefined;
      timer?.unref?.();
      return timer;
    };
    let deadline = armDeadline();

    // A refusal is only retried before any frame, once per class, and never after the caller or a
    // deadline ended the session; a spawn with nothing to drop has `uiHold` null.
    const retryPossible = (): boolean =>
      !sawFrame && !(toolsRetried && flagsRetried) && !timedOut && !terminatedByCezar && !closedByCaller && uiHold !== null;
    const releaseFirstFrame = (): void => {
      if (sawFrame) return;
      sawFrame = true;
      releaseUiHold();
      flushOutbox();
    };
    const reportUsage = (value: unknown): void => {
      const usageReport = ompMessageUsage(value);
      if (!usageReport) return;
      const { input, output, cacheRead = 0, cacheWrite = 0 } = usageReport.usage;
      // v1 keeps its historical per-message weighted token convention; v2 exposes
      // the raw components of these same parent and child reports.
      tokensUsed += Math.round(input + output + cacheRead * 0.1 + cacheWrite * 1.25);
      onEvent?.({ type: 'token-usage', tokensUsed });
      if (usageReport.costUsd !== undefined) onEvent?.({ type: 'cost', usd: usageReport.costUsd });
    };
    const adoptState = (value: Record<string, unknown>, data: Record<string, unknown>): void => {
      const discovered = string(data.sessionId);
      if (discovered && discovered !== sessionId) {
        sessionId = discovered;
        onEvent?.({ type: 'session', sessionId: discovered });
      }
      // OMP v18.6.1 still has no fresh persistent-session flag. Its autoResume
      // setting can restore history without --resume (hearsay-tools/cezarion#832).
      // Only the startup query is evidence: later reads include our own messages.
      if (value.id !== 'cezar-state' || startupStateChecked) return;
      startupStateChecked = true;
      const count = data.messageCount;
      if (!spec.resume && typeof count === 'number' && count > 0) {
        const message = `omp: unexpectedly restored a session with ${count} messages for a fresh step. Previous conversation context is active; check OMP's autoResume setting.`;
        onEvent?.({ type: 'note', message });
        emitUiEvent({ type: 'session.error', message, fatal: false });
      }
    };
    /** A failure that ends the turn is its error; otherwise the turn keeps running and it is a note. */
    const reportPromptFailure = (message: string, endsTurn: boolean): void => {
      if (endsTurn) {
        onEvent?.({ type: 'error', message });
        rpcInput.failTurn();
      } else {
        onEvent?.({ type: 'note', message });
      }
    };
    const settleHumanAck = (value: Record<string, unknown>, id: string): void => {
      // `agentInvoked: false` is a prompt OMP finished itself: no agent run follows.
      const runsAgent = !(isRecord(value.data) && value.data.agentInvoked === false);
      const held = humanHeld.get(id);
      if (humanAcks.delete(id) && held) {
        if (value.success === true && runsAgent && (!held.turnId || held.turnId !== ompUi.turnId)) held.acked = true;
        else humanHeld.delete(id);
      }
    };
    const settlePromptResponse = (value: Record<string, unknown>, endsTurn: boolean): void => {
      // The turn-opening prompt rejected before admission gets no `prompt_result`, so it
      // is the turn's error here (Ruling 10). A failure after admission is reported by the
      // `prompt_result` that follows it (rpc-prompt-results.ts `fail`), and a steer's
      // failure leaves the turn running: both are only a note.
      if (value.success === false) reportPromptFailure(`omp: prompt failed: ${rpcError(value)}`, endsTurn);
      const id = string(value.id);
      const pending = rpcInput.takeAgentAck(id);
      if (pending) {
        if (value.success === true) rpcInput.acceptAgentAck(pending);
        else pending.reject(new Error(rpcError(value)));
      } else if (id) {
        settleHumanAck(value, id);
      }
      rpcInput.readyAfterAck();
    };
    // A failed get_state has no branch of its own: it is reported like any other failed command.
    const handleResponse = (value: Record<string, unknown>, endsTurn: boolean): void => {
      if (value.command === 'get_state' && value.success === true && isRecord(value.data)) {
        adoptState(value, value.data);
      } else if (string(value.command)?.startsWith('set_')) {
        if (value.success !== true) {
          onEvent?.({ type: 'note', message: `omp: ${string(value.command)} failed: ${rpcError(value)}` });
        }
      } else if (value.command === 'prompt') {
        settlePromptResponse(value, endsTurn);
      } else if (value.success === false) {
        onEvent?.({ type: 'error', message: rpcError(value) });
      }
    };
    /** The prompt failed before the agent ran: no settle follows, so the turn ends here when it
     *  opened the turn. A steer failing mid-turn leaves it running; v2 reports it as a session
     *  error whether or not a turn is open. Any other prompt_result is reported by the settle. */
    const handlePromptResult = (value: Record<string, unknown>, endsTurn: boolean): void => {
      if (value.agentInvoked !== false || value.status !== 'error') return;
      const error = isRecord(value.error) ? value.error : {};
      reportPromptFailure(ompProviderErrorMessage({ provider: error.provider, model: error.model, errorMessage: error.message }), endsTurn);
    };
    const handleAssistantMessageEnd = (value: Record<string, unknown>): void => {
      if (!isRecord(value.message) || value.message.role !== 'assistant') return;
      flushText();
      // Latched until the turn ends, cleared by a later success: OMP retries past
      // provider flakes and a recovered retry must stay silent (#256, #316).
      if (string(value.message.stopReason) === 'error') {
        rpcInput.failTurn();
        latchedProviderError = ompProviderErrorMessage(value.message);
      } else {
        latchedProviderError = undefined;
      }
    };
    const handleUserMessageStart = (value: Record<string, unknown>): void => {
      if (!isRecord(value.message) || value.message.role !== 'user') return;
      // The model received this prompt now (hearsay-tools/cezarion#505).
      const text = piMessageText(value.message);
      const ids = rpcInput.submissions.consumeOldestByText(text);
      if (ids.length) opts.onAgentInputConsumed?.(ids);
      else for (const [id, held] of humanHeld) {
        if (held.text !== text) continue;
        // Read with no normalized turn open: held until that turn.started (as pi-runner.ts).
        if (ompUi.turnId) humanHeld.delete(id);
        else held.acked = true;
        break;
      }
    };
    // Each type has one case. A message its handler's guard refuses ends there, as it did
    // when this was one if/else chain: no later case reads the same type.
    const dispatchNative = (value: Record<string, unknown>, endsTurn: boolean): void => {
      switch (value.type) {
        case 'response': handleResponse(value, endsTurn); break;
        case 'prompt_result': handlePromptResult(value, endsTurn); break;
        case 'message_update': if (isRecord(value.assistantMessageEvent)) textBlocks.update(value.assistantMessageEvent); break;
        case 'message_end': handleAssistantMessageEnd(value); break;
        case 'agent_start': rpcInput.startTurn(); break;
        case 'message_start': handleUserMessageStart(value); break;
        case 'tool_execution_start': flushText(); recordPiToolCall(value, toolCalls, onEvent); break;
        case 'tool_execution_end': emitPiToolResult(value, onEvent); break;
        case 'extension_error':
          onEvent?.({ type: 'note', message: string(value.error) ?? string(value.message) ?? 'omp extension error' });
          break;
        case 'notice': {
          const message = string(value.message);
          if (message) onEvent?.({ type: 'note', message: `omp: ${message}` });
          break;
        }
      }
    };
    const handleOutputLine = (line: string): void => {
      releaseFirstFrame();
      const value = parseRpcLine(line);
      if (value === undefined) {
        onEvent?.({ type: 'note', message: `omp: skipped unparseable RPC line: ${truncate(line)}` });
        return;
      }
      opts.onActivity?.();
      // Flush before message/tool/turn boundaries so v2 events never overtake a pending
      // block; never on prompt acks, which can land between text_deltas (pi-runner.ts).
      if (isRecord(value) && OMP_TEXT_BOUNDARY_TYPES.has(value.type)) flushText();
      // A boundary only ends a turn that is open: OMP never settles an idle session, and a
      // second boundary for the same prompt must not end the next one.
      const turnOpen = ompUi.turnId !== null;
      emitUi(value);
      reportUsage(value);
      // The mapper closed its turn on this frame: v1 ends the turn with it.
      const endsTurn = turnOpen && ompUi.turnId === null;
      if (!isRecord(value)) return;
      if (value.type === 'prompt_result') humanHeld.delete(string(value.id) ?? '');
      dispatchNative(value, endsTurn);
      if (endsTurn) rpcInput.settleTurn();
    };

    /** Notes the Ruling 13/20/22 refusal and returns the argv for one respawn, or null when the
     *  exit is not a refusal that may still be retried. */
    const retryArgsAfterRefusal = (exitCode: number | null): string[] | null => {
      // Ruling 13: exit 2 before any frame, naming tools the user's OMP settings disabled. Respawn
      // once without them: the list only narrows, so this never widens what the step granted.
      // Ruling 20 widens the same respawn to MCP names OMP did not register (a Claude spelling
      // it cannot match, or a server slower than OMP's discovery window).
      const canRetry = exitCode === 2 && !spawnError && retryPossible();
      // Ruling 22: OMP rejects unknown flags while parsing, before it validates --tools, so this
      // refusal comes first and a tool refusal may still follow on the respawn.
      const droppedDirs = canRetry && !flagsRetried ? refusedOmpAddDir(stderr.join(''), spawnArgs) : null;
      const refusal = canRetry && !droppedDirs && !toolsRetried
        ? refusedOmpTools(stderr.join(''), ompToolList(spawnArgs))
        : null;
      if (!droppedDirs && !refusal) return null;
      stderr.length = 0;
      if (droppedDirs) {
        flagsRetried = true;
        omitAddDir = true;
        onEvent?.({
          type: 'note',
          message: `omp: this omp CLI does not accept --add-dir (update OMP); ran without the additional directories: ${droppedDirs.join(', ')}`,
        });
      }
      if (refusal) {
        toolsRetried = true;
        refusedTools = [...refusal.disabled, ...refusal.mcp];
        const dropped = [
          ...(refusal.disabled.length > 0 ? [`tools disabled by your OMP settings were dropped: ${refusal.disabled.join(', ')}`] : []),
          ...(refusal.mcp.length > 0 ? [`MCP tools OMP has not registered were dropped: ${refusal.mcp.join(', ')}`] : []),
        ];
        onEvent?.({ type: 'note', message: `omp: ${dropped.join('; ')}` });
      }
      // Session state (mapper, held v2 events, ack sets) follows what was accepted, not the
      // child, and the outbox still holds every command accepted so far: the new child is
      // sent exactly those, once, when it speaks.
      return buildOmpArgs(spec, refusedTools, { omitAddDir });
    };
    const runResult = (): AgentRunResult => ({ text: textChunks.join('\n').trim(), toolCalls, tokensUsed, sessionId });
    const exitFailure = (exitCode: number): Error => {
      const diagnostic = stderr.join('');
      if (diagnostic.trim()) onEvent?.({ type: 'note', message: `omp CLI stderr:\n${diagnostic}` });
      const detail = ompStderrDetail(diagnostic);
      const message = `omp CLI exited with code ${exitCode}${detail ? ` — ${detail}` : ''}`;
      onEvent?.({ type: 'error', message });
      return new Error(message);
    };
    const reportExit = (exitCode: number | null): void => {
      // A signal we sent is teardown, not a second agent failure (#73).
      if (terminatedByCezar && (isSignalTerminationExit(exitCode) || (exitCode === null && child.signalCode !== null))) {
        onEvent?.({
          type: 'note',
          message: `omp CLI did not exit on its own after close; terminated by cezar (${exitCode === null ? child.signalCode : `code ${exitCode}`})`,
        });
      } else if (exitCode === null && child.signalCode !== null && !terminatedByCezar) {
        // Killed from outside (OOM killer, a stray kill): a truncated run, never a success.
        const message = `omp CLI was killed by signal ${child.signalCode}`;
        onEvent?.({ type: 'error', message });
        throw new Error(message);
      } else if (exitCode !== 0 && exitCode !== null) {
        throw exitFailure(exitCode);
      }
    };
    const settleExit = (exitCode: number | null): AgentRunResult => {
      open = false;
      releaseUiHold();
      if (spawnError) throw spawnError;
      if (inputError) throw inputError;
      if (timedOut) {
        const message = `omp CLI timed out after ${Math.round((limitMs / 60_000) * 10) / 10}m and was killed`;
        onEvent?.({ type: 'error', message });
        onEvent?.({ type: 'done' });
        return runResult();
      }
      reportExit(exitCode);
      if (ompUi.turnId) onEvent?.({ type: 'note', message: 'omp RPC session ended before session_settled' });
      if (tokensUsed === 0) onEvent?.({ type: 'note', message: 'token usage not reported by omp CLI' });
      emitUiEvent({ type: 'session.ended', reason: ompUi.stopReason });
      onEvent?.({ type: 'done' });
      return runResult();
    };

    const result = (async function runOmp(): Promise<AgentRunResult> {
      try {
        for await (const line of readNdjson(child.stdout)) handleOutputLine(line);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          // A live child whose stream failed is not a refusal: no respawn follows, so nothing
          // may still be accepted into the outbox.
          open = false;
          // The run is reported failed, so the CLI must not keep running tools in the worktree:
          // SIGTERM now, SIGKILL after the grace period (a timer `finally` does not clear).
          terminatedByCezar = true;
          signalSession(child, 'SIGTERM');
          const reap = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) signalSession(child, 'SIGKILL');
          }, killGraceMs);
          reap.unref?.();
          throw error;
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        rpcInput.stopAutoEndTimer();
        killWatchdog?.clear();
        // A refused spawn may still be respawned: stay open so input accepted meanwhile is kept
        // for the new child instead of being refused in the gap.
        if (!retryPossible()) open = false;
        rpcInput.rejectAgentAck();
      }

      flushText();
      emitLatchedProviderError();
      emitLatchedUiProviderError();
      const exitCode = await waitForExit(child);
      if (interruptKillTimer) clearTimeout(interruptKillTimer);
      const respawnArgs = retryArgsAfterRefusal(exitCode);
      if (respawnArgs) {
        spawnArgs = respawnArgs;
        child = spawnOmp(spawnArgs);
        if (child.pid !== undefined) opts.onPidChange?.(child.pid);
        deadline = armDeadline();
        return runOmp();
      }
      return settleExit(exitCode);
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      // A failed write returns no receipt.
      sendAgentMessage: (content, inputIds = [], options) =>
        rpcInput.sendAgentMessage(content, inputIds, options, sendMessage, () => false),
      // A written prompt cannot be unwritten; only stop reporting an acknowledged one as held.
      discardQueuedMessages: () => { humanHeld.clear(); },
      holdsHumanInput: () => humanHeld.size > 0,
      heldHumanInputCount: () => humanHeld.size,
      end,
      interrupt,
      // The live child: a Ruling 13 respawn replaces it (`onPidChange` tells the caller who read it).
      get pid() {
        return child.pid;
      },
      get open() {
        return open;
      },
    };
    this.lastSession = session;
    return session;
  }
}

/** Native message types that end a text block; a prompt or response ack is not one. */
const OMP_TEXT_BOUNDARY_TYPES: ReadonlySet<unknown> = new Set([
  'tool_execution_start', 'message_end', 'session_settled', 'prompt_result', 'turn_end', 'agent_end',
]);

/**
 * The stderr line an exit error carries. OMP's "no usable model" exit prints its reason first
 * and setup hints after it, which the generic last-lines summary would keep instead.
 */
function ompStderrDetail(stderr: string): string {
  const first = stderr.split(/\r?\n/).find(line => line.trim())?.trim();
  if (first?.startsWith('No models available')) return first;
  return summarizeRunnerStderr(stderr);
}

/** The `--tools` list in an omp argv; empty when none was passed. */
function ompToolList(args: readonly string[]): string[] {
  const at = args.indexOf('--tools');
  return at >= 0 ? (args[at + 1] ?? '').split(',').filter(Boolean) : [];
}

/**
 * What OMP's startup refusal (v18.4.11 `emt()`, exit 2) lets a respawn drop, limited to names this
 * spawn passed so a retry only narrows. One error carries up to two lists:
 * `Built-in tool(s) unavailable in this session: a, b.` (tools the user's settings disable, Ruling 13)
 * and `Unknown tool(s) in --tools: a, b.` (Ruling 20: droppable only when every name is an
 * `mcp__` name this spawn passed; any other unknown name stays fatal, so nothing is retried).
 * `null` when there is nothing to drop.
 */
function refusedOmpTools(stderr: string, passed: readonly string[]): { disabled: string[]; mcp: string[] } | null {
  const listed = (pattern: RegExp): string[] | undefined => {
    const match = pattern.exec(stderr);
    return match ? (match[1] ?? '').replace(/\.\s*$/, '').split(/[\s,]+/).filter(Boolean) : undefined;
  };
  const unknown = listed(/Unknown tools? in --tools:[ \t]*([^\r\n]*)/) ?? [];
  if (unknown.some(name => !name.startsWith(MCP_PREFIX) || !passed.includes(name))) return null;
  const disabled = (listed(/Built-in tools? unavailable in this session:[ \t]*([^\r\n]*)/) ?? [])
    .filter(name => passed.includes(name));
  return disabled.length + unknown.length > 0 ? { disabled, mcp: unknown } : null;
}

/**
 * Ruling 22: the directories to drop when this omp build refused `--add-dir` (`Error: unknown
 * flag(s): …`, exit 2, before any session work). Only `--add-dir` is droppable: every other
 * unknown flag carries something the step needs (model, prompt, resume, tools), so the refusal
 * stays fatal and nothing is retried. `null` when there is nothing to drop.
 */
function refusedOmpAddDir(stderr: string, args: readonly string[]): string[] | null {
  const match = /unknown flags?:[ \t]*([^\r\n]*)/i.exec(stderr);
  if (!match) return null;
  const unknown = (match[1] ?? '').replace(/\.\s*$/, '').split(/[\s,]+/).filter(Boolean);
  if (unknown.length === 0 || unknown.some(flag => flag !== '--add-dir')) return null;
  const dirs = args.flatMap((arg, i) => (arg === '--add-dir' ? [args[i + 1] ?? ''] : [])).filter(Boolean);
  return dirs.length > 0 ? dirs : null;
}

function wrapSpawnError(error: NodeJS.ErrnoException, bin: string): Error {
  if (error.code === 'ENOENT') {
    return new Error(`\`${bin}\` not found on PATH: install OMP (https://omp.sh) and run \`omp login\``);
  }
  return error;
}

/** Path to the bundled mock (`scripts/mock-omp-rpc.mjs`), for CEZ_DRY_RUN=1; as pi-runner.ts `mockPiPath`. */
function mockOmpPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-omp-rpc.mjs');
}

