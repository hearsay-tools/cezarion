import { parseAskMarker } from './ask.ts';
import type { AgentEvent, AgentInputOptions, AgentToolCallRecord, ContentBlock, SessionOptions } from './agent-runner.js';
import { InputSubmissions } from './input-submissions.ts';
import { contentText, emitImages, isRecord, string } from './pi-rpc-wire.ts';
import { AUTO_END_DELAY_MS } from './runner-runtime.js';
import { V1TextCoalescer } from './v1-text-coalescer.js';

/**
 * Turn and input bookkeeping that the Pi-family RPC runners share: pi (`pi-runner.ts`) and its
 * fork omp (`omp-runner.ts`) read the same native messages and accept agent input the same way
 * (hearsay-tools/cezarion#2006). Each runner keeps its own message dispatch, its own human-prompt
 * tracking and its own process lifecycle, and calls these at the same points as before.
 */

/**
 * Streamed `text_delta` tokens buffered per content block. v1 `text` is one event per complete
 * block (claude/codex/opencode parity), never per token: token-by-token emission split
 * `CEZ:ASK` markers so `parseAskMarker` never matched (open-mercato/cezar#902,
 * hearsay-tools/cezarion#2). Streaming display rides protocol v2's `item.delta`.
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
  /** The run's completed text blocks, read for the turn's CEZ:ASK marker. */
  textChunks: readonly string[];
  isOpen(): boolean;
  /** The mapper's open normalized turn, if any. */
  turnId(): string | null;
  /** A human prompt is written and not yet acknowledged. */
  humanAcksPending(): boolean;
  end(): void;
  flushText(): void;
  emitLatchedProviderError(): void;
}

/**
 * Agent input and turn boundaries of one Pi-family session: readiness for agent input, the
 * pending agent receipt, the input a turn carried, the turn-end step and the auto-end timer.
 * The core owns this state; the runner reads it here.
 */
export class PiRpcInput {
  /** The last turn settled and no prompt went out since. */
  agentInputReady = false;
  /** The last settled turn's text holds a CEZ:ASK marker. */
  pendingMarkerAsk = false;
  /** Accepted agent prompts not yet seen as a user message_start (#505). */
  readonly submissions = new InputSubmissions();
  private turnTextStart = 0;
  // Agent input refused only because a prompt acknowledgement was outstanding gets one readiness
  // hint when it lands, even mid-turn: the turn can be steered (hearsay-tools/cezarion#505).
  private refusedForAck = false;
  private promptSerial = 0;
  private agentAck: PiAgentAck | undefined;
  private readonly acked = new Set<string>();
  // Submissions already queued when a turn began: that turn reads them.
  private carried = new Set<string>();
  private turnFailed = false;
  private autoEndTimer: NodeJS.Timeout | undefined;

  constructor(private readonly host: PiRpcInputHost) {}

  /** The head of sendMessage: input is no longer ready, and a prompt that opens a turn starts its text. */
  beginPrompt(opensTurn: boolean): void {
    this.agentInputReady = false;
    if (opensTurn) {
      this.pendingMarkerAsk = false;
      this.turnTextStart = this.host.textChunks.length;
    }
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
    } else if (this.refusedForAck && host.isOpen() && !acksPending && !this.pendingMarkerAsk) {
      this.refusedForAck = false;
      host.opts.onAgentInputReady?.();
    } else if (host.isOpen() && !host.turnId() && !acksPending && !this.pendingMarkerAsk) {
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

  /** The turn failed, so it may never have reached the model. */
  failTurn(): void {
    this.turnFailed = true;
  }

  /** The turn ended: flush its text, report its error, mark a CEZ:ASK, report the input it read,
   *  then `turn-end` and auto-end. */
  settleTurn(): void {
    const { host } = this;
    host.flushText();
    host.emitLatchedProviderError();
    this.pendingMarkerAsk = parseAskMarker(host.textChunks.slice(this.turnTextStart).join('\n')) !== null;
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
   * The session's `sendAgentMessage`. A running turn is steered; only a pending CEZ:ASK (unless the
   * caller delivers beside it) or an unacknowledged prompt refuses (#505). `send` is the runner's
   * sendMessage; `keepReceiptOnFailure` says whether a failed write still returns the receipt.
   */
  sendAgentMessage(
    content: ContentBlock[],
    inputIds: readonly string[],
    options: AgentInputOptions | undefined,
    send: (content: ContentBlock[], requestId: string, inputIds: readonly string[]) => boolean,
    keepReceiptOnFailure: () => boolean,
  ): false | Promise<void> {
    const open = this.host.isOpen();
    const askRefuses = this.pendingMarkerAsk && !options?.besideQuestion;
    if (open && !askRefuses && (this.agentAck || this.host.humanAcksPending())) { this.refusedForAck = true; return false; }
    if (!open || askRefuses) return false;
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
