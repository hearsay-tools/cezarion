import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEffort } from '@open-mercato/cezar-contract/effort';
import { isRecord, number, parseRpcLine, piRpcError as rpcError, string, toPiPrompt, truncate, waitForExit } from './pi-rpc-wire.ts';
import {
  adoptRpcSessionId,
  armEndWatchdog,
  dispatchPiTurnMessage,
  type PiEndWatchdog,
  PiRpcInput,
  PiTextBlocks,
  type PiTurnMessages,
  settlePiFamilyExit,
} from './pi-rpc-turn.ts';
import { summarizeRunnerStderr } from './runner-stderr.ts';
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
import { unknownToolGrant } from './agent-runner.js';
import { signalSession, spawnSessionLeader, waitForEofExit } from './session-process.js';
import { buildChildEnv } from './agent-env.js';
import { cezarToolNames } from '../ci-wait/tools.js';
import { readNdjson } from './ndjson.js';
import { createPiUiState, mapPiRpcMessage, piFlushProviderError, piProviderErrorMessage, piTurnStarted } from './pi-ui-mapper.js';
import { boundOutputDrainAfterExit, DEFAULT_RUN_TIMEOUT_MS, KILL_GRACE_MS } from './runner-runtime.js';

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
/**
 * What the pi CLI receives from each `AgentRunSpec` field (#284). Tool names
 * are mapped onto pi's own through `piTools`. An unset grant sends no tool
 * flags; a grant's list takes one of three paths (hearsay-tools/cezarion#1305). A list holding every default
 * built-in and nothing beyond pi's default set sends no allowlist:
 * `--no-builtin-tools` plus the default-tools extension, which activates the
 * listed built-ins, so MCP and extension tools stay callable. A narrowed list
 * keeps the `--tools` allowlist; naming any other tool (an `mcp__` tool, for
 * one) narrows it, so that grant stays limited to the named tools. A list that
 * maps to nothing fails closed: `--tools` with
 * only the cezar tools, or `--no-tools`. pi has no command-prefix equivalent
 * for a `bashAllowlist`, so a list with one narrows to `--tools` and drops
 * `bash` (fail closed) rather than widening. Held against the recorded
 * argv and RPC prompt by the harness parity matrix.
 */
