import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEvent, AgentRunResult, AgentToolCallRecord, ContentBlock, SessionOptions } from './agent-runner.js';
import { isSignalTerminationExit } from './agent-runner.js';
import { InputSubmissions } from './input-submissions.ts';
import { contentText, emitImages, isRecord, piMessageText, string } from './pi-rpc-wire.ts';
import { AUTO_END_DELAY_MS } from './runner-runtime.js';
import { signalSession } from './session-process.js';
import type { UiEvent } from './ui-events.js';
import { V1TextCoalescer } from './v1-text-coalescer.js';

/**
 * Turn and input bookkeeping that the Pi-family RPC runners share: pi (`pi-runner.ts`) and its
 * fork omp (`omp-runner.ts`) read the same native messages and accept agent input the same way
 * (hearsay-tools/cezarion#2006). Each runner keeps its own message dispatch, its own human-prompt
 * tracking and its own process lifecycle, and calls these at the same points as before.
 */

/**
 * Streamed `text_delta` tokens buffered per content block. v1 `text` is one event per complete
 * block (claude/codex/opencode parity), never per token: token-by-token emission split text
 * markers across events (open-mercato/cezar#902, hearsay-tools/cezarion#2). Streaming display rides
 * protocol v2's `item.delta`.
 *
 * A message's `contentIndex` restarts at 0 on every assistant message, while the coalescer
 * latches completed keys for the session. So each open index maps to a once-per-block id, and
 * a later message's index 0 is not dropped.
 */
export class PiTextBlocks {
  private readonly coalescer: V1TextCoalescer;
  private readonly open = new Map<number, string>();
  private seq = 0;

  /** Each completed block is appended to the run's `textChunks`, then emitted as v1 `text`. */
  constructor(private readonly keyPrefix: string, textChunks: string[], onEvent?: (event: AgentEvent) => void) {
    this.coalescer = new V1TextCoalescer((text) => {
      textChunks.push(text);
      onEvent?.({ type: 'text', text });
    });
  }

  /** One `message_update`'s `assistantMessageEvent`: a `text_delta` buffers, a `text_end` completes. */
  update(update: Record<string, unknown>): void {
    const contentKey = this.key(update.contentIndex);
    if (update.type === 'text_delta' && typeof update.delta === 'string') {
      this.coalescer.append(contentKey, update.delta);
    } else if (update.type === 'text_end') {
      const snapshot = typeof update.content === 'string' ? update.content : undefined;
      this.coalescer.complete(contentKey, snapshot);
      if (typeof update.contentIndex === 'number') this.open.delete(update.contentIndex);
    }
  }

  /** flush() latches open keys as done, so the index map is dropped too: a later reuse of an
   *  index gets a fresh id instead of the dead one. */
  flush(): void {
    this.coalescer.flush();
    this.open.clear();
  }

  private key(contentIndex: unknown): string | undefined {
    if (typeof contentIndex !== 'number') return undefined;
    let key = this.open.get(contentIndex);
    if (!key) {
      key = `${this.keyPrefix}-${++this.seq}`;
      this.open.set(contentIndex, key);
    }
    return key;
  }
}

/** A `tool_execution_start` with an id and a name: record the call and emit `tool-call`. */
export function recordPiToolCall(
  value: Record<string, unknown>,
  toolCalls: AgentToolCallRecord[],
  onEvent?: (event: AgentEvent) => void,
): void {
  const id = string(value.toolCallId);
  const name = string(value.toolName);
  if (id && name) {
    toolCalls.push({ id, name, input: value.args });
    onEvent?.({ type: 'tool-call', id, tool: name, input: value.args });
  }
}

/** A `tool_execution_end` with an id: emit `tool-result`, then the images in its content. */
export function emitPiToolResult(value: Record<string, unknown>, onEvent?: (event: AgentEvent) => void): void {
  const id = string(value.toolCallId);
  if (!id) return;
  const content = isRecord(value.result) ? value.result.content : undefined;
  onEvent?.({ type: 'tool-result', toolCallId: id, result: contentText(content) ?? '', isError: value.isError === true });
  emitImages(content, onEvent);
}

