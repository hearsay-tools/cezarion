import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEvent, AgentRunResult, AgentRunner, AgentRunSpec, AgentRunSpecSupport,
  AgentSession, AgentToolCallRecord, ContentBlock, InputDelivery, SessionOptions,
} from './agent-runner.ts';
import { prependSystemPrompt } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { parseAskMarker } from './ask.ts';
import { cezarToolEnvNames } from '../ci-wait/tools.ts';
import type { ModelOption } from './runner-model-catalog.ts';
import { SAFE_CURSOR_PRINT_TOOLS } from './cursor-print-tool-catalog.ts';
import { sanitizeCursorProviderError } from './cursor-provider-error.ts';
import { summarizeRunnerStderr } from './runner-stderr.ts';
import { startCursorPrintProcess, type CursorPrintProcess, type CursorPrintProcessOptions } from './cursor-print-process.ts';
import { createCursorPrintUiState, mapCursorPrintMessage, mapCursorPrintStreamEvent } from './cursor-print-ui-mapper.ts';
import { AUTO_END_DELAY_MS, DEFAULT_NO_PROGRESS_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS } from './runner-runtime.ts';

/** Cursor print fields with live-qualified invocation mechanisms. */
export const CURSOR_PRINT_SPEC_SUPPORT: AgentRunSpecSupport = {
  cezarTools: { honored: true, via: 'private local --plugin-dir with mcp.json env placeholders on every turn' },
  systemPrompt: { honored: true, via: 'prepended to each print prompt' },
  userPrompt: { honored: true, via: 'final positional print prompt' },
  images: { honored: true, via: 'private temporary image files passed with --image' },
  cwd: { honored: true, via: 'spawn cwd' },
  allowedTools: { honored: false, reason: 'No general Cezar tool-name to native Cursor tool-name mapping exists' },
  bashAllowlist: { honored: false, reason: 'Cursor print has no per-command prefix allowlist' },
  restrictNativeDelegation: { honored: true, via: 'strict --allowed-tools native catalog omitting delegation entries on every turn' },
  additionalDirectories: { honored: true, via: '--add-dir per workspace root on every turn' },
  env: { honored: true, via: 'buildChildEnv with per-run env' },
  model: { honored: true, via: '--model opaque ID' },
  effort: { honored: true, via: 'advertised opaque model variant selected by --model' },
  timeoutMs: { honored: true, via: 'logical wall-clock timer across print processes' },
  sessionId: { honored: true, via: 'exact --resume native ID after first turn' },
  resume: { honored: true, via: '--resume for a recorded native session' },
  resumeFallbackSystemPrompt: { honored: false, reason: 'A failed print resume never opens a fresh session' },
};

export interface CursorPrintRunnerOptions {
  bin?: string;
  timeoutMs?: number;
  /** The selected account's read-only model catalog, supplied by the facade. */
  models?: readonly ModelOption[];
  /** Test override; production retains the shared 30-minute no-progress cap. */
  noProgressTimeoutMs?: number;
  processOptions?: Pick<CursorPrintProcessOptions, 'drainMs' | 'termGraceMs' | 'killGraceMs'>;
}

export class CursorPrintRunner implements AgentRunner {
  readonly backend = 'cursor' as const;
  readonly specSupport = CURSOR_PRINT_SPEC_SUPPORT;
  readonly systemPromptOnResume = 'in-thread' as const;
  readonly inputDelivery: InputDelivery = {
    mode: 'boundary', consumption: 'unobservable', via: 'next exact-resume print process',
  };
  private lastSession?: AgentSession;
  constructor(private readonly options: CursorPrintRunnerOptions = {}) {}
  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts: SessionOptions = {}): AgentSession {
    const bin = this.options.bin ?? process.env.CEZ_CURSOR_BIN ?? (process.env.CEZ_DRY_RUN === '1'
      ? fileURLToPath(new URL('../../scripts/mock-cursor-print.mjs', import.meta.url)) : 'agent');
    return this.lastSession = new CursorPrintSession(bin, spec, this.options, onEvent, opts);
  }
  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }
  async interrupt(): Promise<void> { this.lastSession?.interrupt(); }
}

interface ActiveTurn {
  process: CursorPrintProcess;
  buffer: string;
  initSeen: boolean;
  resultSeen: boolean;
  modelWorkSeen: boolean;
  turnText: string;
  stderr: string;
  receipt?: { resolve(): void; reject(error: Error): void; settled: boolean };
}

const NATIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FRAME_BUFFER = 1024 * 1024;

class CursorPrintSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;
  private resolveResult!: (result: AgentRunResult) => void;
  private isOpen = true;
  private closing = false;
  private finished = false;
  private busy = false;
  private nativeId?: string;
  private sessionEventEmitted = false;
  private turnCount = 0;
  private active?: ActiveTurn;
  private queue: ContentBlock[][] = [];
  private uiState = createCursorPrintUiState();
  private texts: string[] = [];
  private toolCalls: AgentToolCallRecord[] = [];
  private tokensUsed = 0;
  private deadline?: NodeJS.Timeout;
  private noProgress?: NodeJS.Timeout;
  private autoEnd?: NodeJS.Timeout;
  private errorReported = false;
  private markerAsk = false;
  private model?: string;
  private scratch?: string;
  private pluginDir?: string;
  private imageIndex = 0;

  constructor(
    private readonly bin: string,
    private readonly spec: AgentRunSpec,
    private readonly options: CursorPrintRunnerOptions,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
  ) {
    this.result = new Promise(resolve => { this.resolveResult = resolve; });
    const limit = spec.timeoutMs ?? options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    if (limit > 0) this.deadline = setTimeout(() => this.fail('Cursor print timed out'), limit);
    if (spec.resume && (!spec.sessionId || !NATIVE_ID_RE.test(spec.sessionId))) {
      this.fail('Cursor print resume requires a valid recorded session id');
      return;
    }
    try {
      this.model = this.resolveModel();
      if (spec.cezarTools) this.prepareCezarPlugin();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Cursor print invocation is unsupported');
      return;
    }
    this.nativeId = spec.resume ? spec.sessionId : undefined;
    this.beginTurn([{ type: 'text', text: spec.userPrompt }]);
  }

  get pid(): number | undefined { return this.active?.process.pid; }
  get open(): boolean { return this.isOpen; }

  private emit(event: AgentEvent): void {
    if (event.type === 'text') this.texts.push(event.text);
    if (event.type === 'tool-call') this.toolCalls.push({ id: event.id, name: event.tool, input: event.input });
    if (event.type === 'token-usage') this.tokensUsed += event.tokensUsed;
    this.onEvent?.(event);
  }

  private resolveModel(): string | undefined {
    const model = this.spec.model;
    const catalog = this.options.models;
    if (model && catalog && !catalog.some(option => option.id === model) && !this.spec.effort) {
      throw new Error(`Cursor print model '${model}' is not advertised`);
    }
    if (!this.spec.effort) return model;
    if (!model || !catalog?.length) throw new Error('Cursor print cannot verify the requested effort without an advertised model catalog');
    const base = model.replace(/-(?:none|low|medium|high|xhigh|extra-high|max)$/, '');
    const suffixes = this.spec.effort === 'xhigh' ? ['xhigh', 'extra-high'] : [this.spec.effort];
    const selected = suffixes.map(suffix => `${base}-${suffix}`)
      .find(candidate => catalog.some(option => option.id === candidate));
    if (!selected) throw new Error(`Cursor print model does not advertise effort '${this.spec.effort}'`);
    return selected;
  }

  private ensureScratch(): string {
    return this.scratch ??= mkdtempSync(join(tmpdir(), 'cez-cursor-print-'));
  }

  private prepareCezarPlugin(): void {
    const tools = this.spec.cezarTools;
    if (!tools) return;
    const dir = join(this.ensureScratch(), 'cezar-tools');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
      name: 'cezar-tools', version: '0.0.1', description: 'Cezar task tools',
    }), { mode: 0o600 });
    const env = Object.fromEntries(cezarToolEnvNames(this.spec.env ?? {}).filter(name => this.spec.env?.[name])
      .map(name => [name, '${' + name + '}']));
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {
      [tools.name]: { type: 'stdio', command: tools.command, args: tools.args, env },
    } }), { mode: 0o600 });
    this.pluginDir = dir;
  }

  private imagePath(block: Extract<ContentBlock, { type: 'image' }>): string {
    const extensions: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    };
    const extension = extensions[block.source.media_type];
    if (!extension) throw new Error(`Cursor print image type '${block.source.media_type}' is unsupported`);
    const bytes = Buffer.from(block.source.data, 'base64');
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('Cursor print image size is unsupported');
    const path = join(this.ensureScratch(), `image-${++this.imageIndex}.${extension}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  }

  private beginTurn(content: ContentBlock[], receipt?: ActiveTurn['receipt']): void {
    if (this.closing || !this.isOpen) { receipt?.reject(new Error('Cursor print session closed')); return; }
    let text: string;
    let imagePaths: string[];
    try {
      text = content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text).join('\n');
      const images = [...(this.turnCount === 0 ? this.spec.images ?? [] : []), ...content]
        .filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image');
      imagePaths = images.map(block => this.imagePath(block));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cursor print could not prepare input';
      receipt?.reject(new Error(message)); this.fail(message); return;
    }
    this.clearAutoEnd();
    this.markerAsk = false;
    this.busy = true;
    const args = ['-p', '--force', '--trust', '--output-format', 'stream-json'];
    if (this.model) args.push('--model', this.model);
    if (this.nativeId) args.push('--resume', this.nativeId);
    if (this.spec.restrictNativeDelegation) args.push('--allowed-tools', SAFE_CURSOR_PRINT_TOOLS.join(','));
    for (const dir of this.spec.additionalDirectories ?? []) args.push('--add-dir', dir);
    if (this.pluginDir) args.push('--plugin-dir', this.pluginDir);
    for (const path of imagePaths) args.push('--image', path);
    args.push(prependSystemPrompt(this.spec.systemPrompt, text));
    let proc: CursorPrintProcess;
    try {
      proc = startCursorPrintProcess({
        bin: this.bin, args, cwd: this.spec.cwd,
        env: buildChildEnv({ backend: 'cursor', extraEnv: this.spec.env }),
        ...this.options.processOptions,
      }, {
        onStdout: chunk => this.onStdout(chunk),
        onStderr: chunk => { this.activity(); if (this.active) this.active.stderr = (this.active.stderr + chunk).slice(-16_384); },
        onOutputError: () => this.fail('Cursor print output transport failed'),
      });
    } catch (error) {
      receipt?.reject(error instanceof Error ? error : new Error('Cursor print spawn failed'));
      this.fail('Cursor print spawn failed');
      return;
    }
    const active: ActiveTurn = { process: proc, buffer: '', initSeen: false,
      resultSeen: false, modelWorkSeen: false, turnText: '', stderr: '', receipt };
    this.active = active;
    this.turnCount += 1;
    if (this.turnCount > 1 && proc.pid) this.opts.onPidChange?.(proc.pid);
    this.armNoProgress();
    void this.watchTurn(active);
  }

  private activity(): void {
    this.opts.onActivity?.();
    this.armNoProgress();
  }
  private armNoProgress(): void {
    if (this.noProgress) clearTimeout(this.noProgress);
    if (!this.busy || this.closing) return;
    this.noProgress = setTimeout(() => this.fail('Cursor print made no progress before its deadline'),
      this.options.noProgressTimeoutMs ?? DEFAULT_NO_PROGRESS_TIMEOUT_MS);
    this.noProgress.unref?.();
  }
  private onStdout(chunk: string): void {
    const active = this.active;
    if (!active || this.finished) return;
    this.activity();
    active.buffer += chunk;
    if (active.buffer.length > MAX_FRAME_BUFFER) { this.fail('Cursor print output exceeded the frame limit'); return; }
    let end: number;
    while ((end = active.buffer.indexOf('\n')) >= 0 && !this.closing) {
      const line = active.buffer.slice(0, end);
      active.buffer = active.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { continue; }
      this.handleFrame(frame, active);
    }
  }

  private handleFrame(frame: unknown, active: ActiveTurn): void {
    if (active.resultSeen) return;
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
    const native = frame as Record<string, unknown>;
    if (native.type === 'system' && native.subtype === 'init') {
      if (typeof native.session_id !== 'string' || !NATIVE_ID_RE.test(native.session_id)) {
        this.fail('Cursor print returned an invalid session id'); return;
      }
      if (this.nativeId && native.session_id !== this.nativeId) {
        this.fail('Cursor print returned a different session id on resume'); return;
      }
      if (!this.nativeId) {
        this.nativeId = native.session_id;
      }
      // A separate Continue creates a new managed step even with the same native ID.
      // Emit once for that logical session so its step has corroborating evidence.
      if (!this.sessionEventEmitted) {
        this.sessionEventEmitted = true;
        this.emit({ type: 'session', sessionId: native.session_id });
      }
      active.initSeen = true;
    }
    if (native.type === 'result') {
      if (!this.nativeId || native.session_id !== this.nativeId) {
        this.fail('Cursor print result had a different session id'); return;
      }
      active.resultSeen = true;
      if (!active.turnText && native.is_error !== true && typeof native.result === 'string') {
        active.turnText = native.result;
        this.emit({ type: 'text', text: native.result });
      }
    }
    if (native.type === 'assistant' || native.type === 'tool_call') {
      if (!active.initSeen) { this.fail('Cursor print emitted model work before session init'); return; }
      active.modelWorkSeen = true;
      if (active.receipt && !active.receipt.settled) {
        active.receipt.settled = true;
        active.receipt.resolve();
      }
    }
    const mapped = mapCursorPrintMessage(frame, this.uiState);
    this.uiState = mapped.state;
    for (const event of mapped.events) this.opts.onUiEvent?.(event);
    for (const event of mapCursorPrintStreamEvent(frame)) {
      if (event.type === 'session' || event.type === 'turn-end') continue;
      if (event.type === 'error') this.errorReported = true;
      if (event.type === 'text') active.turnText += event.text;
      this.emit(event);
    }
  }

  private async watchTurn(active: ActiveTurn): Promise<void> {
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let spawnError = false;
    try {
      const result = await active.process.exit;
      exitCode = result.code;
      signal = result.signal;
    } catch { spawnError = true; }
    await active.process.settled;
    if (this.active !== active || this.finished) return;
    this.active = undefined;
    if (this.noProgress) clearTimeout(this.noProgress);
    this.noProgress = undefined;
    if (active.receipt && !active.receipt.settled) {
      active.receipt.settled = true;
      if (active.resultSeen && !spawnError && exitCode === 0) active.receipt.resolve();
      else active.receipt.reject(new Error('Cursor print input admission was not confirmed'));
    }
    const completedTurn = active.resultSeen && !spawnError && exitCode === 0 && signal === null;
    if (completedTurn && !this.errorReported) {
      this.markerAsk = parseAskMarker(active.turnText) !== null;
      if (this.markerAsk) this.queue = [];
    }
    // The workflow can submit an autonomous follow-up synchronously from
    // turn-end. Admit it at this boundary, after the old process settled.
    if (completedTurn && !this.errorReported) this.busy = false;
    if (completedTurn) this.emit({ type: 'turn-end' });
    if (this.closing) { this.finish(); return; }
    if (spawnError) { this.fail('Cursor print process failed to start'); return; }
    if (exitCode !== 0 || signal !== null) {
      if (active.stderr.trim()) this.emit({ type: 'note', message: `Cursor print CLI stderr:\n${active.stderr}` });
      const detail = sanitizeCursorProviderError(summarizeRunnerStderr(active.stderr));
      const boundary = active.resultSeen ? 'after a reported result' : 'without a result frame';
      this.fail(`Cursor print exited ${boundary} (code ${exitCode ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`);
      return;
    }
    if (!active.resultSeen) { this.fail('Cursor print exited without a result frame'); return; }
    if (this.errorReported) { this.finish(); return; }
    if (!this.markerAsk && !this.busy) this.opts.onAgentInputReady?.();
    queueMicrotask(() => this.afterTurn());
  }

  private afterTurn(): void {
    if (!this.isOpen || this.busy || this.closing || this.markerAsk) return;
    const next = this.queue.shift();
    if (next) this.beginTurn(next);
    else this.scheduleAutoEnd();
  }
  private clearAutoEnd(): void { if (this.autoEnd) clearTimeout(this.autoEnd); this.autoEnd = undefined; }
  private scheduleAutoEnd(): void {
    if (!this.opts.autoEndAfterFirstTurn || this.busy || this.closing || this.markerAsk) return;
    this.clearAutoEnd();
    this.autoEnd = setTimeout(() => {
      this.autoEnd = undefined;
      if (!this.busy && this.opts.shouldAutoEnd?.() !== false) this.end();
    }, AUTO_END_DELAY_MS);
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.isOpen || this.closing) return false;
    if (this.busy) this.queue.push(content);
    else this.beginTurn(content);
    return true;
  }
  sendAgentMessage(content: ContentBlock[]): false | Promise<void> {
    if (!this.isOpen || this.closing || this.busy || this.queue.length || this.markerAsk) return false;
    return new Promise<void>((resolve, reject) => {
      const receipt = { resolve, reject, settled: false };
      this.beginTurn(content, receipt);
    });
  }
  discardQueuedMessages(): void {
    this.queue = [];
    if (!this.busy) this.opts.onAgentInputReady?.();
  }
  holdsHumanInput(): boolean { return this.queue.length > 0; }
  heldHumanInputCount(): number { return this.queue.length; }
  end(): void {
    if (this.closing || this.finished) return;
    this.closing = true;
    this.isOpen = false;
    this.clearAutoEnd();
    if (this.active) void this.active.process.stop('graceful');
    else this.finish();
  }
  interrupt(): void {
    if (this.finished) return;
    if (this.closing) {
      if (this.active) void this.active.process.stop('interrupt');
      return;
    }
    this.closing = true;
    this.isOpen = false;
    this.clearAutoEnd();
    if (this.active) void this.active.process.stop('interrupt');
    else this.finish();
  }
  private fail(message: string): void {
    if (this.finished) return;
    if (!this.errorReported) this.emit({ type: 'error', message: sanitizeCursorProviderError(message) });
    this.errorReported = true;
    this.interrupt();
  }
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.isOpen = false;
    if (this.deadline) clearTimeout(this.deadline);
    if (this.noProgress) clearTimeout(this.noProgress);
    this.clearAutoEnd();
    this.queue = [];
    if (this.scratch) {
      try { rmSync(this.scratch, { recursive: true, force: true }); } catch { /* cleanup is best effort */ }
    }
    this.emit({ type: 'done' });
    this.resolveResult({ text: this.texts.join('').trim(), toolCalls: this.toolCalls,
      tokensUsed: this.tokensUsed, sessionId: this.nativeId });
  }
}
