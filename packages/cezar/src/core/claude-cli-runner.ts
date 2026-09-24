import { execFileSync, spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseEffort } from '@open-mercato/cezar-contract';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { parseAskMarker } from './ask.ts';
import {
  AUTO_END_DELAY_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  EOF_KILL_GRACE_MS,
  EOF_TERM_GRACE_MS,
  KILL_GRACE_MS,
} from './runner-runtime.ts';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
  AgentRunSpecSupport,
  InputDelivery,
} from './agent-runner.ts';

// Re-exported for backends and the run manager that still import them from here.
export type { AgentSession, SessionOptions } from './agent-runner.ts';
import { isSignalTerminationExit, trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { costWeightedTokens, type RawUsage } from './usage.ts';
import { readNdjson } from './ndjson.ts';
import { InputSubmissions } from './input-submissions.ts';
import {
  claudeTurnStarted,
  createClaudeUiState,
  mapClaudeMessage,
  stringifyToolResultContent,
  toolResultImageBlocks,
  type ClaudeUiMapping,
} from './claude-ui-mapper.ts';

export interface ClaudeCliRunnerOptions {
  /** Override the binary name/path; defaults to `claude` on PATH. */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/** Resolve discovery and execution through the same binary and dry-run precedence. */
export function resolveClaudeExecutable(override?: string): string {
  return override ?? process.env.CEZ_CLAUDE_BIN ??
    (process.env.CEZ_DRY_RUN === '1' ? mockClaudePath() : 'claude');
}

/**
 * `AgentRunner` over the Claude Code CLI in headless stream-json mode. Auth =
 * the host's logged-in Pro/Max subscription (no API key needed). Sandboxing is
 * `--allowedTools` (default-deny for anything not listed) + running inside the
 * repo `cwd`; `Bash` is narrowed to `Bash(<prefix>:*)` patterns only when
 * `bashAllowlist` is set — the zero-config default has no allowlist, so `Bash`
 * is unrestricted shell access (#430).
 *
 * Session mechanics (multi-turn stdin, EOF watchdog, reopen window) follow
 * github-janitor's `claudeRunner.ts`; the original single-turn adaptation
 * came from @cezar/core's `ClaudeCodeCliRunner`.
 */
/**
 * What the claude CLI receives from each `AgentRunSpec` field (#284). Every
 * field has a native flag or a stdin/spawn channel — this is the runner the
 * spec was shaped around. Held against `--allowedTools`/stdin recordings by
 * the harness parity matrix; change a row only with the mapping in `buildArgs`.
 */
export const CLAUDE_SPEC_SUPPORT: AgentRunSpecSupport = {
  cezarTools: { honored: true, via: '--mcp-config and generated --allowedTools name' },
  systemPrompt: { honored: true, via: '--append-system-prompt' },
  userPrompt: { honored: true, via: 'text block of the first stream-json user message on stdin' },
  images: { honored: true, via: 'image blocks ahead of the text in the first stdin message' },
  cwd: { honored: true, via: 'spawn cwd' },
  allowedTools: { honored: true, via: '--allowedTools, through buildAllowedTools' },
  restrictNativeDelegation: { honored: true, via: '--disallowedTools Agent,Task (D1)' },
  bashAllowlist: { honored: true, via: 'Bash(<prefix>:*) entries in --allowedTools, one per prefix' },
  additionalDirectories: { honored: true, via: '--add-dir, once per directory' },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: '--model' },
  effort: { honored: true, via: '--effort, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch on the child process' },
  sessionId: { honored: true, via: '--session-id, or --resume when resume is set' },
  resume: { honored: true, via: '--resume <sessionId> in place of --session-id' },
};
export class ClaudeCliRunner implements AgentRunner {
  readonly backend = 'claude' as const;
  readonly specSupport = CLAUDE_SPEC_SUPPORT;
  readonly inputDelivery: InputDelivery = {
    mode: 'steer', consumption: 'observable',
    via: 'stream-json stdin line with uuid; --replay-user-messages echo at consumption',
  };

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: ClaudeCliRunnerOptions = {}) {
    this.bin = resolveClaudeExecutable(opts.bin);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  /** One-shot run: start a session and auto-end it after the first turn. */
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
    const args = buildClaudeArgs(spec, process.env, { replayUserMessages: supportsReplayUserMessages(this.bin) });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = nodeSpawn(this.bin, args, {
        cwd: spec.cwd,
        env: buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
      });
    } catch (err) {
      throw wrapSpawnError(err, this.bin);
    }

    let stdinOpen = true;
    let autoEndTimer: NodeJS.Timeout | undefined;
    let eofTermTimer: NodeJS.Timeout | undefined;
    let eofKillTimer: NodeJS.Timeout | undefined;

    // Protocol v2 emission — additive alongside v1 (`onEvent` keeps flowing
    // byte-identical); the channel is `opts.onUiEvent` (RunManager wiring
    // lands in R2 step 2.1). The mapper never throws, but a defect in it
    // must still never disturb the v1 stream — hence the belt-and-braces try.
    let uiState = createClaudeUiState({ fallbackSessionId: spec.sessionId });
    const emitUi = (map: (state: typeof uiState) => ClaudeUiMapping): void => {
      try {
        const mapped = map(uiState);
        uiState = mapped.state;
        if (opts.onUiEvent) {
          for (const event of mapped.events) opts.onUiEvent(event);
        }
      } catch {
        // v2 mapping is best-effort; v1 consumers stay unaffected.
      }
    };

    const textChunks: string[] = [];
    child.stdin.on('error', (error: Error) => { onEvent?.({ type: 'note', message: `claude: stdin write failed: ${error.message}` }); });
    let agentInputReady = false;
    let agentWritePending = false;
    // Stdin lines (by uuid) whose `result` has not arrived yet. Claude 2.1.280
    // merges a line written mid-turn into the running turn, and that ONE result
    // lists every line it covered in `user_message_uuids` (#505) — a per-line
    // counter left the runner busy forever after a merged follow-up.
    const unsettled = new Set<string>();
    let queuedTurnPending = false;
    const submissions = new InputSubmissions();
    const scheduleAutoEnd = () => {
      // Never arm the close window while an accepted turn is still running:
      // the timer the opening result would start here has nothing to cancel it,
      // and closing stdin under a queued turn truncates it (#146). The final
      // result brings the count to 0 and arms the window as before.
      if (!opts.autoEndAfterFirstTurn || !stdinOpen || autoEndTimer || agentWritePending) return;
      if (unsettled.size > 0) return;
      autoEndTimer = setTimeout(() => {
        autoEndTimer = undefined;
        if (opts.shouldAutoEnd?.() !== false) end();
      }, AUTO_END_DELAY_MS);
      autoEndTimer.unref?.();
    };
    let pendingMarkerAsk = false;
    let turnTextStart = 0;
    const sendMessage = (content: ContentBlock[], acknowledge?: (error?: Error | null) => void, inputIds: readonly string[] = []): boolean => {
      if (!stdinOpen) return false;
      // A line written while a turn runs joins that turn instead of opening one (#505).
      const opensTurn = unsettled.size === 0;
      if (opensTurn) queuedTurnPending = false;
      agentInputReady = false;
      if (opensTurn) {
        pendingMarkerAsk = false;
        turnTextStart = textChunks.length;
      }
      // A follow-up inside the reopen window cancels the scheduled close.
      if (autoEndTimer) {
        clearTimeout(autoEndTimer);
        autoEndTimer = undefined;
      }
      const uuid = randomUUID();
      const line = JSON.stringify({
        type: 'user',
        uuid,
        message: { role: 'user', content },
        session_id: spec.sessionId,
      });
      try {
        child.stdin.write(`${line}\n`, acknowledge);
        unsettled.add(uuid);
        submissions.accept(uuid, inputIds, '');
        // A user message written to an idle session begins a turn (§7.1).
        if (opensTurn) emitUi(claudeTurnStarted);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onEvent?.({ type: 'note', message: `claude: stdin write failed: ${message}` });
        return false;
      }
    };

    // Set the moment WE signal the child — the EOF watchdog, a cancel, or the
    // wall-clock kill switch. claude installs its own SIGTERM handler and exits
    // 143 instead of dying from the signal, so without this flag our own
    // teardown reads as an agent failure (#703).
    let terminatedByCezar = false;
    const signalChild = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      terminatedByCezar = true;
      child.kill(signal);
    };
    // Every watchdog below asks "is the child still alive?" — and that question
    // is NOT `child.killed`, which only reports signal delivery. claude handles
    // SIGTERM itself, so `killed` is true while the process runs on; escalation
    // has to follow real termination or it never fires (#844).
    const hasExited = trackChildExit(child);

    const end = (): void => {
      if (!stdinOpen) return;
      stdinOpen = false;
      try {
        child.stdin.end();
      } catch {
        // already gone
      }
      eofTermTimer = setTimeout(() => {
        if (!hasExited()) signalChild('SIGTERM');
        eofKillTimer = setTimeout(() => {
          if (!hasExited()) signalChild('SIGKILL');
        }, EOF_KILL_GRACE_MS);
        eofKillTimer.unref?.();
      }, EOF_TERM_GRACE_MS);
      eofTermTimer.unref?.();
    };

    const interrupt = (): void => {
      stdinOpen = false;
      if (!hasExited()) signalChild('SIGTERM');
    };

    // Seed the first user message — the same path every follow-up takes.
    // Pasted task screenshots (spec.images) ride along as leading blocks.
    sendMessage([...(spec.images ?? []), { type: 'text', text: spec.userPrompt }]);

    const toolCalls: AgentToolCallRecord[] = [];
    let tokensUsed = 0;
    let sawUsage = false;
    let spawnFailed: Error | null = null;

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = wrapSpawnError(err, this.bin);
    });

    const stderrChunks: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    // Optional wall-clock kill switch (disabled for interactive sessions).
    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        timedOut = true;
        interrupt();
        child.stdout.destroy();
        killTimer = setTimeout(() => {
          if (!hasExited()) signalChild('SIGKILL');
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }, limitMs);
      deadline.unref?.();
    }

    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) {
          if (timedOut) break;
          let msg: ClaudeStreamMessage;
          try {
            msg = JSON.parse(line) as ClaudeStreamMessage;
          } catch {
            onEvent?.({ type: 'note', message: `claude: skipped unparseable stream line: ${truncate(line)}` });
            continue;
          }

          // Claude reports `error_during_execution` while reacting to our
          // teardown signal. Once cezar has signalled the child, that frame
          // describes the intentional stop rather than an agent failure.
          // Normalize only this precise wire shape so genuine result errors
          // (authentication, limits, malformed sessions) stay authoritative.
          if (queuedTurnPending && (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result')) {
            queuedTurnPending = false;
            emitUi(claudeTurnStarted);
          }
          // `--replay-user-messages` echoes a line when the model consumes it (#505).
          // Presentation-free: it is the user's own text, and it carries no tool_result.
          if (msg.type === 'user' && msg.isReplay === true) {
            const ids = typeof msg.uuid === 'string' ? submissions.consume(msg.uuid) : [];
            if (ids.length) opts.onAgentInputConsumed?.(ids);
            continue;
          }
          const mappedMessage = normalizeIntentionalTeardownResult(msg, terminatedByCezar);
          emitUi((state) => mapClaudeMessage(mappedMessage, state));

          let delta = 0;
          try {
            delta = handleClaudeMessage(mappedMessage, { toolCalls, textChunks, onEvent });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onEvent?.({ type: 'note', message: `claude: skipped malformed event (${msg.type ?? 'unknown'}): ${message}` });
            continue;
          }
          if (delta > 0) {
            sawUsage = true;
            tokensUsed += delta;
            onEvent?.({ type: 'token-usage', tokensUsed });
          }

          if (msg.type === 'result') {
            if (typeof msg.total_cost_usd === 'number' && msg.total_cost_usd > 0) {
              onEvent?.({ type: 'cost', usd: msg.total_cost_usd });
            }
            pendingMarkerAsk = parseAskMarker(textChunks.slice(turnTextStart).join('\n')) !== null;
            // The named lines are exact; `queued_turn_count: 0` is only a fallback, because a
            // line still in the pipe when the CLI computed this result is not covered by it.
            const settled = Array.isArray(msg.user_message_uuids) ? msg.user_message_uuids.map(String)
              : msg.queued_turn_count === 0 ? [...unsettled]
              : [...unsettled].slice(0, 1);
            // A line this result covered was read even if its replay echo was missed.
            // An error result settles its lines but proves nothing reached the model: they
            // stay pending, so a closing session returns them to the queue (#505 review).
            const covered = settled.flatMap(id => { unsettled.delete(id); return msg.is_error === true ? [] : submissions.consume(id); });
            if (covered.length) opts.onAgentInputConsumed?.(covered);
            // A result is not idle if human stdin messages already queued later turns.
            agentInputReady = unsettled.size === 0;
            onEvent?.({ type: 'turn-end' });
            scheduleAutoEnd();
            // A line written after this turn's last model call runs as the CLI's next
            // queued turn; its replay/result reports consumption then (#505). Announce
            // that turn when its first frame arrives, never speculatively: a line the
            // CLI never runs must not look like activity.
            queuedTurnPending = unsettled.size > 0;
          }
        }
      } catch (err) {
        // A timeout destroys stdout, which surfaces here as a premature-close
        // error — expected; rethrow anything else.
        if (!timedOut) throw err;
      } finally {
        if (deadline) clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        if (autoEndTimer) clearTimeout(autoEndTimer);
        stdinOpen = false;
      }

      const exitCode = await waitForExit(child);
      if (eofTermTimer) clearTimeout(eofTermTimer);
      if (eofKillTimer) clearTimeout(eofKillTimer);

      if (spawnFailed) throw spawnFailed;

      const text = textChunks.join('\n').trim();

      if (timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        onEvent?.({ type: 'error', message: `claude CLI timed out after ${mins}m and was killed` });
        onEvent?.({ type: 'done' });
        return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
      }

      // A session cezar itself tore down (EOF watchdog after `end()`, or a
      // cancel) exits 143/137 — that is our own signal coming back, not an
      // agent failure, so it settles on the normal path with a note (#703).
      if (terminatedByCezar && isSignalTerminationExit(exitCode)) {
        onEvent?.({
          type: 'note',
          message: `claude CLI did not exit on its own after close; terminated by cezar (code ${exitCode})`,
        });
        onEvent?.({ type: 'done' });
        return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
      }

      if (exitCode !== 0 && exitCode !== null) {
        const stderr = stderrChunks.join('').trim();
        const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
        const msg = `claude CLI exited with code ${exitCode}${detail}`;
        onEvent?.({ type: 'error', message: msg });
        throw new Error(msg);
      }

      if (!sawUsage) {
        onEvent?.({ type: 'note', message: 'token usage not reported by claude CLI' });
      }

      onEvent?.({ type: 'done' });
      return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      sendAgentMessage: (content, inputIds = []) => {
        // #505: allowed mid-turn — the CLI steers the line into the running turn.
        if (!stdinOpen || pendingMarkerAsk || agentWritePending) return false;
        let resolve!: () => void, reject!: (error: Error) => void;
        const acknowledged = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        agentWritePending = true;
        const closed = () => { agentWritePending = false; reject(new Error('claude closed before stdin delivery completed')); };
        child.once('close', closed);
        const sent = sendMessage(content, error => {
          child.off('close', closed);
          agentWritePending = false;
          if (error) reject(error);
          else resolve();
          if (stdinOpen && agentInputReady) { opts.onAgentInputReady?.(); scheduleAutoEnd(); }
        }, inputIds);
        if (!sent) { agentWritePending = false; child.off('close', closed); return false; }
        // Claude has no per-prompt RPC receipt: successful pipe write is the
        // transport boundary, not a promise that the model executed the input.
        return acknowledged;
      },
      discardQueuedMessages: () => undefined,
      end,
      interrupt,
      pid: child.pid,
      get open() {
        return stdinOpen;
      },
    };
    this.lastSession = session;
    return session;
  }
}