export const PI_SPEC_SUPPORT: AgentRunSpecSupport = {
  cezarTools: { honored: true, via: 'explicit CI --extension and selected tool admission' },
  systemPrompt: { honored: true, via: '--append-system-prompt' },
  userPrompt: { honored: true, via: 'RPC prompt message' },
  images: { honored: true, via: 'RPC prompt images' },
  cwd: { honored: true, via: 'spawn cwd' },
  toolGrant: { honored: true, via: 'mapped through piTools: the default list sends --no-builtin-tools and names its built-ins to the default-tools extension; a narrowed list, or one naming a tool outside the pi default set, sends --tools; a list that maps to nothing sends --tools with the cezar tools only, or --no-tools; a bashAllowlist has no prefix equivalent, so it narrows the list to --tools without bash (fail closed); unset sends no tool flags' },
  restrictCrossSessionMessaging: { honored: false, reason: 'pi 1.4.0 has no built-in cross-session tool, and an extension\'s name cannot be discovered as messaging; the subagent extension stays (hearsay-tools/cezarion#2279)' },
  additionalDirectories: { honored: false, reason: 'pi has no extra-root flag' },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: '--model provider/model' },
  effort: { honored: true, via: '--thinking, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch on the child process' },
  sessionId: { honored: true, via: '--session-id, or --session when resume is set' },
  resume: { honored: true, via: '--session <sessionId> in place of --session-id' },
  resumeFallbackSystemPrompt: { honored: false, reason: 'Continue already resends spec.systemPrompt on every process; a separate fallback prompt is unused' },
};
export class PiRunner implements AgentRunner {
  readonly backend = 'pi' as const;
  readonly specSupport = PI_SPEC_SUPPORT;
  readonly systemPromptOnResume = 'resent' as const;
  readonly inputDelivery: InputDelivery = {
    mode: 'steer', consumption: 'observable',
    via: 'prompt with streamingBehavior steer; set_steering_mode all at session start; user message_start with the submitted text',
  };
  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: PiRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.CEZ_PI_BIN ?? (process.env.CEZ_DRY_RUN === '1' ? mockPiPath() : 'pi');
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
    const child = spawnSessionLeader(this.bin, buildPiArgs(spec), {
      cwd: spec.cwd,
      env: buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
    });
    boundOutputDrainAfterExit(child);
    let open = true;
    let timedOut = false;
    let terminatedByCezar = false;
    let explicitEnd = false;
    let automaticCleanupStarted = false;
    let killWatchdog: PiEndWatchdog | undefined;
    let interruptKillTimer: NodeJS.Timeout | undefined;
    let piUi = createPiUiState();
    const textChunks: string[] = [];
    const textBlocks = new PiTextBlocks('pi-text', textChunks, onEvent);
    const flushText = (): void => textBlocks.flush();
    const toolCalls: AgentToolCallRecord[] = [];
    let sessionId = spec.sessionId;
    let tokensUsed = 0;
    let inputError: Error | undefined;
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
      for (const event of mapped.events) {
        opts.onUiEvent?.(event);
        if (event.type === 'turn.started') releaseHeldIntoTurn();
      }
    };
    /** The mapper latches a provider failure until the turn settles; when the RPC
     *  stream ends without `agent_settled` this releases it the way v1 does. */
    const emitLatchedUiProviderError = (): void => {
      const mapped = piFlushProviderError(piUi);
      piUi = mapped.state;
      for (const event of mapped.events) opts.onUiEvent?.(event);
    };
    const write = (command: Record<string, unknown>): boolean => {
      if (!open || !child.stdin.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
        return true;
      } catch (error) {
        failInput(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    };
    let humanPromptAcks = 0;
    // Agent input readiness, the pending agent receipt, carried input, the turn-end step and
    // auto-end live in the shared Pi-family core.
    const rpcInput = new PiRpcInput({
      cli: 'pi',
      opts,
      onEvent,
      isOpen: () => open,
      turnId: () => piUi.turnId,
      humanAcksPending: () => humanPromptAcks > 0,
      end: () => end(),
      flushText,
    });
    // Each human prompt stays held from its write until a normalized turn has it, because an
    // ack is not a turn boundary (hearsay-tools/cezarion#1112). Exits: its user message_start
    // (the running turn read it), its ack while the turn it opened is still open, the first
    // turn.started after its ack, a rejected ack, or discardQueuedMessages. A raw agent_start
    // is not an exit: pi's mapper reports nothing for it, so a run released there could park
    // before the turn that reads the prompt is reported. A steer acked after the turn's last
    // model call is read as pi's next prompt, after agent_settled, so the ack alone never
    // releases it.
    const humanHeld: Array<{ text: string; acked: boolean; turnId?: string | undefined }> = [];
    /** A turn.started was just emitted: it reads every human prompt pi acknowledged before it. */
    function releaseHeldIntoTurn(): void {
      for (let at = humanHeld.length - 1; at >= 0; at--) if (humanHeld[at]!.acked) humanHeld.splice(at, 1);
    }
    const failInput = (error: Error): void => {
      // Late errors from caller close/abort/deadline teardown are not new failures.
      if (!open || terminatedByCezar || inputError) return;
      inputError = new Error(`pi input stream failed: ${error.message}`);
      open = false;
      rpcInput.rejectAgentAck(inputError);
      onEvent?.({ type: 'error', message: inputError.message });
      opts.onUiEvent?.({ type: 'session.error', message: inputError.message, fatal: true });
      // The output-loop catch owns the existing bounded process cleanup. The latch
      // also prevents false success if the child exits zero before it observes this.
      child.stdout.destroy(inputError);
    };
    child.stdin.on('error', failInput);
    const sendMessage = (content: ContentBlock[], requestId?: string, inputIds: readonly string[] = []): boolean => {
      if (!open) return false;
      // A steer joins the running turn; only an idle prompt opens one (#505).
      const opensTurn = !piUi.turnId;
      rpcInput.beginPrompt();
      const { message, images } = toPiPrompt(content);
      rpcInput.cancelAutoEnd();
      if (
        !write({
          type: 'prompt',
          ...(requestId ? { id: requestId } : {}),
          message,
          ...(images.length > 0 ? { images } : {}),
          ...(piUi.turnId ? { streamingBehavior: 'steer' } : {}),
        })
      ) {
        return false;
      }
      if (requestId) rpcInput.submissions.accept(requestId, inputIds, message);
      if (!piUi.turnId) {
        const mapped = piTurnStarted(piUi);
        piUi = mapped.state;
        for (const event of mapped.events) opts.onUiEvent?.(event);
      }
      // An idle prompt names the turn it opened: its ack releases it while that turn is open.
      if (!requestId) {
        humanPromptAcks += 1;
        humanHeld.push({ text: message, acked: false, ...(opensTurn ? { turnId: piUi.turnId ?? undefined } : {}) });
      }
      return true;
    };
    const end = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        explicitEnd = true;
        terminatedByCezar ||= automaticCleanupStarted;
      }
      if (!open) return;
      open = false;
      rpcInput.rejectAgentAck();
      child.stdin.end();
      killWatchdog = armEndWatchdog(() => child, KILL_GRACE_MS, () => { terminatedByCezar = true; });
    };
    const interrupt = (): void => {
      if (child.exitCode === null && child.signalCode === null) terminatedByCezar = true;
      if (!open) return;
      // Mark intent before the abort write: even a synchronous write failure is teardown.
      terminatedByCezar = true;
      write({ type: 'abort' });
      open = false;
      rpcInput.rejectAgentAck();
      signalSession(child, 'SIGTERM');
      interruptKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalSession(child, 'SIGKILL');
      }, KILL_GRACE_MS);
      interruptKillTimer.unref?.();
    };

    write({ id: 'cezar-state', type: 'get_state' });
    // #551: Pi defaults steeringMode to one-at-a-time (one steer per completed
    // assistant turn). This session is cezar's, and sendAgentMessage requires every
    // accepted steer at the next model call. get_state cannot tell that default
    // from an explicit user setting, so we always set all rather than guess.
    write({ type: 'set_steering_mode', mode: 'all' });
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

    const terminateAfterOutput = (): NodeJS.Timeout => {
      signalSession(child, 'SIGTERM');
      const reap = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalSession(child, 'SIGKILL');
      }, KILL_GRACE_MS);
      reap.unref?.();
      return reap;
    };

    // EOF retains the existing grace and escalation order. Only attribution depends on evidence.
    const cleanupAfterEof = async (): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) {
        const state = await waitForEofExit(child);
        if (state !== 'exited') {
          automaticCleanupStarted = true;
          terminatedByCezar ||= explicitEnd || state === 'live';
          terminateAfterOutput();
        }
      }
    };

    const countUsage = (message: Record<string, unknown>): void => {
      const usage = usageValues(message.usage);
      if (usage) {
        tokensUsed += usage.weighted;
        onEvent?.({ type: 'token-usage', tokensUsed });
        if (usage.cost !== undefined) onEvent?.({ type: 'cost', usd: usage.cost });
      }
    };
    // A user message pi read with no normalized turn open (a late steer's own run): the run is
    // not reported yet, so the prompt stays held until that turn.started.
    const settleHumanPromptRead = (text: string): void => {
      const human = humanHeld.findIndex(entry => entry.text === text);
      if (human >= 0 && piUi.turnId) humanHeld.splice(human, 1);
      else if (human >= 0) humanHeld[human]!.acked = true;
    };
    const turnMessages: PiTurnMessages = {
      input: rpcInput,
      textBlocks,
      toolCalls,
      onEvent,
      flushText,
      assistantMessageEnded: countUsage,
      providerErrorMessage: piProviderErrorMessage,
      humanPromptRead: settleHumanPromptRead,
    };

    // Human prompts carry no id, so acks answer them in write order. A second ack for
    // a prompt pi already answered (a late steer re-run) finds no ack outstanding.
    const settleHumanAck = (value: Record<string, unknown>): void => {
      const held = humanPromptAcks > 0 ? humanHeld.find(entry => !entry.acked) : undefined;
      humanPromptAcks = Math.max(0, humanPromptAcks - 1);
      if (held && value.success === true && (!held.turnId || held.turnId !== piUi.turnId)) held.acked = true;
      else if (held) humanHeld.splice(humanHeld.indexOf(held), 1);
      if (value.success === false) onEvent?.({ type: 'error', message: rpcError(value) });
    };
    const settlePromptAck = (value: Record<string, unknown>): void => {
      const pending = rpcInput.takeAgentAck(value.id);
      if (pending) {
        if (value.success === true) rpcInput.acceptAgentAck(pending);
        else {
          const message = rpcError(value);
          if (open) onEvent?.({ type: 'error', message });
          pending.reject(new Error(message));
        }
      } else if (value.id === undefined) {
        settleHumanAck(value);
      }
      rpcInput.readyAfterAck();
    };
    // A failed get_state has no branch of its own: it is reported like any other failed command.
    const handleResponse = (value: Record<string, unknown>): void => {
      if (value.command === 'get_state' && value.success === true && isRecord(value.data)) {
        adoptRpcSessionId(value.data, sessionId, (id) => { sessionId = id; }, onEvent);
      } else if (value.command === 'set_steering_mode') {
        if (value.success !== true) {
          onEvent?.({ type: 'note', message: `pi: set_steering_mode failed: ${rpcError(value)}` });
        }
      } else if (value.command === 'prompt') {
        settlePromptAck(value);
      } else if (value.success === false) {
        onEvent?.({ type: 'error', message: rpcError(value) });
      }
    };
    // Each type has one case, and the shared dispatch reads the rest. A message a guard refuses
    // ends there, as it did when this was one if/else chain: no later case reads the same type.
    const dispatchNative = (value: Record<string, unknown>): void => {
      switch (value.type) {
        case 'response': handleResponse(value); break;
        case 'agent_settled': rpcInput.settleTurn(); break;
        case 'extension_error': onEvent?.({ type: 'note', message: string(value.error) ?? 'pi extension error' }); break;
        default: dispatchPiTurnMessage(value, turnMessages);
      }
    };
    const handleOutputLine = (line: string): void => {
      const value = parseRpcLine(line);
      if (value === undefined) {
        onEvent?.({ type: 'note', message: `pi: skipped unparseable RPC line: ${truncate(line)}` });
        return;
      }
      restorePiMessageEndError(value);
      opts.onActivity?.();
      // Flush before real message/tool/turn boundaries so v2 UI events
      // never overtake a pending block. Do NOT flush on prompt/response
      // acks — mid-turn `steer` can land between text_deltas and would
      // split one block into partial + full (and clear the live key).
      if (isRecord(value) && PI_TEXT_BOUNDARY_TYPES.has(value.type)) flushText();
      emitUi(value);
      if (isRecord(value)) dispatchNative(value);
    };
    const settleExit = (exitCode: number | null): AgentRunResult => {
      if (spawnError) throw spawnError;
      if (inputError) throw inputError;
      return settlePiFamilyExit({
        cli: 'pi',
        settleEvent: 'agent_settled',
        exitCode,
        signalCode: child.signalCode,
        terminatedByCezar,
        timedOut,
        limitMs,
        stderr,
        stderrDetail: summarizeRunnerStderr,
        turnOpen: Boolean(piUi.turnId),
        tokensUsed,
        stopReason: piUi.stopReason,
        emitUi: (event) => opts.onUiEvent?.(event),
        onEvent,
        result: () => ({ text: textChunks.join('\n').trim(), toolCalls, tokensUsed, sessionId }),
      });
    };

    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) handleOutputLine(line);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          // Revoke input immediately, but keep result pending until the agent
          // has actually exited so its capacity cannot be released early.
          open = false;
          rpcInput.rejectAgentAck();
          terminatedByCezar = true;
          const reap = terminateAfterOutput();
          await waitForExit(child);
          clearTimeout(reap);
          throw error;
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        rpcInput.stopAutoEndTimer();
        open = false;
        rpcInput.rejectAgentAck();
      }

      await cleanupAfterEof();

      flushText();
      rpcInput.emitLatchedProviderError();
      emitLatchedUiProviderError();
      const exitCode = await waitForExit(child);
      killWatchdog?.clear();
      if (interruptKillTimer) clearTimeout(interruptKillTimer);
      return settleExit(exitCode);
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      // A synchronous transport failure already rejected the receipt, so it is still returned.
      sendAgentMessage: (content, inputIds = []) =>
        rpcInput.sendAgentMessage(content, inputIds, sendMessage, () => Boolean(inputError)),
      // A written prompt cannot be unwritten; only stop reporting an acknowledged one as held.
      discardQueuedMessages: () => { humanHeld.length = 0; },
      holdsHumanInput: () => humanHeld.length > 0,
      heldHumanInputCount: () => humanHeld.length,
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
  // pi loads a repo's .pi/skills and .agents/skills only for a trusted folder; the project-skills
  // extension offers them to an untrusted one without trusting it (hearsay-tools/cezarion#1295).
  const args = ['--mode', 'rpc', '--extension', piDegradedServiceRetryExtensionPath(), '--extension', piProjectSkillsExtensionPath()];
  if (spec.cezarTools) args.push('--extension', fileURLToPath(new URL('../../scripts/pi-ci-wait.mjs', import.meta.url)));
  if (spec.sessionId) args.push(spec.resume ? '--session' : '--session-id', spec.sessionId);
  if (spec.systemPrompt) args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.model) args.push('--model', spec.model);
  const effort = parseEffort(spec.effort);
  if (effort) args.push('--thinking', effort);
  args.push(...piGrantArgs(spec, spec.toolGrant));
  return args;
}

