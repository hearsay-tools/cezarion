import { fileURLToPath } from 'node:url';
import type { SessionTransport } from '@open-mercato/cezar-contract';
import type {
  AgentEvent, AgentRunResult, AgentRunner, AgentRunSpec, AgentSession, ContentBlock,
  InputDelivery, SessionOptions,
} from './agent-runner.ts';
import { CursorPrintRunner, CURSOR_PRINT_SPEC_SUPPORT } from './cursor-print-runner.ts';
import { inspectCursorPrintCapabilities } from './cursor-print-capabilities.ts';
import type { CursorPrintCapabilityResult } from './cursor-print-capabilities.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface CursorRunnerOptions {
  sessionTransport?: SessionTransport;
  bin?: string;
  inspect?: (bin: string, spec: AgentRunSpec, signal?: AbortSignal) => Promise<CursorPrintCapabilityResult>;
  makePrint?: (models?: readonly ModelOption[], resolvedModel?: string) => AgentRunner;
}

interface CursorSelection {
  models?: readonly ModelOption[] | undefined; model?: string | undefined; resolvedModel?: string | undefined;
}

/** A Continue of a session that ran on the removed ACP transport (hearsay-tools/cezarion#1267). */
export const CURSOR_ACP_RESUME_REFUSED = 'This Cursor session was started on the ACP transport, which Cezarion no longer '
  + 'supports, so it cannot resume. Start a new task to continue this work.';

/** The step error for a Cursor build that fails print qualification (hearsay-tools/cezarion#1267). */
export function cursorPrintUnsupportedMessage(reason: string): string {
  return `Cursor CLI cannot run this task: ${reason}. Run "agent update" to install a supported Cursor CLI, `
    + 'or update Cezarion if your build is newer than this version supports.';
}

/**
 * Runs every Cursor session on print, after a pre-inference qualification check. ACP sessions
 * were removed in hearsay-tools/cezarion#1267: a resume recorded on ACP, or an untagged resume
 * from before print existed, fails before any session starts, and so does an unqualified build.
 */
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
    const bundledPrintMock = fileURLToPath(new URL('../../scripts/mock-cursor-print.mjs', import.meta.url));
    const bin = this.options.bin ?? process.env.CEZ_CURSOR_BIN ?? (process.env.CEZ_DRY_RUN === '1'
      ? bundledPrintMock : 'agent');
    const isBundledMock = bin === bundledPrintMock;
    const mockModels: readonly ModelOption[] = [
      { id: 'mock-default-model', label: 'Mock default', description: 'Default model' },
      { id: 'mock-default-model-xhigh', label: 'Mock high effort', description: 'Mock high effort' },
    ];
    const select = async (signal: AbortSignal): Promise<CursorSelection> => {
      // An untagged resume predates print sessions, so its native ID belongs to ACP.
      if (spec.resume && this.options.sessionTransport !== 'cursor-print') throw new Error(CURSOR_ACP_RESUME_REFUSED);
      if (isBundledMock) {
        return { models: spec.effort ? mockModels : undefined,
          model: spec.effort && !spec.model ? 'mock-default-model' : undefined };
      }
      const capability = await (this.options.inspect ?? inspectCursorPrintCapabilities)(bin, spec, signal);
      if (!capability.supported) throw new Error(cursorPrintUnsupportedMessage(capability.reason));
      return { models: capability.models, model: capability.model, resolvedModel: capability.resolvedModel };
    };
    const makeRunner = (models?: readonly ModelOption[], resolvedModel?: string): AgentRunner =>
      this.options.makePrint?.(models, resolvedModel)
        ?? new CursorPrintRunner({ bin: this.options.bin, models, resolvedModel });
    return this.lastSession = new SelectingCursorSession(select, makeRunner, spec, onEvent, opts);
  }

  async interrupt(): Promise<void> { this.lastSession?.interrupt(); }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

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
    select: (signal: AbortSignal) => Promise<CursorSelection>,
    makeRunner: (models?: readonly ModelOption[], resolvedModel?: string) => AgentRunner,
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ) {
    this.result = new Promise(resolve => { this.resolveResult = resolve; });
    void (async () => {
      try {
        const { models, model, resolvedModel } = await select(this.controller.signal);
        if (!this.active) return;
        const runner = makeRunner(models, resolvedModel);
        const selectedSpec = model && !spec.model ? { ...spec, model } : spec;
        const inner = runner.startSession(selectedSpec, event => onEvent?.(event.type === 'session'
          ? { ...event, sessionTransport: 'cursor-print' } : event), opts);
        this.inner = inner;
        if (inner.pid !== undefined) opts.onPidChange?.(inner.pid);
        for (const message of this.pendingHuman.splice(0)) inner.sendMessage(message);
        const result = await inner.result;
        this.settle(result);
      } catch (error) {
        if (!this.active) return;
        const message = error instanceof Error ? error.message : 'Cursor print qualification failed';
        onEvent?.({ type: 'error', message });
        opts.onUiEvent?.({ type: 'session.error', message, fatal: true });
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
