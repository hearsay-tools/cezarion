import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseEffort } from '@open-mercato/cezar-contract';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { parseAskMarker } from './ask.ts';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
} from './agent-runner.js';
import { isSignalTerminationExit } from './agent-runner.js';
import { buildChildEnv } from './agent-env.js';
import { readNdjson } from './ndjson.js';
import { createPiUiState, mapPiRpcMessage, piProviderErrorMessage, piTurnStarted } from './pi-ui-mapper.js';
import { V1TextCoalescer } from './v1-text-coalescer.js';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 10_000;
const AUTO_END_DELAY_MS = 250;

export interface PiRunnerOptions {
  /** Override the binary name/path; defaults to `pi` on PATH (`CEZ_PI_BIN`). */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/**
 * Persistent subprocess adapter for pi's documented RPC mode.
 *
 * Contract: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
 * Pi has its own command/event vocabulary; it is not Claude stream-json.
 */
export class PiRunner implements AgentRunner {
  readonly backend = 'pi' as const;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: PiRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.CEZ_PI_BIN ?? (process.env.CEZ_DRY_RUN === '1' ? mockPiPath() : 'pi');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const child = nodeSpawn(this.bin, buildPiArgs(spec), {
      cwd: spec.cwd,
      env: buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
    });
    let open = true;
    let timedOut = false;
    let terminatedByCezar = false;
    let autoEndTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let piUi = createPiUiState();
    const textChunks: string[] = [];
    /** Streamed `text_delta` tokens buffered per content block — v1 `text` is
     *  one event per complete block (claude/codex/opencode parity), never per
     *  token. Token-by-token emission joined with newlines in `appendTurnText`
     *  split `CEZ:ASK` markers so `parseAskMarker` never matched (#902 / #2).
     *  Streaming display rides protocol v2's `item.delta`. */
    const textCoalescer = new V1TextCoalescer((text) => {
      textChunks.push(text);
      onEvent?.({ type: 'text', text });
    });
    /** Pi's `contentIndex` restarts at 0 on every assistant message; the
     *  coalescer latches completed keys for the session. Map each open index
     *  to a once-per-block id so a later message's index-0 is not dropped. */
    let textBlockSeq = 0;
    const openTextBlockKeys = new Map<number, string>();
    const textBlockKey = (contentIndex: unknown): string | undefined => {
      if (typeof contentIndex !== 'number') return undefined;
      let key = openTextBlockKeys.get(contentIndex);
      if (!key) {
        key = `pi-text-${++textBlockSeq}`;
        openTextBlockKeys.set(contentIndex, key);
      }
      return key;
    };
    /** flush() latches open keys as done — drop the index→key map too so a
     *  later contentIndex reuse allocates a fresh id instead of the dead one. */
    const flushText = (): void => {
      textCoalescer.flush();
      openTextBlockKeys.clear();
    };
    const toolCalls: AgentToolCallRecord[] = [];
    let sessionId = spec.sessionId;
    let tokensUsed = 0;
    let spawnError: Error | null = null;
    const stderr: string[] = [];

    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = wrapSpawnError(error, this.bin);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));

    const emitUi = (value: unknown): void => {
      const mapped = mapPiRpcMessage(value, piUi);
      piUi = mapped.state;
      for (const event of mapped.events) opts.onUiEvent?.(event);
    };
    const write = (command: Record<string, unknown>): boolean => {
      if (!open || !child.stdin.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
        return true;
      } catch {
        return false;
      }
    };
    let agentInputReady = false;
    let pendingMarkerAsk = false;
    let turnTextStart = 0;
    const sendMessage = (content: ContentBlock[]): boolean => {
      if (!open) return false;
      agentInputReady = false;
      pendingMarkerAsk = false;
      turnTextStart = textChunks.length;
      const { message, images } = toPiPrompt(content);
      if (autoEndTimer) {
        clearTimeout(autoEndTimer);
        autoEndTimer = undefined;
      }
      if (
        !write({
          type: 'prompt',
          message,
          ...(images.length > 0 ? { images } : {}),
          ...(piUi.turnId ? { streamingBehavior: 'steer' } : {}),
        })
      ) {
        return false;
      }
      if (!piUi.turnId) {
        const mapped = piTurnStarted(piUi);
        piUi = mapped.state;
        for (const event of mapped.events) opts.onUiEvent?.(event);
      }
      return true;
    };
    const end = (): void => {
      if (!open) return;
      open = false;
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
      write({ type: 'abort' });
      open = false;
      terminatedByCezar = true;
      child.kill('SIGTERM');
    };

    write({ id: 'cezar-state', type: 'get_state' });
    sendMessage([
      ...(spec.images ?? []),
      {
        type: 'text',
        text: spec.userPrompt,
      },
    ]);

    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    const deadline =
      limitMs > 0
        ? setTimeout(() => {
            timedOut = true;
            interrupt();
          }, limitMs)
        : undefined;
    deadline?.unref?.();

    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            onEvent?.({ type: 'note', message: `pi: skipped unparseable RPC line: ${truncate(line)}` });
            continue;
          }
          // Flush before real message/tool/turn boundaries so v2 UI events
          // never overtake a pending block. Do NOT flush on prompt/response
          // acks — mid-turn `steer` can land between text_deltas and would
          // split one block into partial + full (and clear the live key).
          if (
            isRecord(value) &&
            (value.type === 'tool_execution_start' ||
              value.type === 'message_end' ||
              value.type === 'agent_settled' ||
              value.type === 'turn_end' ||
              value.type === 'agent_end')
          ) {
            flushText();
          }
          emitUi(value);
          if (!isRecord(value)) continue;

          if (value.type === 'response' && value.command === 'get_state' && value.success === true && isRecord(value.data)) {
            const discovered = string(value.data.sessionId);
            if (discovered && discovered !== sessionId) {
              sessionId = discovered;
              onEvent?.({ type: 'session', sessionId: discovered });
            }
          } else if (value.type === 'response' && value.success === false) {
            onEvent?.({ type: 'error', message: rpcError(value) });
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
              if (usage.cost > 0) onEvent?.({ type: 'cost', usd: usage.cost });
            }
            if (string(value.message.stopReason) === 'error') {
              onEvent?.({ type: 'error', message: piProviderErrorMessage(value.message) });
            }
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
          } else if (value.type === 'agent_settled') {
            flushText();
            pendingMarkerAsk = parseAskMarker(textChunks.slice(turnTextStart).join('\n')) !== null;
            agentInputReady = true;
            onEvent?.({ type: 'turn-end' });
            if (opts.autoEndAfterFirstTurn && open && !autoEndTimer) {
              autoEndTimer = setTimeout(() => {
                autoEndTimer = undefined;
                if (opts.shouldAutoEnd?.() !== false) end();
              }, AUTO_END_DELAY_MS);
              autoEndTimer.unref?.();
            }
          } else if (value.type === 'extension_error') {
            onEvent?.({ type: 'note', message: string(value.error) ?? 'pi extension error' });
          }
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        if (autoEndTimer) clearTimeout(autoEndTimer);
        if (killTimer) clearTimeout(killTimer);
        open = false;
      }

      flushText();
      const exitCode = await waitForExit(child);
      if (spawnError) throw spawnError;
      if (timedOut) {
        const message = `pi CLI timed out after ${Math.round((limitMs / 60_000) * 10) / 10}m and was killed`;
        onEvent?.({ type: 'error', message });
        onEvent?.({ type: 'done' });
        return { text: textChunks.join('\n').trim(), toolCalls, tokensUsed, sessionId };
      }
      // A signal we sent is teardown, not a second agent failure (#73).
      if (terminatedByCezar && isSignalTerminationExit(exitCode)) {
        onEvent?.({
          type: 'note',
          message: `pi CLI did not exit on its own after close; terminated by cezar (code ${exitCode})`,
        });
      } else if (exitCode !== 0 && exitCode !== null) {
        const detail = stderr.join('').trim().split('\n').slice(-3).join(' | ');
        const message = `pi CLI exited with code ${exitCode}${detail ? ` — ${detail}` : ''}`;
        onEvent?.({ type: 'error', message });
        throw new Error(message);
      }
      if (piUi.turnId) onEvent?.({ type: 'note', message: 'pi RPC session ended before agent_settled' });
      if (tokensUsed === 0) onEvent?.({ type: 'note', message: 'token usage not reported by pi CLI' });
      opts.onUiEvent?.({ type: 'session.ended', reason: piUi.stopReason });
      onEvent?.({ type: 'done' });
      return { text: textChunks.join('\n').trim(), toolCalls, tokensUsed, sessionId };
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      sendAgentMessage: (content) => {
        if (!agentInputReady || piUi.turnId || pendingMarkerAsk) return false;
        return sendMessage(content);
      },
      discardQueuedMessages: () => undefined,
      end,
      interrupt,
      pid: child.pid,
      get open() {
        return open;
      },
    };
    this.lastSession = session;
    return session;
  }
}

