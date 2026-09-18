import { parseCursorConfigOptions, cursorEffortSelection, type CursorConfigOption } from './cursor-config-options.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentRunResult, AgentRunner, AgentRunSpec, AgentRunSpecSupport, AgentSession, AgentToolCallRecord, ContentBlock, SessionOptions } from './agent-runner.ts';
import { prependSystemPrompt, trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { parseAskMarker, parseAskRequest, type AskQuestion } from './ask.ts';
import { readNdjson } from './ndjson.ts';
import { AUTO_END_DELAY_MS, DEFAULT_RUN_TIMEOUT_MS, EOF_TERM_GRACE_MS, EOF_KILL_GRACE_MS } from './runner-runtime.ts';
import { createCursorUiState, mapCursorMessage, cursorTurnStarted, cursorTurnCompleted } from './cursor-ui-mapper.ts';
import { classifyCursorProviderError, sanitizeCursorProviderError, type CursorProviderErrorClassification } from './cursor-provider-error.ts';
import type { UiEvent } from './ui-events.ts';

/** Transient provider failures recover on their own (#443): two inline retries, then fatal. */
export const CURSOR_PROVIDER_MAX_RETRIES = 2;
/** Short fixed backoff for instant-less blips (502, connection reset) — no exponential ladder. */
export const CURSOR_PROVIDER_RETRY_BACKOFF_MS = 2_000;
/** A reset instant at most this far out is waited out inline; anything longer fails and lets
 *  the auto-resume scheduler (spec 2026-08-03) park the resume at the instant. */
export const CURSOR_PROVIDER_MAX_INLINE_WAIT_MS = 60_000;
/** Fired a moment after the named instant — landing exactly on it races the provider's clock. */
const CURSOR_PROVIDER_INSTANT_GRACE_MS = 1_000;
/** The #383 post-answer continuation. Shared by the answered-ask auto-resume and by provider
 *  retries of a turn whose work continued past a native answer (#446 round 5). */
const ANSWER_CONTINUATION_PROMPT = 'Continue using the answer just supplied to the native question or plan. Respect rejection; do not treat a rejected plan as approved. If the task is complete, report completion with CEZ:DONE.';

export interface CursorProviderRetryOptions {
  maxRetries?: number;
  backoffMs?: number;
  maxInlineWaitMs?: number;
}

export const CURSOR_SPEC_SUPPORT: AgentRunSpecSupport = {
  systemPrompt: { honored: true, via: 'prependSystemPrompt in opening ACP prompt' },
  userPrompt: { honored: true, via: 'session/prompt text content' },
  images: { honored: true, via: 'ACP image content blocks' },
  cwd: { honored: true, via: 'spawn cwd and session/new or session/load cwd' },
  allowedTools: { honored: false, reason: 'Cursor ACP has no per-session tool allowlist; --force follows the existing auto permission preset' },
  bashAllowlist: { honored: false, reason: 'Cursor ACP has no per-session command-prefix allowlist' },
  restrictNativeDelegation: { honored: true, via: 'initialize clientCapabilities._meta.subagents=false; Cursor 2026.09.15 negotiates native delegation from this capability' },
  additionalDirectories: { honored: true, via: '--add-dir per additional workspace root' },
  env: { honored: true, via: 'buildChildEnv cursor backend with per-run env' },
  model: { honored: true, via: '--model pins initial selection; ACP model config option for advertised IDs, legacy session/set_model fallback' },
  effort: { honored: true, via: 'advertised effort/reasoning/reasoning_effort select value via session/set_config_option; unsupported values fail before inference' },
  timeoutMs: { honored: true, via: 'wall-clock deadline with bounded TERM/KILL teardown' },
  sessionId: { honored: true, via: 'session/load sessionId on resume; session/new mints fresh ID' },
  resume: { honored: true, via: 'session/load instead of session/new' },
};

export class CursorAcpRunner implements AgentRunner {
  readonly backend = 'cursor' as const;
  readonly specSupport = CURSOR_SPEC_SUPPORT;
  private lastSession?: AgentSession;
  constructor(private readonly options: { bin?: string; timeoutMs?: number; providerRetry?: CursorProviderRetryOptions } = {}) {}
  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts: SessionOptions = {}): AgentSession {
    const bin = this.options.bin ?? process.env.CEZ_CURSOR_BIN ?? (process.env.CEZ_DRY_RUN === '1'
      ? fileURLToPath(new URL('../../scripts/mock-cursor-acp.mjs', import.meta.url)) : 'agent');
    return this.lastSession = new CursorSession(bin, spec, this.options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, onEvent, opts, {
      maxRetries: this.options.providerRetry?.maxRetries ?? CURSOR_PROVIDER_MAX_RETRIES,
      backoffMs: this.options.providerRetry?.backoffMs ?? CURSOR_PROVIDER_RETRY_BACKOFF_MS,
      maxInlineWaitMs: this.options.providerRetry?.maxInlineWaitMs ?? CURSOR_PROVIDER_MAX_INLINE_WAIT_MS,
    });
  }
  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }
  async interrupt(): Promise<void> { this.lastSession?.interrupt(); }
}

