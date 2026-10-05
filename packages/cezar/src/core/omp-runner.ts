import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseEffort } from '@open-mercato/cezar-contract';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { parseAskMarker } from './ask.ts';
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
} from './agent-runner.js';
import { isSignalTerminationExit } from './agent-runner.js';
import { buildChildEnv } from './agent-env.js';
import type { UiEvent } from './ui-events.js';
import { cezarToolNames } from '../ci-wait/tools.js';
import { readNdjson } from './ndjson.js';
import {
  createOmpUiState,
  mapOmpRpcMessage,
  ompFlushProviderError,
  ompProviderErrorMessage,
  ompTurnStarted,
} from './omp-ui-mapper.js';
import { summarizeRunnerStderr } from './runner-stderr.ts';
import { V1TextCoalescer } from './v1-text-coalescer.js';
import { InputSubmissions } from './input-submissions.ts';
import { boundOutputDrainAfterExit, AUTO_END_DELAY_MS, DEFAULT_RUN_TIMEOUT_MS, KILL_GRACE_MS } from './runner-runtime.js';

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
  // Ruling 2: OMP v18.4.11 has no `fetch` built-in; `read` reads static web pages per its own description.
  WebFetch: 'read',
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
  cezarTools: { honored: true, via: 'explicit CI --extension; cezar_wait_for_ci admitted when --tools is set' },
  systemPrompt: { honored: true, via: '--append-system-prompt' },
  userPrompt: { honored: true, via: 'RPC prompt.message' },
  images: { honored: true, via: "RPC prompt.images ({type:'image', data, mimeType})" },
  cwd: { honored: true, via: 'spawn cwd' },
  allowedTools: { honored: true, via: '--tools, mapped onto OMP names; unmapped names dropped (fail closed)' },
  restrictNativeDelegation: {
    honored: true,
    via: '--config overlay denying task, and task/wait left out of --tools (D1); eval is left out too, since OMP v18.4.11 has no setting that disables its agent()/workpool() helpers; with allowedTools undefined D1 passes an explicit --tools list (OMP\'s default set minus those), failing closed rather than widening to the defaults',
  },
  bashAllowlist: { honored: true, via: "no prefix equivalent: bash dropped from --tools when an allowlist is set (Pi's rule)" },
  additionalDirectories: { honored: true, via: '--add-dir per directory' },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: '--model provider/model' },
  effort: { honored: true, via: '--thinking, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch' },
  sessionId: { honored: true, via: '--resume <id> when resume is set; a fresh session mints its own id, reported from get_state' },
  resume: { honored: true, via: '--resume in place of a fresh session' },
};

export interface OmpToolSelection {
  /** `tools` → `--tools <list>`, `no-tools` → `--no-tools`, `null` → OMP's own default set. */
  flag: 'tools' | 'no-tools' | null;
  tools: string[];
  /** Requested names with no OMP equivalent, reported once as a v1 note. */
  dropped: string[];
}

/**
 * Maps cezar's tool names onto OMP's `--tools` allowlist (spec § Tools). Fails closed: a
 * non-empty request that maps to nothing disables every built-in rather than widening to OMP's
 * defaults, and every narrowing (`bashAllowlist`, D1) only ever removes names.
 */