/** pi's tool flags for each grant kind. No list keeps pi's own tool set, MCP and extension tools included. */
function piGrantArgs(spec: AgentRunSpec, grant: ToolGrant): string[] {
  switch (grant.kind) {
    case 'unset': return [];
    case 'step-default':
    case 'inherited': return piToolArgs(spec, grant.tools, grant.bashAllowlist);
    // A written copy of the default list takes the default path too, so no list keeps MCP and
    // extension tools out of a step that names only the default built-ins (hearsay-tools/cezarion#1417).
    case 'explicit': return piToolArgs(spec, grant.tools, grant.bashAllowlist);
    default: return unknownToolGrant(grant);
  }
}

// The built-ins cezar's default list maps onto (DEFAULT_ALLOWED_TOOLS through piTools), and the
// names a default list may hold besides them (HARNESS_EXTRA_TOOLS.pi).
const PI_DEFAULT_BUILTINS = ['read', 'edit', 'write', 'grep', 'find', 'bash'];
const PI_DEFAULT_EXTRAS = ['subagent', 'subagent_supervisor', 'subagent_wait'];

/**
 * pi reads --tools as an allowlist that hides every tool it does not name, MCP and extension tools
 * included (hearsay-tools/cezarion#1305). So the default list sends no allowlist: --no-builtin-tools
 * keeps every tool registered and the default-tools extension activates the listed built-ins. The
 * default list holds every base built-in and nothing beyond pi's default set, so it covers both
 * pi's own step default and the six tools a worker inherits from a Claude parent. Any other name
 * (an mcp__ tool, WebFetch, a custom tool) or a bashAllowlist narrows the list to the allowlist, so
 * a step that grants named tools gets only those, and a list that maps to nothing fails closed.
 */
