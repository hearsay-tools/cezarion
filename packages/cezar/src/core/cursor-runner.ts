import { fileURLToPath } from 'node:url';
import type { SessionTransport } from '@open-mercato/cezar-contract';
import type {
  AgentEvent, AgentRunResult, AgentRunner, AgentRunSpec, AgentSession, ContentBlock,
  InputDelivery, SessionOptions,
} from './agent-runner.ts';
import { CursorAcpRunner } from './cursor-acp-runner.ts';
import { CursorPrintRunner, CURSOR_PRINT_SPEC_SUPPORT } from './cursor-print-runner.ts';
import { inspectCursorPrintCapabilities } from './cursor-print-capabilities.ts';
import type { CursorPrintCapabilityResult } from './cursor-print-capabilities.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface CursorRunnerOptions {
  sessionTransport?: SessionTransport;
  bin?: string;
  inspect?: (bin: string, spec: AgentRunSpec, signal?: AbortSignal) => Promise<CursorPrintCapabilityResult>;
  makeAcp?: () => AgentRunner;
  makePrint?: (models?: readonly ModelOption[]) => AgentRunner;
}

/** Selects one Cursor transport before inference; persisted identity always wins over defaults. */
export class CursorRunner implements AgentRunner {
  readonly backend = 'cursor' as const;
  readonly specSupport = CURSOR_PRINT_SPEC_SUPPORT;
  readonly systemPromptOnResume = 'in-thread' as const;
  readonly inputDelivery: InputDelivery = {
    mode: 'boundary', consumption: 'unobservable', via: 'selected Cursor session turn boundary',
  };
  private lastSession?: AgentSession;

  constructor(private readonly options: CursorRunnerOptions = {}) {}

  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts: SessionOptions = {}): AgentSession {
    const bin = this.options.bin ?? process.env.CEZ_CURSOR_BIN ?? (process.env.CEZ_DRY_RUN === '1'
      ? fileURLToPath(new URL('../../scripts/mock-cursor-print.mjs', import.meta.url)) : 'agent');
    const select = async (signal: AbortSignal): Promise<{ transport: SessionTransport; note?: string; models?: readonly ModelOption[]; model?: string }> => {
      if (this.options.sessionTransport === 'cursor-acp') return { transport: 'cursor-acp' };
      if (this.options.sessionTransport === 'cursor-print') {
        if (process.env.CEZ_DRY_RUN === '1' && !this.options.bin && !process.env.CEZ_CURSOR_BIN) {
          return { transport: 'cursor-print' };
        }
        const capability = await (this.options.inspect ?? inspectCursorPrintCapabilities)(bin, spec, signal);
        if (!capability.supported) throw new Error(`Cursor print session cannot resume: ${capability.reason}`);
        return { transport: 'cursor-print', models: capability.models, model: capability.model };
      }
      if (spec.resume) return { transport: 'cursor-acp' }; // Legacy untagged Cursor ID.
      if (process.env.CEZ_DRY_RUN === '1' && !this.options.bin && !process.env.CEZ_CURSOR_BIN) {
        return { transport: 'cursor-print' };
      }
      const capability = await (this.options.inspect ?? inspectCursorPrintCapabilities)(bin, spec, signal);
      return capability.supported
        ? { transport: 'cursor-print', models: capability.models, model: capability.model }
        : { transport: 'cursor-acp', note: `Cursor marketplace plugins unavailable: ${capability.reason}` };
    };
    const makeRunner = (transport: SessionTransport, models?: readonly ModelOption[]): AgentRunner => transport === 'cursor-print'
      ? (this.options.makePrint?.(models) ?? new CursorPrintRunner({ bin: this.options.bin, models }))
      : (this.options.makeAcp?.() ?? new CursorAcpRunner({ bin: this.options.bin }));
    return this.lastSession = new SelectingCursorSession(select, makeRunner, spec, onEvent, opts);
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> { this.lastSession?.interrupt(); }
}

class SelectingCursorSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;
  private resolveResult!: (result: AgentRunResult) => void;
  private inner?: AgentSession;
  private controller = new AbortController();
  private pendingHuman: ContentBlock[][] = [];
  private active = true;
  private settled = false;

  constructor(
    select: (signal: AbortSignal) => Promise<{ transport: SessionTransport; note?: string; models?: readonly ModelOption[]; model?: string }>,
    makeRunner: (transport: SessionTransport, models?: readonly ModelOption[]) => AgentRunner,
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ) {
    this.result = new Promise(resolve => { this.resolveResult = resolve; });
    void (async () => {
      try {
        const { transport, note, models, model } = await select(this.controller.signal);
        if (!this.active) return;
        if (note) onEvent?.({ type: 'note', message: note });
        const runner = makeRunner(transport, models);
        const selectedSpec = model && !spec.model ? { ...spec, model } : spec;
        const inner = runner.startSession(selectedSpec, event => onEvent?.(event.type === 'session'
          ? { ...event, sessionTransport: transport } : event), opts);
        this.inner = inner;
        if (inner.pid !== undefined) opts.onPidChange?.(inner.pid);
        for (const message of this.pendingHuman.splice(0)) inner.sendMessage(message);
        const result = await inner.result;
        this.settle(result);
      } catch (error) {
        if (!this.active) return;
        onEvent?.({ type: 'error', message: error instanceof Error ? error.message : 'Cursor transport selection failed' });
        this.settle({ text: '', toolCalls: [], tokensUsed: 0 });
      }
    })();
  }

  private settle(result: AgentRunResult): void {
    if (this.settled) return;
    this.settled = true;
    this.active = false;
    this.resolveResult(result);
  }
  get pid(): number | undefined { return this.inner?.pid; }
  get open(): boolean { return this.active && (this.inner?.open ?? true); }
  sendMessage(content: ContentBlock[]): boolean {
    if (!this.open) return false;
    if (this.inner) return this.inner.sendMessage(content);
    this.pendingHuman.push(content);
    return true;
  }
  sendAgentMessage(content: ContentBlock[], ids?: readonly string[]): false | Promise<void> {
    return this.inner?.sendAgentMessage(content, ids) ?? false;
  }
  discardQueuedMessages(): void { this.pendingHuman = []; this.inner?.discardQueuedMessages(); }
  holdsHumanInput(): boolean { return this.inner?.holdsHumanInput() ?? this.pendingHuman.length > 0; }
  heldHumanInputCount(): number { return this.inner?.heldHumanInputCount?.() ?? this.pendingHuman.length; }
  end(): void {
    if (!this.active) return;
    if (this.inner) this.inner.end();
    else { this.active = false; this.controller.abort(); this.settle({ text: '', toolCalls: [], tokensUsed: 0 }); }
  }
  interrupt(): void {
    if (!this.active) return;
    if (this.inner) this.inner.interrupt();
    else { this.active = false; this.controller.abort(); this.settle({ text: '', toolCalls: [], tokensUsed: 0 }); }
  }
}