/**
 * Build the headless argv. `--input-format stream-json` reads user messages
 * from stdin; `--output-format stream-json --verbose` gives per-event NDJSON;
 * `--permission-mode dontAsk` keeps headless runs non-interactive: tools in
 * `--allowedTools` proceed and everything else is denied instead of prompting.
 * `CEZ_CLAUDE_PERMISSION_MODE` selects `dontAsk` / `acceptEdits` / `bypass`
 * (`bypass` emits `--dangerously-skip-permissions` instead). Unset or unknown
 * keeps today's path: `CEZ_APPROVAL_GATE=1` opts into `acceptEdits` (#435).
 * `CEZ_CLAUDE_SETTING_SOURCES` optionally adds `--setting-sources`.
 */
/** `--replay-user-messages` is the read signal (#505), but an older CLI rejects unknown
 * options at startup. Read the installed CLI's own `--help` once per binary; without the
 * flag, result coverage (`user_message_uuids`) still reports reads. */
const replaySupport = new Map<string, boolean>();
export function supportsReplayUserMessages(bin: string): boolean {
  const known = replaySupport.get(bin);
  if (known !== undefined) return known;
  let supported = false;
  try {
    supported = execFileSync(bin, ['--help'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })
      .includes('--replay-user-messages');
  } catch { supported = false; }
  replaySupport.set(bin, supported);
  return supported;
}