/** The receipt of one agent prompt, settled by its RPC acknowledgement. */
export interface PiAgentAck {
  id: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** What the input core reads from and calls in the runner that owns the session. */
export interface PiRpcInputHost {
  /** Names the runner in the error a pending receipt gets when the session closes. */
  cli: 'pi' | 'omp';
  opts: SessionOptions;
  onEvent?: ((event: AgentEvent) => void) | undefined;
  isOpen(): boolean;
  /** The mapper's open normalized turn, if any. */
  turnId(): string | null;
  /** A human prompt is written and not yet acknowledged. */
  humanAcksPending(): boolean;
  end(): void;
  flushText(): void;
}

/**
 * Agent input and turn boundaries of one Pi-family session: readiness for agent input, the
 * pending agent receipt, the input a turn carried, the turn-end step and the auto-end timer.
 * The core owns this state; the runner reads it here.
 */
export class PiRpcInput {
  /** The last turn settled and no prompt went out since. */
  agentInputReady = false;
  /** Accepted agent prompts not yet seen as a user message_start (#505). */
  readonly submissions = new InputSubmissions();
  // Agent input refused only because a prompt acknowledgement was outstanding gets one readiness
  // hint when it lands, even mid-turn: the turn can be steered (hearsay-tools/cezarion#505).
  private refusedForAck = false;
  private promptSerial = 0;
  private agentAck: PiAgentAck | undefined;
  private readonly acked = new Set<string>();
  // Submissions already queued when a turn began: that turn reads them.
  private carried = new Set<string>();
  private turnFailed = false;
  private latchedProviderError: string | undefined;
  private autoEndTimer: NodeJS.Timeout | undefined;

  constructor(private readonly host: PiRpcInputHost) {}

  /** The head of sendMessage: input is no longer ready. */
  beginPrompt(): void {
    this.agentInputReady = false;
  }

  /** A prompt goes out: the auto-end timer stops and may be scheduled again. */
  cancelAutoEnd(): void {
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
  }

  /** The output loop ended: the auto-end timer stops for good. */
  stopAutoEndTimer(): void {
    if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
  }

  scheduleAutoEnd(): void {
    const { opts } = this.host;
    if (!opts.autoEndAfterFirstTurn || !this.host.isOpen() || this.autoEndTimer || this.agentAck || this.host.humanAcksPending()) return;
    this.autoEndTimer = setTimeout(() => {
      this.autoEndTimer = undefined;
      if (opts.shouldAutoEnd?.() !== false) this.host.end();
    }, AUTO_END_DELAY_MS);
    this.autoEndTimer.unref?.();
  }

  /** A prompt acknowledgement landed: tell the caller when agent input is accepted again. */
  readyAfterAck(): void {
    const { host } = this;
    const acksPending = Boolean(this.agentAck) || host.humanAcksPending();
    if (host.isOpen() && this.agentInputReady && !host.turnId() && !acksPending) {
      this.refusedForAck = false;
      host.opts.onAgentInputReady?.(); this.scheduleAutoEnd();
    } else if (this.refusedForAck && host.isOpen() && !acksPending) {
      this.refusedForAck = false;
      host.opts.onAgentInputReady?.();
    } else if (host.isOpen() && !host.turnId() && !acksPending) {
      // #486: a human ack drained with no turn open — re-settle the idle boundary.
      this.refusedForAck = false;
      host.opts.onAgentInputReady?.();
    }
  }

  rejectAgentAck(error = new Error(`${this.host.cli} closed before prompt acknowledgement`)): void {
    const pending = this.agentAck; this.agentAck = undefined;
    pending?.reject(error);
  }

  /** The pending agent receipt this acknowledgement answers, taken out; undefined for any other ack. */
  takeAgentAck(id: unknown): PiAgentAck | undefined {
    const pending = this.agentAck;
    if (!pending || id !== pending.id) return undefined;
    this.agentAck = undefined;
    return pending;
  }

  /** The agent prompt was accepted: a turn that starts after this carries it. */
  acceptAgentAck(pending: PiAgentAck): void {
    this.acked.add(pending.id);
    pending.resolve();
  }

  /** `agent_start`: commands run in stream order, so only a prompt acknowledged before this
   *  start can be in the turn it starts (hearsay-tools/cezarion#505 CI race). */
  startTurn(): void {
    this.carried = new Set(this.submissions.pendingIds().filter(id => this.acked.has(id)));
    this.turnFailed = false;
  }

  /** A user `message_start`: the model received this prompt now (hearsay-tools/cezarion#505).
   *  An agent submission with its text is read and reported; otherwise the text is returned, so
   *  the runner can settle the human prompt it holds. */
  readUserMessage(message: Record<string, unknown>): string | undefined {
    const text = piMessageText(message);
    const ids = this.submissions.consumeOldestByText(text);
    if (!ids.length) return text;
    this.host.opts.onAgentInputConsumed?.(ids);
    return undefined;
  }

  /** An assistant `message_end`. A provider error is latched until the turn ends and cleared by a
   *  later success: the CLI retries past provider flakes, and a recovered retry must stay silent
   *  (#256, #316). A latched error also fails the turn. */
  endAssistantMessage(message: Record<string, unknown>, providerErrorMessage: (message: Record<string, unknown>) => string): void {
    if (string(message.stopReason) === 'error') {
      this.turnFailed = true;
      this.latchedProviderError = providerErrorMessage(message);
    } else {
      this.latchedProviderError = undefined;
    }
  }