export function ompTools(
  allowedTools: string[] | undefined,
  opts: {
    bashAllowlist?: string[];
    restrictNativeDelegation?: boolean;
    cezarTools?: boolean;
    /** Env the extension will read: `CEZ_PREVIEW=1` there decides which cezar tools it registers. */
    env?: NodeJS.ProcessEnv;
    /** OMP names the user's settings disabled (Ruling 13), removed from the list; never added to it. */
    exclude?: readonly string[];
  },
): OmpToolSelection {
  // OMP's default set includes task, wait and eval; D1 has to name a list to leave them out.
  const requested = allowedTools ?? (opts.restrictNativeDelegation ? [...OMP_DEFAULT_TOOL_NAMES] : undefined);
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
  if (opts.bashAllowlist && opts.bashAllowlist.length > 0) tools.delete('bash');
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
export function buildOmpArgs(spec: AgentRunSpec, excludeTools?: readonly string[]): string[] {
  const args = ['--mode', 'rpc'];
  if (spec.cezarTools) args.push('--extension', ompScriptPath('omp-ci-wait.mjs'));
  // OMP has no --session-id: a fresh session mints its id, which get_state reports.
  if (spec.resume && spec.sessionId) args.push('--resume', spec.sessionId);
  if (spec.systemPrompt) args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.model) args.push('--model', spec.model);
  const effort = parseEffort(spec.effort);
  if (effort) args.push('--thinking', effort);
  for (const dir of spec.additionalDirectories ?? []) args.push('--add-dir', dir);
  if (spec.restrictNativeDelegation) args.push('--config', ompScriptPath('omp-restrict-delegation.yml'));
  const selection = ompTools(spec.allowedTools, {
    bashAllowlist: spec.bashAllowlist,
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
  readonly inputDelivery: InputDelivery = {
    mode: 'steer', consumption: 'observable',
    via: 'prompt with streamingBehavior steer; set_steering_mode all at session start; user message_start with the submitted text',
  };
  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: OmpRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.CEZ_OMP_BIN ?? (process.env.CEZ_DRY_RUN === '1' ? mockOmpPath() : 'omp');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
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
    let spawnError: Error | null = null;
    const stderr: string[] = [];
    const spawnOmp = (args: string[]): ChildProcessWithoutNullStreams => {
      const spawned = nodeSpawn(this.bin, args, {
        cwd: spec.cwd,
        env: buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
      });
      boundOutputDrainAfterExit(spawned);
      spawned.on('error', (error: NodeJS.ErrnoException) => {
        spawnError = wrapSpawnError(error, this.bin);
      });
      spawned.stderr.setEncoding('utf8');
      spawned.stderr.on('data', (chunk: string) => stderr.push(chunk));
      return spawned;
    };
    // Reassigned once at most: Ruling 13 respawns without the tools the user's OMP settings disabled.
    const firstArgs = buildOmpArgs(spec);
    let child = spawnOmp(firstArgs);
    let respawned = false;
    let sawFrame = false;
    let closedByCaller = false;
    // A refused spawn must leave nothing in v2, so its events wait for the first stdout frame.
    // Held only when a `--tools` list can be narrowed and retried.
    let uiHold: UiEvent[] | null = firstArgs.includes('--tools') ? [] : null;
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
    let autoEndTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let interruptKillTimer: NodeJS.Timeout | undefined;
    let ompUi = createOmpUiState();
    const textChunks: string[] = [];
    /** One v1 `text` per complete block, never per token (pi-runner.ts, #902 / #2). */
    const textCoalescer = new V1TextCoalescer((text) => {
      textChunks.push(text);
      onEvent?.({ type: 'text', text });
    });
    /** `contentIndex` restarts at 0 on every assistant message (as Pi's); see pi-runner.ts. */
    let textBlockSeq = 0;
    const openTextBlockKeys = new Map<number, string>();
    const textBlockKey = (contentIndex: unknown): string | undefined => {
      if (typeof contentIndex !== 'number') return undefined;
      let key = openTextBlockKeys.get(contentIndex);
      if (!key) {
        key = `omp-text-${++textBlockSeq}`;
        openTextBlockKeys.set(contentIndex, key);
      }
      return key;
    };
    const flushText = (): void => {
      textCoalescer.flush();
      openTextBlockKeys.clear();
    };
    const toolCalls: AgentToolCallRecord[] = [];
    let sessionId = spec.sessionId;
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
      for (const event of mapped.events) emitUiEvent(event);
    };
    /** Releases the mapper's provider-error latch when the stream ends without a settle. */
    const emitLatchedUiProviderError = (): void => {
      const mapped = ompFlushProviderError(ompUi);
      ompUi = mapped.state;
      for (const event of mapped.events) emitUiEvent(event);
    };
    const writeNow = (command: Record<string, unknown>): boolean => {
      if (!child.stdin.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
        return true;
      } catch {
        return false;
      }
    };
    // Until the current child speaks (OMP's `ready` frame) nothing is written to it: a spawn the
    // Ruling 13 refusal rejects exits without reading stdin, and what it was handed would be lost with
    // it. Accepted commands wait here, in order, and the respawned child gets the same ones.
    const outbox: Array<Record<string, unknown>> = [];
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
    let agentInputReady = false;
    let promptSerial = 0;
    let humanSerial = 0;
    // Every prompt carries an id: a local completion or failure ends the turn only when it
    // answers the prompt that opened it, never a steer (the mapper gates on this id).
    const humanAcks = new Set<string>();
    let agentAck: { id: string; resolve: () => void; reject: (error: Error) => void } | undefined;
    const rejectAgentAck = () => {
      const pending = agentAck; agentAck = undefined;
      pending?.reject(new Error('omp closed before prompt acknowledgement'));
    };
    const scheduleAutoEnd = () => {
      if (!opts.autoEndAfterFirstTurn || !open || autoEndTimer || agentAck || humanAcks.size) return;
      autoEndTimer = setTimeout(() => {
        autoEndTimer = undefined;
        if (opts.shouldAutoEnd?.() !== false) end();
      }, AUTO_END_DELAY_MS);
      autoEndTimer.unref?.();
    };
    // Same readiness rules as pi-runner.ts (#505): a refusal caused only by an outstanding
    // acknowledgement gets one readiness hint when it lands, even mid-turn.
    let refusedForAck = false;
    const readyAfterAck = () => {
      if (open && agentInputReady && !ompUi.turnId && !agentAck && !humanAcks.size) {
        refusedForAck = false;
        opts.onAgentInputReady?.(); scheduleAutoEnd();
      } else if (refusedForAck && open && !agentAck && !humanAcks.size && !pendingMarkerAsk) {
        refusedForAck = false;
        opts.onAgentInputReady?.();
      }
    };
    let pendingMarkerAsk = false;
    let turnTextStart = 0;
    // Accepted agent prompts not yet seen as a user message_start (#505).
    const submissions = new InputSubmissions();
    // Submissions already queued when a turn began: that turn reads them. OMP reports an
    // admitted steer at the next terminal agent_end (rpc-prompt-results.ts), never drops it.
    let carried = new Set<string>();
    const acked = new Set<string>();
    let turnFailed = false;
    const sendMessage = (content: ContentBlock[], requestId?: string, inputIds: readonly string[] = []): boolean => {
      if (!open) return false;
      // A steer joins the running turn; only an idle prompt opens one (#505).
      const opensTurn = !ompUi.turnId;
      agentInputReady = false;
      if (opensTurn) {
        pendingMarkerAsk = false;
        turnTextStart = textChunks.length;
      }
      const { message, images } = toOmpPrompt(content);
      const id = requestId ?? `cezar-prompt-${++humanSerial}`;
      if (autoEndTimer) {
        clearTimeout(autoEndTimer);
        autoEndTimer = undefined;
      }
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
      if (!requestId) humanAcks.add(id);
      else submissions.accept(requestId, inputIds, message);
      if (!ompUi.turnId) {
        const mapped = ompTurnStarted(ompUi, id);
        ompUi = mapped.state;
        for (const event of mapped.events) emitUiEvent(event);
      }
      return true;
    };
    const end = (): void => {
      if (!open) return;
      open = false;
      closedByCaller = true;
      rejectAgentAck();
      flushOutbox();
      child.stdin.end();
      killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        terminatedByCezar = true;
        child.kill('SIGTERM');
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const interrupt = (): void => {
      if (!open) return;
      if (sawFrame) writeNow({ type: 'abort' });
      open = false;
      closedByCaller = true;
      rejectAgentAck();
      terminatedByCezar = true;
      child.kill('SIGTERM');
      interruptKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      interruptKillTimer.unref?.();
    };

    const dropped = ompTools(spec.allowedTools, {
      bashAllowlist: spec.bashAllowlist,
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
    const armDeadline = (): NodeJS.Timeout | undefined => {
      const timer =
        limitMs > 0
          ? setTimeout(() => {
              timedOut = true;
              interrupt();
            }, limitMs)
          : undefined;
      timer?.unref?.();
      return timer;
    };
    let deadline = armDeadline();

    // A refusal is only retried before any frame, once, and never after the caller or a deadline
    // ended the session; a spawn with no `--tools` list has nothing to narrow (`uiHold` is null).
    const retryPossible = (): boolean =>
      !sawFrame && !respawned && !timedOut && !terminatedByCezar && !closedByCaller && uiHold !== null;
    const result = (async function runOmp(): Promise<AgentRunResult> {
      try {
        for await (const line of readNdjson(child.stdout)) {
          if (!sawFrame) {
            sawFrame = true;
            releaseUiHold();
            flushOutbox();
          }
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            onEvent?.({ type: 'note', message: `omp: skipped unparseable RPC line: ${truncate(line)}` });
            continue;
          }
          opts.onActivity?.();
          // Flush before message/tool/turn boundaries so v2 events never overtake a pending
          // block; never on prompt acks, which can land between text_deltas (pi-runner.ts).
          if (
            isRecord(value) &&
            (value.type === 'tool_execution_start' ||
              value.type === 'message_end' ||
              value.type === 'session_settled' ||
              value.type === 'prompt_result' ||
              value.type === 'turn_end' ||
              value.type === 'agent_end')
          ) {
            flushText();
          }
          // A boundary only ends a turn that is open: OMP never settles an idle session, and a
          // second boundary for the same prompt must not end the next one.
          const turnOpen = ompUi.turnId !== null;
          emitUi(value);
          // The mapper closed its turn on this frame: v1 ends the turn with it.
          const endsTurn = turnOpen && ompUi.turnId === null;
          if (!isRecord(value)) continue;

          if (value.type === 'response' && value.command === 'get_state' && value.success === true && isRecord(value.data)) {
            const discovered = string(value.data.sessionId);
            if (discovered && discovered !== sessionId) {
              sessionId = discovered;
              onEvent?.({ type: 'session', sessionId: discovered });
            }
          } else if (value.type === 'response' && string(value.command)?.startsWith('set_')) {
            if (value.success !== true) {
              onEvent?.({ type: 'note', message: `omp: ${string(value.command)} failed: ${rpcError(value)}` });
            }
          } else if (value.type === 'response' && value.command === 'prompt') {
            if (value.success === false) {
              // The turn-opening prompt rejected before admission gets no `prompt_result`, so it
              // is the turn's error here (Ruling 10). A failure after admission is reported by the
              // `prompt_result` that follows it (rpc-prompt-results.ts `fail`), and a steer's
              // failure leaves the turn running: both are only a note.
              const message = `omp: prompt failed: ${rpcError(value)}`;
              if (endsTurn) {
                onEvent?.({ type: 'error', message });
                turnFailed = true;
              } else {
                onEvent?.({ type: 'note', message });
              }
            }
            const pending = agentAck;
            const id = string(value.id);
            if (pending && id === pending.id) {
              agentAck = undefined;
              if (value.success === true) { acked.add(pending.id); pending.resolve(); }
              else pending.reject(new Error(rpcError(value)));
            } else if (id) {
              humanAcks.delete(id);
            }
            readyAfterAck();
          } else if (value.type === 'response' && value.success === false) {
            onEvent?.({ type: 'error', message: rpcError(value) });
          } else if (value.type === 'prompt_result' && value.agentInvoked === false && value.status === 'error') {
            // The prompt failed before the agent ran: no settle follows, so the turn ends here
            // when it opened the turn. A steer failing mid-turn leaves it running.
            const error = isRecord(value.error) ? value.error : {};
            const message = ompProviderErrorMessage({ provider: error.provider, model: error.model, errorMessage: error.message });
            if (endsTurn) {
              onEvent?.({ type: 'error', message });
              turnFailed = true;
            } else {
              // v2 reports it as a session error whether or not a turn is open.
              onEvent?.({ type: 'note', message });
            }
          } else if (value.type === 'message_update' && isRecord(value.assistantMessageEvent)) {
            const update = value.assistantMessageEvent;
            const contentKey = textBlockKey(update.contentIndex);
            if (update.type === 'text_delta' && typeof update.delta === 'string') {
              textCoalescer.append(contentKey, update.delta);
            } else if (update.type === 'text_end') {
              const snapshot = typeof update.content === 'string' ? update.content : undefined;
              textCoalescer.complete(contentKey, snapshot);
              if (typeof update.contentIndex === 'number') openTextBlockKeys.delete(update.contentIndex);
            }
          } else if (value.type === 'message_end' && isRecord(value.message) && value.message.role === 'assistant') {
            flushText();
            const usage = usageValues(value.message.usage);
            if (usage) {
              tokensUsed += usage.weighted;
              onEvent?.({ type: 'token-usage', tokensUsed });
              if (usage.cost !== undefined) onEvent?.({ type: 'cost', usd: usage.cost });
            }
            // Latched until the turn ends, cleared by a later success: OMP retries past
            // provider flakes and a recovered retry must stay silent (#256, #316).
            if (string(value.message.stopReason) === 'error') {
              turnFailed = true;
              latchedProviderError = ompProviderErrorMessage(value.message);
            } else {
              latchedProviderError = undefined;
            }
          } else if (value.type === 'agent_start') {
            // Only a prompt OMP acknowledged before this agent_start can be in its turn (#505).
            carried = new Set(submissions.pendingIds().filter(id => acked.has(id)));
            turnFailed = false;
          } else if (value.type === 'message_start' && isRecord(value.message) && value.message.role === 'user') {
            // The model received this prompt now (#505).
            const ids = submissions.consumeOldestByText(ompMessageText(value.message));
            if (ids.length) opts.onAgentInputConsumed?.(ids);
          } else if (value.type === 'tool_execution_start') {
            flushText();
            const id = string(value.toolCallId);
            const name = string(value.toolName);
            if (id && name) {
              toolCalls.push({ id, name, input: value.args });
              onEvent?.({ type: 'tool-call', id, tool: name, input: value.args });
            }
          } else if (value.type === 'tool_execution_end') {
            const id = string(value.toolCallId);
            if (id) {
              onEvent?.({
                type: 'tool-result',
                toolCallId: id,
                result: contentText(isRecord(value.result) ? value.result.content : undefined) ?? '',
                isError: value.isError === true,
              });
              emitImages(isRecord(value.result) ? value.result.content : undefined, onEvent);
            }
          } else if (value.type === 'extension_error') {
            onEvent?.({ type: 'note', message: string(value.error) ?? string(value.message) ?? 'omp extension error' });
          } else if (value.type === 'notice') {
            const message = string(value.message);
            if (message) onEvent?.({ type: 'note', message: `omp: ${message}` });
          }

          if (endsTurn) {
            flushText();
            emitLatchedProviderError();
            pendingMarkerAsk = parseAskMarker(textChunks.slice(turnTextStart).join('\n')) !== null;
            agentInputReady = true;
            // Input queued before this turn began was processed by it, even without a user
            // message_start (#505) — unless the turn failed and may never have reached the model.
            const read = turnFailed ? [] : [...carried].flatMap(id => submissions.consume(id));
            turnFailed = false;
            carried = new Set();
            if (read.length) opts.onAgentInputConsumed?.(read);
            onEvent?.({ type: 'turn-end' });
            scheduleAutoEnd();
          }
        }
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          // A live child whose stream failed is not a refusal: no respawn follows, so nothing
          // may still be accepted into the outbox.
          open = false;
          throw error;
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        if (autoEndTimer) clearTimeout(autoEndTimer);
        if (killTimer) clearTimeout(killTimer);
        // A refused spawn may still be respawned: stay open so input accepted meanwhile is kept
        // for the new child instead of being refused in the gap.
        if (!retryPossible()) open = false;
        rejectAgentAck();
      }

      flushText();
      emitLatchedProviderError();
      emitLatchedUiProviderError();
      const exitCode = await waitForExit(child);
      if (interruptKillTimer) clearTimeout(interruptKillTimer);
      // Ruling 13: exit 2 before any frame, naming tools the user's OMP settings disabled. Respawn
      // once without them: the list only narrows, so this never widens what the step granted.
      // Ruling 20 widens the same respawn to MCP names OMP did not register (a Claude spelling
      // it cannot match, or a server slower than OMP's discovery window).
      const refusal =
        exitCode === 2 && !spawnError && retryPossible()
          ? refusedOmpTools(stderr.join(''), ompToolList(firstArgs))
          : null;
      if (refusal) {
        const refused = [...refusal.disabled, ...refusal.mcp];
        respawned = true;
        stderr.length = 0;
        const dropped = [
          ...(refusal.disabled.length > 0 ? [`tools disabled by your OMP settings were dropped: ${refusal.disabled.join(', ')}`] : []),
          ...(refusal.mcp.length > 0 ? [`MCP tools OMP has not registered were dropped: ${refusal.mcp.join(', ')}`] : []),
        ];
        onEvent?.({ type: 'note', message: `omp: ${dropped.join('; ')}` });
        // Session state (mapper, held v2 events, ack sets) follows what was accepted, not the
        // child, and the outbox still holds every command accepted so far: the new child is
        // sent exactly those, once, when it speaks.
        child = spawnOmp(buildOmpArgs(spec, refused));
        if (child.pid !== undefined) opts.onPidChange?.(child.pid);
        deadline = armDeadline();
        return runOmp();
      }
      open = false;
      releaseUiHold();
      if (spawnError) throw spawnError;
      if (timedOut) {
        const message = `omp CLI timed out after ${Math.round((limitMs / 60_000) * 10) / 10}m and was killed`;
        onEvent?.({ type: 'error', message });
        onEvent?.({ type: 'done' });
        return { text: textChunks.join('\n').trim(), toolCalls, tokensUsed, sessionId };
      }
      // A signal we sent is teardown, not a second agent failure (#73).
      if (terminatedByCezar && isSignalTerminationExit(exitCode)) {
        onEvent?.({
          type: 'note',
          message: `omp CLI did not exit on its own after close; terminated by cezar (code ${exitCode})`,
        });
      } else if (exitCode !== 0 && exitCode !== null) {
        const diagnostic = stderr.join('');
        if (diagnostic.trim()) onEvent?.({ type: 'note', message: `omp CLI stderr:\n${diagnostic}` });
        const detail = ompStderrDetail(diagnostic);
        const message = `omp CLI exited with code ${exitCode}${detail ? ` — ${detail}` : ''}`;
        onEvent?.({ type: 'error', message });
        throw new Error(message);
      }
      if (ompUi.turnId) onEvent?.({ type: 'note', message: 'omp RPC session ended before session_settled' });
      if (tokensUsed === 0) onEvent?.({ type: 'note', message: 'token usage not reported by omp CLI' });
      emitUiEvent({ type: 'session.ended', reason: ompUi.stopReason });
      onEvent?.({ type: 'done' });
      return { text: textChunks.join('\n').trim(), toolCalls, tokensUsed, sessionId };
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      sendAgentMessage: (content, inputIds = []) => {
        // #505: a running turn is steered; only a pending CEZ:ASK or an unacknowledged
        // prompt refuses.
        if (open && !pendingMarkerAsk && (agentAck || humanAcks.size)) { refusedForAck = true; return false; }
        if (!open || pendingMarkerAsk) return false;
        const id = `cezar-agent-${++promptSerial}`;
        let resolve!: () => void, reject!: (error: Error) => void;
        const acknowledged = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        agentAck = { id, resolve, reject };
        if (!sendMessage(content, id, inputIds)) { agentAck = undefined; return false; }
        return acknowledged;
      },
      discardQueuedMessages: () => undefined,
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

/** Same as pi-runner.ts `toPiPrompt`. */
function toOmpPrompt(content: ContentBlock[]): {
  message: string;
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
} {
  const text: string[] = [];
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const block of content) {
    if (block.type === 'text') text.push(block.text);
    else images.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
  }
  return { message: text.join('\n'), images };
}

/** Same as pi-runner.ts `usageValues`. */
function usageValues(value: unknown): { weighted: number; cost?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const input = number(value.input) ?? 0;
  const output = number(value.output) ?? 0;
  const cacheRead = number(value.cacheRead) ?? 0;
  const cacheWrite = number(value.cacheWrite) ?? 0;
  const cost = isRecord(value.cost) ? number(value.cost.total) : undefined;
  return {
    weighted: Math.round(input + output + cacheRead * 0.1 + cacheWrite * 1.25),
    ...(cost !== undefined && cost >= 0 ? { cost } : {}),
  };
}

/** Same as pi-runner.ts `emitImages`. */
function emitImages(value: unknown, onEvent?: (event: AgentEvent) => void): void {
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (isRecord(part) && part.type === 'image') {
      const data = string(part.data);
      const mediaType = string(part.mimeType);
      if (data && mediaType) onEvent?.({ type: 'image', data, mediaType });
    }
  }
}

/** Same as pi-runner.ts `piMessageText`. */
function ompMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content)
    ? message.content.flatMap(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
    : '';
}

/** Same as pi-runner.ts `contentText`. */
function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => (isRecord(part) && part.type === 'text' ? string(part.text) : undefined))
    .filter((part): part is string => part !== undefined);
  return text.length > 0 ? text.join('\n') : undefined;
}

/** OMP's failure response carries `error` as a string (rpc-mode.ts, v18.4.11). */
function rpcError(value: Record<string, unknown>): string {
  if (typeof value.error === 'string') return value.error;
  const error = isRecord(value.error) ? value.error : undefined;
  return string(error?.message) ?? string(value.message) ?? `omp RPC command ${string(value.command) ?? 'unknown'} failed`;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('close', resolve));
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

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