type RpcId = number | string;
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
interface PendingAsk { id: RpcId; questions: AskQuestion[]; wire: Obj[]; kind: 'question' | 'plan' }
interface ProviderRetryOptions { maxRetries: number; backoffMs: number; maxInlineWaitMs: number }
interface PendingProviderRetry { classification: CursorProviderErrorClassification; detail: string }

/** One ACP process; prompt responses, never notifications, own turn completion. */
class CursorSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly hasExited: () => boolean;
  private isOpen = true;
  private closing = false;
  private busy = true;
  private ready = false;
  private markerAsk = false;
  private sessionId?: string;
  private configOptions: CursorConfigOption[] = [];
  private pendingAsk?: PendingAsk;
  private answeredNativeAsk = false;
  private queued: ContentBlock[][] = [];
  private requestId = 0;
  private readonly pending = new Map<RpcId, { resolve: (value: Obj) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  private state = createCursorUiState();
  private readonly texts: string[] = [];
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private turnText = '';
  private tokensUsed = 0;
  private failure?: string;
  private lastPrompt?: ContentBlock[];
  private pendingProviderRetry?: PendingProviderRetry;
  private providerRetryTimer?: NodeJS.Timeout;
  private providerRetryAttempts = 0;
  private autoEnd?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private termTimer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private resolveResult!: (value: AgentRunResult) => void;
  private settled = false;

  constructor(bin: string, private readonly spec: AgentRunSpec, timeoutMs: number, private readonly onEvent: ((event: AgentEvent) => void) | undefined, private readonly opts: SessionOptions, private readonly providerRetry: ProviderRetryOptions) {
    this.result = new Promise(resolve => { this.resolveResult = resolve; });
    this.child = spawn(bin, ['--force', ...(spec.model ? ['--model', spec.model] : []), ...(spec.additionalDirectories ?? []).flatMap(path => ['--add-dir', path]), 'acp'], {
      cwd: spec.cwd, env: buildChildEnv({ backend: 'cursor', extraEnv: spec.env }),
    });
    this.hasExited = trackChildExit(this.child);
    // Always drain stderr, but never echo credentials or unbounded provider logs.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => { if (!this.closing) this.fail('Cursor ACP input stream closed'); });
    this.child.once('error', () => { this.fail('Unable to start Cursor CLI; install it or check CEZ_CURSOR_BIN'); this.finish(); });
    this.child.once('close', (code, signal) => {
      if (!this.closing) this.fail(`Cursor ACP exited unexpectedly (${signal ?? code ?? 'unknown'})`);
      this.finish();
    });
    const limit = spec.timeoutMs ?? timeoutMs;
    if (limit > 0) {
      this.deadline = setTimeout(() => { this.fail('Cursor ACP timed out and was terminated'); this.interrupt(); }, limit);
      this.deadline.unref();
    }
    void this.read().catch(() => { if (!this.closing) this.fail('Cursor ACP output stream failed'); });
    void this.bootstrap().catch(error => { if (!this.closing) this.fail(error instanceof Error ? error.message : 'Cursor ACP initialization failed'); });
  }
  get pid(): number | undefined { return this.child.pid; }
  get open(): boolean { return this.isOpen; }
  private emit(event: AgentEvent): void { if (!this.settled) this.onEvent?.(event); }
  private ui(event: UiEvent): void { if (!this.settled) this.opts.onUiEvent?.(event); }
  private mapped(mapping: ReturnType<typeof mapCursorMessage>): void {
    this.state = mapping.state;
    for (const event of mapping.events) {
      this.ui(event);
      if (event.type === 'item.completed' && event.item.kind === 'message' && event.item.role === 'assistant' && !event.item.parentItemId) {
        this.texts.push(event.item.text);
        this.turnText += event.item.text;
        this.emit({ type: 'text', text: event.item.text });
      } else if (event.type === 'item.started' && event.item.kind === 'tool') {
        const { id, name, input } = event.item;
        this.toolCalls.push({ id, name, input });
        this.emit({ type: 'tool-call', id, tool: name, input });
      } else if (event.type === 'item.completed' && event.item.kind === 'tool') {
        this.emit({ type: 'tool-result', toolCallId: event.item.id, result: event.item.output ?? event.item.error ?? '', isError: event.item.status === 'failed' });
      } else if (event.type === 'usage.updated') {
        this.tokensUsed = event.usage.total;
        this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed });
      } else if (event.type === 'image') this.emit(event);
    }
  }
  private write(message: Obj, accepted?: (error?: Error | null) => void): void {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) { accepted?.(new Error('Cursor ACP input closed')); return; }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`, accepted);
  }
  private request(method: string, params: Obj, accepted?: (error?: Error | null) => void): Promise<Obj> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = method === 'session/prompt' ? undefined : setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Cursor ACP ${method} timed out`));
      }, 15_000);
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params }, error => {
        accepted?.(error);
        if (error) { if (timer) clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  private async bootstrap(): Promise<void> {
    const init = await this.request('initialize', { protocolVersion: 1, clientInfo: { name: 'cezar', version: '1' },
      clientCapabilities: { _meta: { subagents: !this.spec.restrictNativeDelegation, parameterizedModelPicker: true } } });
    if (!this.open) return;
    if (init.protocolVersion !== 1) throw new Error('Cursor ACP protocol version is unsupported');
    if (this.spec.resume && this.spec.sessionId && object(init.agentCapabilities).loadSession !== true) throw new Error('Cursor CLI does not support session resume');
    const resume = this.spec.resume && this.spec.sessionId;
    const response = await this.request(resume ? 'session/load' : 'session/new', {
      cwd: this.spec.cwd, mcpServers: [], ...(resume ? { sessionId: this.spec.sessionId } : {}),
    });
    if (!this.open) return;
    this.sessionId = resume ? this.spec.sessionId : typeof response.sessionId === 'string' ? response.sessionId : undefined;
    if (!this.sessionId) throw new Error('Cursor ACP returned no session ID');
    this.state = { ...this.state, sessionId: this.sessionId };
    const config = parseCursorConfigOptions(response.configOptions);
    if (config) this.configOptions = config;
    const modelOption = this.configOptions.find(option => option.id === 'model');
    if (this.spec.model && modelOption?.options.some(option => option.value === this.spec.model)) {
      if (modelOption.currentValue !== this.spec.model) await this.setConfigOption('model', this.spec.model);
    } else if (this.spec.model && config === undefined) {
      // Older Cursor builds expose only the legacy model control. Opaque IDs are
      // also passed intact at process launch, before the provider session is built.
      await this.request('session/set_model', { sessionId: this.sessionId, modelId: this.spec.model });
    }
    if (this.spec.effort) {
      const selection = cursorEffortSelection(this.configOptions, this.spec.effort);
      await this.setConfigOption(selection.configId, selection.value);
    }
    if (!this.open) return;
    this.emit({ type: 'session', sessionId: this.sessionId });
    this.ui({ type: 'session.started', backend: 'cursor', sessionId: this.sessionId, cwd: this.spec.cwd, ...(this.spec.model ? { model: this.spec.model } : {}) });
    this.ready = true;
    this.startTurn([{ type: 'text', text: prependSystemPrompt(this.spec.systemPrompt, this.spec.userPrompt) }, ...(this.spec.images ?? [])]);
  }
  private async setConfigOption(configId: string, value: string): Promise<void> {
    const response = await this.request('session/set_config_option', { sessionId: this.sessionId, configId, value });
    const options = parseCursorConfigOptions(response.configOptions);
    if (options) this.configOptions = options;
    if (!options || !options.some(option => option.id === configId && option.currentValue === value)) {
      throw new Error('Cursor ACP did not confirm the requested session configuration');
    }
  }
  private startTurn(content: ContentBlock[], accepted?: (error?: Error | null) => void): void {
    if (!this.open || !this.sessionId) { accepted?.(new Error('Cursor session closed')); return; }
    this.lastPrompt = content;
    this.busy = true; this.markerAsk = false; this.turnText = ''; this.answeredNativeAsk = false;
    this.clearAutoEnd();
    this.mapped(cursorTurnStarted(this.state));
    const prompt = content.map(block => block.type === 'text' ? block : { type: 'image', mimeType: block.source.media_type, data: block.source.data });
    void this.request('session/prompt', { sessionId: this.sessionId, prompt }, accepted).then(result => {
      if (!this.open) return;
      // A provider error envelope latches a retry decision instead of failing outright
      // (#443); the end_turn that follows it resolves the prompt, and the retry —
      // not the turn's completion — owns what happens next.
      const retry = this.pendingProviderRetry;
      if (retry) { this.pendingProviderRetry = undefined; this.handleProviderRetry(retry); return; }
      this.mapped(cursorTurnCompleted(typeof result.stopReason === 'string' ? result.stopReason : 'error', this.state));
      if (this.failure) return;
      this.busy = false;
      this.providerRetryAttempts = 0;
      this.markerAsk = parseAskMarker(this.turnText) !== null;
      if (this.markerAsk) this.discardQueuedMessages();
      // Cursor can finish the ACP prompt immediately after accepting a native
      // answer (#383). That is a wire boundary, not a handoff back to the human.
      // Keep v2 turn accounting, but expose v1 idle only after the resumed work.
      const resume = this.answeredNativeAsk;
      this.answeredNativeAsk = false;
      if (resume && result.stopReason === 'end_turn' && !this.pendingAsk && !this.markerAsk
        && !/CEZ:(?:DONE|MONITORING)\s*$/.test(this.turnText)) {
        this.startTurn(this.queued.shift() ?? [{ type: 'text', text: ANSWER_CONTINUATION_PROMPT }]);
        return;
      }
      this.emit({ type: 'turn-end' });
      // onEvent can synchronously reserve a new turn; do not clobber its state.
      if (!this.open || this.busy) return;
      const next = !this.markerAsk ? this.queued.shift() : undefined;
      if (next) this.startTurn(next);
      else { this.opts.onAgentInputReady?.(); this.scheduleAutoEnd(); }
    }).catch(error => { if (!this.closing) this.fail(`Cursor ACP request failed: ${error instanceof Error ? error.message : 'unknown error'}`); });
  }
  sendMessage(content: ContentBlock[]): boolean {
    if (!this.open) return false;
    this.clearAutoEnd(); this.markerAsk = false;
    if (this.pendingAsk) {
      const pending = this.pendingAsk; this.pendingAsk = undefined;
      this.answeredNativeAsk = true;
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (pending.kind === 'plan') {
        const answer = text.replace(/^Plan:\s*/i, '');
        this.write({ id: pending.id, result: { outcome: /^(approve|accept|yes)$/i.test(answer) ? { outcome: 'accepted' } : { outcome: 'rejected', reason: text } } });
      } else {
        const answers = pending.questions.map((question, index) => {
          const line = text.split('\n').find(line => line.startsWith(`${question.header}:`));
          const answer = line ? line.slice(question.header.length + 1).trim() : pending.questions.length === 1 ? text : '';
          const options = (pending.wire[index]?.options as Obj[] | undefined) ?? [];
          const selectedOptionIds = options.filter(option => answer === option.label || answer.split(',').map(s => s.trim()).includes(String(option.label))).map(option => option.id);
          return { questionId: question.id, selectedOptionIds };
        });
        if (answers.every(answer => answer.selectedOptionIds.length > 0)) this.write({ id: pending.id, result: { outcome: { outcome: 'answered', answers } } });
        else {
          // Cursor's question extension has only option IDs. Preserve free text
          // as a following prompt after explicitly skipping that native request.
          this.queued.unshift(content);
          this.write({ id: pending.id, result: { outcome: { outcome: 'skipped', reason: 'User supplied a free-text answer; it follows in the next prompt.' } } });
        }
      }
    } else if (!this.ready || this.busy) this.queued.push(content);
    else this.startTurn(content);
    return true;
  }
  sendAgentMessage(content: ContentBlock[]): false | Promise<void> {
    if (!this.open || !this.ready || this.busy || this.pendingAsk || this.markerAsk || this.queued.length > 0) return false;
    this.busy = true;
    return new Promise((resolve, reject) => this.startTurn(content, error => error ? reject(error) : resolve()));
  }
  discardQueuedMessages(): void { this.queued = []; }
  private clearAutoEnd(): void { if (this.autoEnd) clearTimeout(this.autoEnd); this.autoEnd = undefined; }
  private scheduleAutoEnd(): void {
    if (!this.opts.autoEndAfterFirstTurn || !this.open || this.busy || this.pendingAsk) return;
    this.clearAutoEnd();
    this.autoEnd = setTimeout(() => { this.autoEnd = undefined; if (!this.busy && this.opts.shouldAutoEnd?.() !== false) this.end(); }, AUTO_END_DELAY_MS);
    this.autoEnd.unref();
  }
  end(): void {
    if (this.closing) return;
    this.closeInput();
    this.child.stdin.end();
    this.termTimer = setTimeout(() => this.terminate(), EOF_TERM_GRACE_MS); this.termTimer.unref();
  }
  interrupt(): void { this.closeInput(); this.terminate(); }
  private closeInput(): void {
    if (this.closing) return;
    this.closing = true; this.isOpen = false; this.clearAutoEnd(); this.discardQueuedMessages();
    if (this.pendingAsk) this.write({ id: this.pendingAsk.id, result: { outcome: { outcome: 'cancelled' } } });
    this.pendingAsk = undefined;
    if (this.sessionId && this.busy) this.write({ method: 'session/cancel', params: { sessionId: this.sessionId } });
  }
  private terminate(): void {
    if (this.hasExited()) return;
    this.child.kill('SIGTERM');
    if (!this.killTimer) { this.killTimer = setTimeout(() => { if (!this.hasExited()) this.child.kill('SIGKILL'); }, EOF_KILL_GRACE_MS); this.killTimer.unref(); }
  }
  private fail(message: string): void {
    if (this.failure || this.settled) return;
    this.failure = message;
    this.emit({ type: 'error', message }); this.ui({ type: 'session.error', message, fatal: true });
    this.mapped(cursorTurnCompleted('error', this.state));
    this.interrupt();
  }

  /**
   * A Cursor provider error envelope arrived (#443). Preserve the provider's text, sanitized,
   * in every outcome: authentication keeps the login guidance and fails fatally; unknown prose
   * fails fatally named after the failed request; a transient failure latches a bounded retry
   * that fires when the prompt's end_turn resolves. Retry accounting lives in
   * `handleProviderRetry` — the cap is 2 inline retries, stated on the transcript.
   */
  private envelopeError(text: string): void {
    const classification = classifyCursorProviderError(text);
    const detail = sanitizeCursorProviderError(text);
    if (classification.kind === 'auth') {
      this.fail(`Cursor provider authentication failed; run agent login — provider said: ${detail}`);
      return;
    }
    if (classification.kind === 'fatal') {
      this.fail(`Cursor provider request failed: ${detail}`);
      return;
    }
    this.pendingProviderRetry = { classification, detail };
  }

  /** The fatal text for a classified provider failure. When the classification knows a reset
   *  instant that the display cap truncated out of the detail, restate it in a form
   *  `parseUsageLimit` matches, so the auto-resume scheduler reading `run.error` can still
   *  fire on a verbose provider message (#446 round 3). */
  private providerFatalMessage(detail: string, classification: CursorProviderErrorClassification, attempts?: number): string {
    const resetAt = classification.kind === 'transient' ? classification.resetAt : undefined;
    const head = attempts === undefined
      ? 'Cursor provider request failed'
      : `Cursor provider request failed after ${attempts} attempts`;
    const instant = resetAt && !detail.includes(resetAt.toISOString())
      ? ` — usage limit resets at ${resetAt.toISOString()}`
      : '';
    return `${head}: ${detail}${instant}`;
  }

  /** Fire the latched provider retry: wait out a near reset instant or back off briefly,
   *  say the attempt on the transcript, and re-prompt the same session with the same content.
   *  `busy` stays true throughout, so no auto-end or queued input can land mid-retry. */
  private handleProviderRetry(retry: PendingProviderRetry): void {
    // The failed attempt is a real turn. Complete it with the failure reason first, so the
    // v2 stream never carries a started-but-never-completed turn across a retry (#446 review)
    // and usage accounting keeps its started/recorded pairing balanced. On the give-up path
    // `fail`'s own completion then finds no open turn and is a no-op — never a duplicate.
    this.mapped(cursorTurnCompleted('error', this.state));
    if (this.providerRetryAttempts >= this.providerRetry.maxRetries) {
      this.fail(this.providerFatalMessage(retry.detail, retry.classification, this.providerRetryAttempts + 1));
      return;
    }
    const attempt = this.providerRetryAttempts + 1;
    this.providerRetryAttempts = attempt;
    let delay = this.providerRetry.backoffMs;
    const resetAt = retry.classification.kind === 'transient' ? retry.classification.resetAt : undefined;
    if (resetAt) {
      const wait = resetAt.getTime() - Date.now();
      if (wait > this.providerRetry.maxInlineWaitMs) {
        // Too far out to hold the session open. Failing with the preserved text lets the
        // auto-resume scheduler (spec 2026-08-03) park a resume at the instant — no human.
        this.fail(this.providerFatalMessage(retry.detail, retry.classification));
        return;
      }
      delay = Math.max(0, wait) + CURSOR_PROVIDER_INSTANT_GRACE_MS;
    }
    this.ui({ type: 'session.error', fatal: false,
      message: `Cursor provider request failed: ${retry.detail}; retrying (${attempt}/${this.providerRetry.maxRetries})` });
    this.providerRetryTimer = setTimeout(() => {
      this.providerRetryTimer = undefined;
      if (!this.open || this.closing) return;
      // Work that had already continued past a native answer retries the answer continuation,
      // not the original prompt — the answer lives in the provider's session state, and
      // re-prompting the task text would drop its thread (#446 round 5). Queued input —
      // a free-text native answer, worker input — outranks the synthesized continuation,
      // matching the successful answered-ask path (#446 round 6).
      const answered = this.answeredNativeAsk;
      this.startTurn(answered
        ? this.queued.shift() ?? [{ type: 'text', text: ANSWER_CONTINUATION_PROMPT }]
        : this.lastPrompt ?? [{ type: 'text', text: 'Continue after the provider error.' }]);
    }, delay);
    this.providerRetryTimer.unref?.();
  }
  private finish(): void {
    if (this.settled) return;
    this.isOpen = false;
    for (const timer of [this.deadline, this.autoEnd, this.termTimer, this.killTimer, this.providerRetryTimer]) if (timer) clearTimeout(timer);
    for (const request of this.pending.values()) { if (request.timer) clearTimeout(request.timer); request.reject(new Error('Cursor session closed')); }
    this.pending.clear();
    if (this.busy && !this.failure) this.mapped(cursorTurnCompleted('cancelled', this.state));
    this.ui({ type: 'session.ended', reason: this.failure ? 'error' : 'end_turn' });
    this.emit({ type: 'done' });
    this.settled = true;
    this.resolveResult({ text: this.texts.join('\n').trim(), toolCalls: this.toolCalls, tokensUsed: this.tokensUsed, ...(this.sessionId ? { sessionId: this.sessionId } : {}) });
  }
  private async read(): Promise<void> {
    for await (const line of readNdjson(this.child.stdout)) {
      let raw: unknown; try { raw = JSON.parse(line); } catch { continue; }
      const msg = object(raw);
      const params = object(msg.params);
      const update = object(params.update);
      if (msg.method === 'session/update' && params.sessionId === this.sessionId && update.sessionUpdate === 'config_option_update') {
        const options = parseCursorConfigOptions(update.configOptions);
        if (options) this.configOptions = options;
      }
      const id = typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : undefined;
      if (typeof msg.method !== 'string') {
        if (id === undefined) continue;
        const pending = this.pending.get(id); if (!pending) continue;
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error(object(msg.error).code === -32000 ? 'Cursor ACP authentication required; run agent login' : 'Cursor ACP rejected the request'));
        else pending.resolve(object(msg.result));
        continue;
      }
      if (this.closing) continue;
      // session/load replays history before its response; it is already in the
      // persisted transcript and must not be emitted as this turn's new output.
      if (!this.ready) { if (id !== undefined) this.write({ id, error: { code: -32601, message: 'Session not ready' } }); continue; }
      if (msg.method === 'session/update') {
        const update = object(params.update); const content = object(update.content);
        // Cursor 2026.09.15 catches provider errors and emits this exact prefix,
        // then returns end_turn. Narrow to its error envelope, not arbitrary prose.
        if (params.sessionId === this.sessionId && update.sessionUpdate === 'agent_message_chunk'
          && typeof content.text === 'string' && /^\n\nError: /u.test(content.text)) {
          this.envelopeError(content.text); continue;
        }
      }
      if (msg.method === 'cursor/ask_question' && id !== undefined) { this.ask(id, params); continue; }
      if (msg.method === 'cursor/create_plan' && id !== undefined) {
        if (this.pendingAsk || typeof params.plan !== 'string' || !params.plan.trim()) {
          this.write({ id, result: { outcome: { outcome: 'rejected', reason: 'Plan request is invalid or another question is pending' } } }); continue;
        }
        this.discardQueuedMessages();
        this.texts.push(params.plan);
        this.emit({ type: 'text', text: params.plan });
        this.ui({ type: 'item.completed', item: { kind: 'message', id: `cursor-plan-${id}`, role: 'assistant', text: params.plan } });
        const questions: AskQuestion[] = [{ header: 'Plan', question: String(params.overview ?? params.name ?? 'Approve this plan?').slice(0, 400), options: [{ label: 'Approve' }, { label: 'Reject' }], multiSelect: false }];
        this.pendingAsk = { id, questions, wire: [], kind: 'plan' };
        this.ui({ type: 'ask.requested', requestId: String(id), questions }); continue;
      }
      if (msg.method === 'session/request_permission' && id !== undefined) {
        const options = Array.isArray(params.options) ? params.options.map(object) : [];
        const allow = options.find(o => o.kind === 'allow_once');
        this.write({ id, result: { outcome: params.sessionId === this.sessionId && allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } }); continue;
      }
      this.mapped(mapCursorMessage(msg, this.state));
      if (id !== undefined) {
        if (['cursor/update_todos', 'cursor/task', 'cursor/generate_image'].includes(msg.method)) this.write({ id, result: {} });
        else this.write({ id, error: { code: -32601, message: 'Method not supported' } });
      }
    }
  }
  private ask(id: RpcId, params: Obj): void {
    const wire = Array.isArray(params.questions) ? params.questions.map(object) : [];
    const parsed = parseAskRequest({ questions: wire.map((q, index) => ({
      id: q.id, header: wire.length > 1 ? `Question ${index + 1}` : String(params.title ?? 'Question').slice(0, 12), question: q.prompt,
      options: Array.isArray(q.options) ? q.options.map(o => ({ label: object(o).label })) : [], multiSelect: q.allowMultiple === true,
    })) });
    if (!parsed || this.pendingAsk || wire.some(q => typeof q.id !== 'string' || !Array.isArray(q.options) || q.options.some(o => typeof object(o).id !== 'string'))) {
      this.write({ id, result: { outcome: { outcome: 'skipped', reason: 'Question cannot be represented in the cockpit' } } }); return;
    }
    this.discardQueuedMessages();
    this.pendingAsk = { id, questions: parsed.questions, wire, kind: 'question' };
    this.ui({ type: 'ask.requested', requestId: String(id), questions: parsed.questions });
  }
}