  /** Reports the latched provider error once: at the turn end, or when the stream ends inside a turn. */
  emitLatchedProviderError(): void {
    if (!this.latchedProviderError) return;
    this.host.onEvent?.({ type: 'error', message: this.latchedProviderError });
    this.latchedProviderError = undefined;
  }

  /** The turn failed, so it may never have reached the model. */
  failTurn(): void {
    this.turnFailed = true;
  }

  /** The turn ended: flush its text, report its error, report the input it read,
   *  then `turn-end` and auto-end. */
  settleTurn(): void {
    const { host } = this;
    host.flushText();
    this.emitLatchedProviderError();
    this.agentInputReady = true;
    // Input queued before this turn began was processed by it, even without a user
    // message_start (#505) — unless the turn failed and may never have reached the model.
    const read = this.turnFailed ? [] : [...this.carried].flatMap(id => this.submissions.consume(id));
    this.turnFailed = false;
    this.carried = new Set();
    if (read.length) host.opts.onAgentInputConsumed?.(read);
    host.onEvent?.({ type: 'turn-end' });
    this.scheduleAutoEnd();
  }

  /**
   * The session's `sendAgentMessage`. A running turn is steered; only an unacknowledged prompt
   * refuses (#505). `send` is the runner's
   * sendMessage; `keepReceiptOnFailure` says whether a failed write still returns the receipt.
   */
  sendAgentMessage(
    content: ContentBlock[],
    inputIds: readonly string[],
    send: (content: ContentBlock[], requestId: string, inputIds: readonly string[]) => boolean,
    keepReceiptOnFailure: () => boolean,
  ): false | Promise<void> {
    const open = this.host.isOpen();
    if (open && (this.agentAck || this.host.humanAcksPending())) { this.refusedForAck = true; return false; }
    if (!open) return false;
    const id = `cezar-agent-${++this.promptSerial}`;
    let resolve!: () => void, reject!: (error: Error) => void;
    const acknowledged = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.agentAck = { id, resolve, reject };
    if (!send(content, id, inputIds)) {
      this.agentAck = undefined;
      return keepReceiptOnFailure() ? acknowledged : false;
    }
    return acknowledged;
  }
}

/** The `end()` escalation of a Pi-family session, armed once its stdin closes. */
export interface PiEndWatchdog {
  /** Stops whichever step is still pending. */
  clear(): void;
}

/**
 * After `end()` closes stdin the CLI should exit on its own. When `child()` is still alive after
 * `graceMs`, `onTerminate` records that cezar ends it and SIGTERM follows; SIGKILL follows another
 * `graceMs` later. Closing input makes `interrupt()` a no-op, so this watchdog owns escalation even
 * when the CLI ignores both EOF and SIGTERM, and `result` cannot stay open forever.
 */
export function armEndWatchdog(
  child: () => ChildProcessWithoutNullStreams,
  graceMs: number,
  onTerminate: () => void,
): PiEndWatchdog {
  let timer = setTimeout(() => {
    if (child().exitCode !== null || child().signalCode !== null) return;
    onTerminate();
    signalSession(child(), 'SIGTERM');
    timer = setTimeout(() => {
      if (child().exitCode === null && child().signalCode === null) signalSession(child(), 'SIGKILL');
    }, graceMs);
    timer.unref?.();
  }, graceMs);
  timer.unref?.();
  return { clear: () => clearTimeout(timer) };
}

/** A `get_state` response's session id: a new one is adopted, then reported as a `session` event. */
export function adoptRpcSessionId(
  data: Record<string, unknown>,
  current: string | undefined,
  adopt: (sessionId: string) => void,
  onEvent?: (event: AgentEvent) => void,
): void {
  const discovered = string(data.sessionId);
  if (discovered && discovered !== current) {
    adopt(discovered);
    onEvent?.({ type: 'session', sessionId: discovered });
  }
}

/** The handlers of the native messages pi and omp read the same way. */
export interface PiTurnMessages {
  input: PiRpcInput;
  textBlocks: PiTextBlocks;
  toolCalls: AgentToolCallRecord[];
  onEvent?: ((event: AgentEvent) => void) | undefined;
  flushText(): void;
  /** The runner's own work on an assistant `message_end`, after the text flush and before the
   *  provider-error latch: pi counts usage here; omp reports usage for every message elsewhere. */
  assistantMessageEnded?: ((message: Record<string, unknown>) => void) | undefined;
  /** The runner's wording of a provider failure. */
  providerErrorMessage(message: Record<string, unknown>): string;
  /** A user message whose text matched no agent submission: the runner settles the human prompt
   *  it holds with that text, as its own tracking requires. */
  humanPromptRead(text: string): void;
}

/**
 * Text updates, assistant and user messages, agent starts and tool executions. Any other type
 * is the runner's, and does nothing here. A message whose guard does not match (a non-object
 * `message_update` event, a `message_end` that is not an assistant's, a `message_start` that is
 * not a user's) does nothing, as it did when each runner read these in its own chain: no other
 * branch reads the same type.
 */
export function dispatchPiTurnMessage(value: Record<string, unknown>, turn: PiTurnMessages): void {
  switch (value.type) {
    case 'message_update': if (isRecord(value.assistantMessageEvent)) turn.textBlocks.update(value.assistantMessageEvent); break;
    case 'message_end':
      if (isRecord(value.message) && value.message.role === 'assistant') {
        turn.flushText();
        turn.assistantMessageEnded?.(value.message);
        turn.input.endAssistantMessage(value.message, turn.providerErrorMessage);
      }
      break;
    case 'agent_start': turn.input.startTurn(); break;
    case 'message_start':
      if (isRecord(value.message) && value.message.role === 'user') {
        const text = turn.input.readUserMessage(value.message);
        if (text !== undefined) turn.humanPromptRead(text);
      }
      break;
    case 'tool_execution_start': turn.flushText(); recordPiToolCall(value, turn.toolCalls, turn.onEvent); break;
    case 'tool_execution_end': emitPiToolResult(value, turn.onEvent); break;
  }
}

/** How a Pi-family process ended, read when the output loop and the exit wait are done. */
export interface PiFamilyExit {
  cli: 'pi' | 'omp';
  /** The native event that settles a turn, named when the stream ends inside one. */
  settleEvent: 'agent_settled' | 'session_settled';
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  terminatedByCezar: boolean;
  timedOut: boolean;
  limitMs: number;
  stderr: readonly string[];
  /** The stderr line the exit error carries. */
  stderrDetail(stderr: string): string;
  turnOpen: boolean;
  tokensUsed: number;
  stopReason: Extract<UiEvent, { type: 'session.ended' }>['reason'];
  emitUi(event: UiEvent): void;
  onEvent?: ((event: AgentEvent) => void) | undefined;
  result(): AgentRunResult;
}

/** The run's result after the process exited: a timeout, a teardown, a failure or a clean end. */
export function settlePiFamilyExit(exit: PiFamilyExit): AgentRunResult {
  const { cli, onEvent } = exit;
  if (exit.timedOut) {
    const message = `${cli} CLI timed out after ${Math.round((exit.limitMs / 60_000) * 10) / 10}m and was killed`;
    onEvent?.({ type: 'error', message });
    onEvent?.({ type: 'done' });
    return exit.result();
  }
  reportPiFamilyExit(exit);
  if (exit.turnOpen) onEvent?.({ type: 'note', message: `${cli} RPC session ended before ${exit.settleEvent}` });
  if (exit.tokensUsed === 0) onEvent?.({ type: 'note', message: `token usage not reported by ${cli} CLI` });
  exit.emitUi({ type: 'session.ended', reason: exit.stopReason });
  onEvent?.({ type: 'done' });
  return exit.result();
}

/**
 * A signal cezar sent is teardown, not a second agent failure (#73). A signal from outside (the
 * OOM killer, a stray kill) is a truncated run, never a success; so is a non-zero exit.
 */
function reportPiFamilyExit(exit: PiFamilyExit): void {
  const { cli, exitCode, signalCode, onEvent } = exit;
  if (exit.terminatedByCezar && (isSignalTerminationExit(exitCode) || (exitCode === null && signalCode !== null))) {
    onEvent?.({
      type: 'note',
      message: `${cli} CLI did not exit on its own after close; terminated by cezar (${exitCode === null ? signalCode : `code ${exitCode}`})`,
    });
  } else if (exitCode === null && signalCode !== null) {
    const message = `${cli} CLI was killed by signal ${signalCode}`;
    onEvent?.({ type: 'error', message });
    throw new Error(message);
  } else if (exitCode !== 0 && exitCode !== null) {
    throw piFamilyExitFailure(exit, exitCode);
  }
}

function piFamilyExitFailure(exit: PiFamilyExit, exitCode: number): Error {
  const diagnostic = exit.stderr.join('');
  if (diagnostic.trim()) exit.onEvent?.({ type: 'note', message: `${exit.cli} CLI stderr:\n${diagnostic}` });
  const detail = exit.stderrDetail(diagnostic);
  const message = `${exit.cli} CLI exited with code ${exitCode}${detail ? ` — ${detail}` : ''}`;
  exit.onEvent?.({ type: 'error', message });
  return new Error(message);
}