export function buildClaudeArgs(
  spec: AgentRunSpec,
  env: NodeJS.ProcessEnv = process.env,
  features: { replayUserMessages: boolean } = { replayUserMessages: true },
): string[] {
  const args: string[] = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  // Echo each stdin line when the model consumes it: the consumption signal (#505).
  if (features.replayUserMessages) args.push('--replay-user-messages');
  const permissionMode = env.CEZ_CLAUDE_PERMISSION_MODE;
  if (permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions');
  } else if (permissionMode === 'dontAsk' || permissionMode === 'acceptEdits') {
    args.push('--permission-mode', permissionMode);
  } else {
    args.push(
      '--permission-mode',
      env.CEZ_APPROVAL_GATE === '1' ? 'acceptEdits' : 'dontAsk',
    );
  }
  const settingSources = env.CEZ_CLAUDE_SETTING_SOURCES;
  if (settingSources) {
    args.push('--setting-sources', settingSources);
  }
  if (spec.systemPrompt) {
    args.push('--append-system-prompt', spec.systemPrompt);
  }
  // Pin the session so the user can `claude --resume <sessionId>` in the repo
  // to take over interactively after a run. With `resume` we reopen the
  // existing on-disk conversation instead.
  if (spec.sessionId) {
    if (spec.resume) {
      args.push('--resume', spec.sessionId);
    } else {
      args.push('--session-id', spec.sessionId);
    }
  }
  // Claude 2.1.260 --help: per-process deny rules; Agent is current, Task
  // remains the name in older harnesses/recorded fixtures. Never widen grants.
  if (spec.restrictNativeDelegation) args.push('--disallowedTools', 'Agent,Task');
  const allowed = buildAllowedTools(spec.allowedTools ?? [], spec.bashAllowlist);
  if (spec.cezarTools) {
    const { name, command, args: toolArgs } = spec.cezarTools;
    args.push('--mcp-config', JSON.stringify({ mcpServers: { [name]: {
      command, args: toolArgs,
      env: { CEZ_TOOL_TOKEN: '${CEZ_TOOL_TOKEN}', CEZ_TOOL_SOCKET: '${CEZ_TOOL_SOCKET}' },
    } } }));
    if (allowed.length > 0) allowed.push(`mcp__${name}__cezar_wait_for_ci`);
  }
  if (allowed.length > 0) {
    args.push('--allowedTools', allowed.join(','));
  }
  if (spec.model) {
    args.push('--model', spec.model);
  }
  const effort = parseEffort(spec.effort);
  if (effort) args.push('--effort', effort);
  for (const dir of spec.additionalDirectories ?? []) {
    args.push('--add-dir', dir);
  }
  return args;
}