function piToolArgs(spec: AgentRunSpec, allowedTools: readonly string[], bashAllowlist: readonly string[] | undefined): string[] {
  const narrowedBash = (bashAllowlist?.length ?? 0) > 0;
  const tools = piTools(allowedTools, bashAllowlist);
  const isDefault = PI_DEFAULT_BUILTINS.every((tool) => tools.includes(tool))
    && tools.every((tool) => PI_DEFAULT_BUILTINS.includes(tool) || PI_DEFAULT_EXTRAS.includes(tool));
  if (!narrowedBash && isDefault) {
    // The cezar tools need no name: pi activates an extension's tools on registration.
    return ['--no-builtin-tools', '--extension', piDefaultToolsExtensionPath(), '--cezar-builtin-tools', tools.join(',')];
  }
  if (spec.cezarTools) tools.push(...cezarToolNames(spec.env ?? {}));
  return tools.length > 0 ? ['--tools', tools.join(',')] : ['--no-tools'];
}

function piDegradedServiceRetryExtensionPath(): string {
  return fileURLToPath(new URL('../../scripts/pi-retry-degraded-service.mjs', import.meta.url));
}

function piProjectSkillsExtensionPath(): string {
  return fileURLToPath(new URL('../../scripts/pi-project-skills.mjs', import.meta.url));
}

function piDefaultToolsExtensionPath(): string {
  return fileURLToPath(new URL('../../scripts/pi-default-tools.mjs', import.meta.url));
}

/** Native message types that end a text block; a prompt or response ack is not one. */
const PI_TEXT_BOUNDARY_TYPES: ReadonlySet<unknown> = new Set(['tool_execution_start', 'message_end', 'agent_settled', 'turn_end', 'agent_end']);

/** Restores pi's own wording in a message_end error before any reader sees the line. */
function restorePiMessageEndError(value: unknown): void {
  if (
    isRecord(value) &&
    value.type === 'message_end' &&
    isRecord(value.message) &&
    typeof value.message.errorMessage === 'string'
  ) {
    value.message.errorMessage = restorePiDegradedServiceError(value.message.errorMessage);
  }
}

function restorePiDegradedServiceError(errorMessage: string): string {
  const retryHint = '[cezar:retry-xai-degraded] Service unavailable: ';
  return errorMessage.startsWith(retryHint) ? errorMessage.slice(retryHint.length) : errorMessage;
}

function piTools(tools: readonly string[], bashAllowlist: readonly string[] | undefined): string[] {
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