export function buildPiArgs(spec: AgentRunSpec): string[] {
  const args = ['--mode', 'rpc'];
  if (spec.sessionId) args.push(spec.resume ? '--session' : '--session-id', spec.sessionId);
  if (spec.systemPrompt) args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.model) args.push('--model', spec.model);
  const effort = parseEffort(spec.effort);
  if (effort) args.push('--thinking', effort);
  const tools = piTools(spec.allowedTools ?? [], spec.bashAllowlist);
  if (tools.length > 0) args.push('--tools', tools.join(','));
  return args;
}

function piTools(tools: string[], bashAllowlist?: string[]): string[] {
  const map: Readonly<Record<string, string>> = {
    Read: 'read',
    Bash: 'bash',
    Edit: 'edit',
    Write: 'write',
    Grep: 'grep',
    Glob: 'find',
    Subagent: 'subagent',
    SubagentSupervisor: 'subagent_supervisor',
    SubagentWait: 'subagent_wait',
  };
  return [
    ...new Set(
      tools
        // Pi can allow/deny the whole bash tool but has no command-prefix
        // equivalent. Fail closed when a workflow requests that narrower mode.
        .filter((tool) => tool !== 'Bash' || !bashAllowlist || bashAllowlist.length === 0)
        .map((tool) => map[tool] ?? tool.toLowerCase()),
    ),
  ];
}