/**
 * Map `allowedTools` onto claude's `--allowedTools` syntax. `Bash` with a
 * `bashAllowlist` becomes one `Bash(<prefix>:*)` entry per allowed prefix;
 * `Bash` with no allowlist stays plain `Bash`.
 */
export function buildAllowedTools(allowedTools: string[], bashAllowlist?: string[]): string[] {
  const out: string[] = [];
  for (const tool of allowedTools) {
    if (tool === 'Bash' && bashAllowlist && bashAllowlist.length > 0) {
      for (const prefix of bashAllowlist) {
        const p = prefix.trim();
        if (p) out.push(`Bash(${p}:*)`);
      }
    } else {
      out.push(tool);
    }
  }
  return out;
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Path to the bundled mock (`scripts/mock-claude.mjs`), for CEZ_DRY_RUN=1. */
function mockClaudePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-claude.mjs');
}

// ---- stream-json event handling -------------------------------------------

interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: {
    role?: string;
    content?: unknown[];
    usage?: RawUsage;
  };
  // `result` messages carry these at the top level.
  result?: string;
  usage?: RawUsage;
  is_error?: boolean;
  total_cost_usd?: number;
  /** #505: stdin echo at consumption (`--replay-user-messages`) and result coverage. */
  uuid?: string;
  isReplay?: boolean;
  user_message_uuids?: unknown[];
  queued_turn_count?: number;
}

function normalizeIntentionalTeardownResult(
  msg: ClaudeStreamMessage,
  terminatedByCezar: boolean,
): ClaudeStreamMessage {
  if (
    terminatedByCezar
    && msg.type === 'result'
    && msg.is_error === true
    && msg.subtype === 'error_during_execution'
  ) {
    return { ...msg, subtype: 'success', is_error: false };
  }
  return msg;
}

function handleClaudeMessage(
  msg: ClaudeStreamMessage,
  ctx: {
    toolCalls: AgentToolCallRecord[];
    textChunks: string[];
    onEvent?: (e: AgentEvent) => void;
  },
): number {
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        // The mapper keeps child text nested on v2. Neither v1 marker parsing
        // nor the result fallback buffer may consume it as parent prose (#149).
        if (typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id !== '') continue;
        ctx.textChunks.push(b.text);
        ctx.onEvent?.({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use' && b.id && b.name) {
        ctx.toolCalls.push({ id: b.id, name: b.name, input: b.input });
        ctx.onEvent?.({ type: 'tool-call', id: b.id, tool: b.name, input: b.input });
      }
    }
    // Assistant-frame usage belongs to the individual API calls inside this
    // agentic turn. Claude's terminal result frame already aggregates those
    // calls, so adding both sources inflates the run total (#716). Keep these
    // frames presentation-only; the result branch below is authoritative,
    // matching the v2 `usage.updated` mapping in AGENT_PROTOCOL.md.
    return 0;
  }

  if (msg.type === 'user' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        ctx.onEvent?.({
          type: 'tool-result',
          toolCallId: b.tool_use_id,
          result: stringifyToolResultContent(b.content),
          isError: b.is_error === true,
        });
        // Screenshots and other images inside the result get their own
        // events — the text path above renders them as a placeholder.
        for (const img of toolResultImageBlocks(b.content)) {
          ctx.onEvent?.({ type: 'image', mediaType: img.media_type, data: img.data });
        }
      }
    }
    return 0;
  }

  if (msg.type === 'result') {
    // Final message of a turn: `result` is the full assistant text; only fall
    // back to it if we never saw streamed assistant text blocks.
    if (typeof msg.result === 'string' && ctx.textChunks.length === 0) {
      ctx.textChunks.push(msg.result);
      ctx.onEvent?.({ type: 'text', text: msg.result });
    }
    if (msg.is_error) {
      ctx.onEvent?.({
        type: 'error',
        message: typeof msg.result === 'string' && msg.result.trim() !== ''
          ? msg.result
          : `claude reported result error${msg.subtype ? ` (${msg.subtype})` : ''}`,
      });
    }
    return costWeightedTokens(msg.usage);
  }

  // system/init and anything else: nothing actionable.
  return 0;
}

// stringify/image helpers moved to claude-ui-mapper.ts (shared by v1 and v2).

// ---- subprocess plumbing --------------------------------------------------

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    let done = false;
    const fin = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      resolve(code);
    };
    child.once('close', (code) => fin(code));
    child.once('exit', (code) => fin(code));
    // Don't swallow a late error as a clean null exit — fall back to the
    // child's own exit code (which is non-null/non-zero on failure).
    child.once('error', () => fin(child.exitCode ?? null));
    // A SIGKILLed process may never emit 'close' through some edge cases.
    const safety = setTimeout(
      () => fin(child.exitCode ?? null),
      EOF_TERM_GRACE_MS + EOF_KILL_GRACE_MS + KILL_GRACE_MS + 5_000,
    );
    safety.unref?.();
  });
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found on PATH — install Claude Code (https://claude.com/claude-code) and run \`claude\` once to log in`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