function toPiPrompt(content: ContentBlock[]): {
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

function usageValues(value: unknown): { weighted: number; cost: number } | undefined {
  if (!isRecord(value)) return undefined;
  const input = number(value.input) ?? 0;
  const output = number(value.output) ?? 0;
  const cacheRead = number(value.cacheRead) ?? 0;
  const cacheWrite = number(value.cacheWrite) ?? 0;
  const cost = isRecord(value.cost) ? number(value.cost.total) ?? 0 : 0;
  return { weighted: Math.round(input + output + cacheRead * 0.1 + cacheWrite * 1.25), cost };
}

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

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => (isRecord(part) && part.type === 'text' ? string(part.text) : undefined))
    .filter((part): part is string => part !== undefined);
  return text.length > 0 ? text.join('\n') : undefined;
}

function rpcError(value: Record<string, unknown>): string {
  const error = isRecord(value.error) ? value.error : undefined;
  return string(error?.message) ?? string(value.message) ?? `pi RPC command ${string(value.command) ?? 'unknown'} failed`;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('close', resolve));
}

function wrapSpawnError(error: NodeJS.ErrnoException, bin: string): Error {
  if (error.code === 'ENOENT') {
    return new Error(`\`${bin}\` not found on PATH — install pi and run \`pi\` once to configure a provider`);
  }
  return error;
}

/** Path to the bundled mock (`scripts/mock-pi-rpc.mjs`), for CEZ_DRY_RUN=1. */
function mockPiPath(): string {
  // Resolved the same way `mockClaudePath` is, rather than through `new URL().pathname`:
  // on Windows that yields a leading-slash `/C:/…` which `spawn` cannot execute.
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-pi-rpc.mjs');
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
