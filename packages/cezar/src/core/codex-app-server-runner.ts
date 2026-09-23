import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseEffort } from '@open-mercato/cezar-contract';
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
import { isSignalTerminationExit, prependSystemPrompt, trackChildExit } from './agent-runner.ts';
import {
  AUTO_END_DELAY_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  KILL_GRACE_MS,
} from './runner-runtime.ts';
import { parseAskRequest, type AskQuestion } from './ask.ts';
import { readNdjson } from './ndjson.ts';
import { V1TextCoalescer } from './v1-text-coalescer.ts';
import { InputSubmissions } from './input-submissions.ts';
import { codexTurnOutcome } from './codex-turn-outcome.ts';
import {
  CodexAppServerRpc,
  CodexRpcResponseError,
  codexSpawnError,
  endCodexAppServer,
  resolveCodexExecutable,
  spawnCodexAppServer,
  type CodexAppServerMessage,
  waitForCodexAppServerExit,
} from './codex-app-server-transport.ts';
import {
  codexSessionStarted,
  createCodexUiState,
  mapCodexNotification,
  type CodexUiMapping,
  type CodexUiMapperState,
} from './codex-ui-mapper.ts';

// One startup budget, including handshake ACKs and the first main-thread turn.
// This is not a model-turn or human-question lifetime limit.
const STARTUP_TIMEOUT_MS = 60_000;
// After real process exit, allow buffered output to drain before closing pipes
// a descendant may have inherited. This timer never proves termination.
const EXIT_DRAIN_MS = 250;

export interface CodexRunnerOptions {
  /** Override the binary name/path; defaults to `codex` on PATH. */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/**
 * `AgentRunner` over `codex app-server` — the same JSONL transport the VS Code
 * extension and desktop app use (JSON-RPC 2.0, newline-delimited, over
 * stdin/stdout). One long-lived process per session gives Codex the same
 * multi-turn shape as the Claude runner: `turn/start` for a new turn,
 * `turn/steer` for a mid-turn follow-up, `turn/interrupt` to cancel, and
 * `thread/resume` to reopen a stored thread for "Continue".
 *
 * Auth = the host's logged-in ChatGPT/Codex session (or CODEX_API_KEY). The
 * agent runs with cezar's sandbox choice and leaves approval policy to the
 * app-server default, so enterprise-managed permission modes keep working.
 * Codex has no per-tool allowlist, so
 * `spec.allowedTools` is ignored. `CEZ_CODEX_NETWORK=0` retains the previous
 * network-blocked `workspace-write` sandbox as an explicit restriction.
 */
/**
 * What the codex app-server receives from each `AgentRunSpec` field (#284).
 * Tool access does not cross this wire: the `auto` preset runs with cezar's
 * sandbox choice and the app-server default approval policy, and the
 * app-server has no per-tool allowlist, so `allowedTools`/`bashAllowlist` are declared dropped
 * rather than mapped (spec 2026-07-17-permission-modes). Held against the
 * recorded JSON-RPC by the harness parity matrix.
 */
export const CODEX_SPEC_SUPPORT: AgentRunSpecSupport = {
  cezarTools: { honored: true, via: 'thread/start and thread/resume dotted mcp_servers config with env_vars' },
  systemPrompt: { honored: true, via: 'prepended to the opening turn/start input through prependSystemPrompt' },
  userPrompt: { honored: true, via: 'turn/start input text' },
  images: { honored: false, reason: 'the adapter sends text input items only; image blocks are dropped' },
  cwd: { honored: true, via: 'spawn cwd, and the thread/start / thread/resume cwd' },
  allowedTools: { honored: false, reason: 'no per-tool allowlist on the app-server; the auto preset is danger-full-access with approvalPolicy never' },
  restrictNativeDelegation: { honored: true, via: 'thread/start and thread/resume config features.multi_agent=false, features.multi_agent_v2=false (D1)' },
  bashAllowlist: { honored: false, reason: 'no per-tool allowlist, so no command-prefix restriction either' },
  additionalDirectories: { honored: false, reason: 'the sandbox is danger-full-access, or workspace-write on cwd; no extra-root mapping' },
  env: { honored: true, via: 'merged over the child env through buildCodexAppServerEnv' },
  model: { honored: true, via: 'thread/start and thread/resume model' },
  effort: { honored: true, via: 'turn/start effort, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch on the child process' },
  sessionId: { honored: true, via: 'thread/resume threadId when resume is set; a fresh thread/start mints its own thread id' },
  resume: { honored: true, via: 'thread/resume in place of thread/start' },
};
export class CodexAppServerRunner implements AgentRunner {
  readonly backend = 'codex' as const;
  readonly specSupport = CODEX_SPEC_SUPPORT;
  readonly inputDelivery: InputDelivery = {
    mode: 'steer', consumption: 'observable',
    // The userMessage item marks the input entering the thread's history (probe 2026-09-24:
    // 0.8 s and 26.7 s after the steer, both before the tool ended); the next model call reads it.
    via: 'turn/steer with clientUserMessageId; item/started userMessage clientId once in the thread history',
  };

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: CodexSession | null = null;

  constructor(opts: CodexRunnerOptions = {}) {
    this.bin = resolveCodexExecutable(opts.bin);
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
    const session = new CodexSession(this.bin, this.timeoutMs, spec, onEvent, opts);
    this.lastSession = session;
    return session;
  }
}

interface PendingUserInput {
  readonly rpcId: number | string;
  readonly questions: AskQuestion[];
}

/** One live `codex app-server` process driving a single thread. */
class CodexSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;

  private readonly child!: ChildProcessWithoutNullStreams;
  private readonly rpc!: CodexAppServerRpc;
  private stdinOpen = true;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private agentInputReady = false;
  /** Accepted agent input not yet seen as a consumed userMessage item (#505). */
  private readonly submissions = new InputSubmissions();
  private inFlightSubmissionId: string | undefined;
  private refusedBeforeStartup = false;
  /** Submissions that opened a turn via turn/start rather than steering one. */
  private readonly turnStartSubmissions = new Set<string>();
  private agentSubmissionPending = false;
  private turnBoundaryVersion = 0;
  private pendingUserInput: PendingUserInput | undefined;
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private readonly textChunks: string[] = [];
  /** Streamed agentMessage deltas buffered per item — v1 `text` is emitted
   *  once per completed item (claude parity: one event per complete block),
   *  never per delta, so the persisted transcript and the headless CLI get
   *  whole paragraphs. Streaming display rides protocol v2's `item.delta`. */
  private readonly textCoalescer = new V1TextCoalescer((text) => {
    this.textChunks.push(text);
    this.emit({ type: 'text', text });
  });
  private tokensUsed = 0;
  private ready!: Promise<void>;
  private startupPhase = 'initialize';
  private openingAcknowledged = false;
  private firstTurnStarted = false;
  private startupComplete = false;
  private startupTimer: NodeJS.Timeout | undefined;
  private stopKillTimer: NodeJS.Timeout | undefined;
  private hardStopStarted = false;
  private failure: Error | undefined;
  private autoEndTimer: NodeJS.Timeout | undefined;
  private eofTermTimer: NodeJS.Timeout | undefined;
  private eofKillTimer: NodeJS.Timeout | undefined;
  private spawnFailed: Error | null = null;
  private timedOut = false;
  /** Set the moment WE signal the child (EOF watchdog, cancel, kill switch).
   *  codex handles the signal and exits 143, so without this the runner reads
   *  its own teardown as a codex failure (#703). */
  private terminatedByCezar = false;
  /** "Has the app-server really terminated?" — the question `child.killed`
   *  does not answer: it flips on signal delivery, so the SIGTERM this runner
   *  sends would otherwise veto its own SIGKILL escalation (#844). */
  private readonly hasExited: () => boolean;
  /** Protocol v2 emission — additive alongside v1 (`onEvent` keeps flowing
   *  byte-identical); the channel is `opts.onUiEvent` (RunManager wiring
   *  lands in R2 step 2.1). */
  private uiState: CodexUiMapperState = createCodexUiState();

  constructor(
    private readonly bin: string,
    timeoutMs: number,
    private readonly spec: AgentRunSpec,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
  ) {
    try {
      this.child = spawnCodexAppServer(bin, spec.cwd, spec.env);
      this.rpc = new CodexAppServerRpc(this.child, (error) => {
        if (!this.hardStopStarted && !this.hasExited()) this.fail(error);
      });
    } catch (err) {
      throw codexSpawnError(err, bin);
    }

    const hasExited = trackChildExit(this.child);
    this.hasExited = hasExited;
    // Observe termination BEFORE bootstrap. Pending RPCs cannot own the only
    // path to discovering that their process has already gone (#493).
    const exited = waitForCodexAppServerExit(this.child);
    let drainTimer: NodeJS.Timeout | undefined;
    this.child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.child.pid === undefined) {
        this.spawnFailed = codexSpawnError(err, bin);
        this.closeInput(this.spawnFailed.message);
        this.child.stdout.destroy();
      } else if (this.stdinOpen) {
        this.fail(new Error(`codex app-server process error while waiting for ${this.startupPhase}`));
      }
    });
    this.child.once('exit', (code, signal) => {
      if (this.stdinOpen && !this.startupComplete) {
        this.failure ??= new Error(`Codex startup exited (${signal ?? code ?? 'unknown'}) while waiting for ${this.startupPhase}`);
      }
      // Do not discard final buffered text on a healthy exit. Revoke RPCs
      // immediately, then bound pipe draining ONLY after physical termination.
      this.rpc.close('codex app-server exited');
      drainTimer = setTimeout(() => this.child.stdout.destroy(), EXIT_DRAIN_MS);
      drainTimer.unref?.();
      if (this.stopKillTimer) clearTimeout(this.stopKillTimer);
    });
    const stderrChunks: string[] = [];
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    // Whole-session timeouts remain optional; startup is always bounded.
    const limitMs = spec.timeoutMs ?? timeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        this.timedOut = true;
        this.interrupt();
      }, limitMs);
      deadline.unref?.();
    }
    this.startupTimer = setTimeout(() => {
      this.fail(new Error(`Codex startup timed out after 60s while waiting for ${this.startupPhase}`), 'timed out after 60s');
    }, STARTUP_TIMEOUT_MS);
    this.startupTimer.unref?.();

    this.ready = this.bootstrap();
    const reader = (async () => {
      try {
        for await (const line of readNdjson(this.child.stdout)) {
          let msg: CodexAppServerMessage;
          try { msg = JSON.parse(line) as CodexAppServerMessage; }
          catch { continue; }
          // Explicit shutdown suppresses late lifecycle, not passive output.
          // Natural exit can overtake the final turn frame: retain its outcome
          // without restoring ACK/ask/input authority on the dead connection.
          const finalOutcome = this.stdinOpen && hasExited() &&
            (msg.method === 'turn/completed' || msg.method === 'turn/failed');
          if (!this.open && (msg.id !== undefined || (!PASSIVE_OUTPUT_METHODS.has(msg.method ?? '') && !finalOutcome))) continue;
          // Child turn lifecycle must reach neither channel (#600).
          if (this.isForeignTurnLifecycle(msg)) continue;
          this.emitUi((state) => mapCodexNotification(msg, state));
          this.dispatch(msg);
        }
        if (this.stdinOpen && !hasExited()) {
          if (!this.startupComplete) this.fail(new Error(`Codex startup stdout closed while waiting for ${this.startupPhase}`));
          else this.end();
        }
      } catch {
        if (this.stdinOpen && !hasExited()) {
          this.fail(new Error(`codex app-server output failed while waiting for ${this.startupPhase}`));
        }
      }
    })();

    this.result = (async (): Promise<AgentRunResult> => {
      let exitCode: number | null;
      try {
        try {
          await Promise.all([this.ready, reader]);
        } catch (err) {
          if (this.stdinOpen && !hasExited()) this.fail(err instanceof Error ? err : new Error(String(err)));
        }
        // RPC cancellation is not a receipt for process termination. Keep the
        // TERM→KILL watchdog alive until this independently owned promise settles.
        exitCode = await exited;
        await reader;
      } finally {
        if (deadline) clearTimeout(deadline);
        if (drainTimer) clearTimeout(drainTimer);
        if (this.stopKillTimer) clearTimeout(this.stopKillTimer);
        if (this.eofTermTimer) clearTimeout(this.eofTermTimer);
        if (this.eofKillTimer) clearTimeout(this.eofKillTimer);
        this.closeInput('codex app-server exited');
        this.child.stdin.destroy();
        this.child.stderr.destroy();
      }

      if (this.spawnFailed) throw this.spawnFailed;
      if (this.failure) throw this.failure;

      // Timeout/interrupt can end the read loop mid-item — recover buffered prose.
      this.textCoalescer.flush();
      const text = this.textChunks.join('\n').trim();
      const base: AgentRunResult = {
        text,
        toolCalls: this.toolCalls,
        tokensUsed: this.tokensUsed,
        sessionId: this.threadId ?? spec.sessionId,
      };

      if (this.timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        this.emit({ type: 'error', message: `codex app-server timed out after ${mins}m and was killed` });
        this.emit({ type: 'done' });
        return base;
      }

      // Our own EOF watchdog / cancel signal coming back as 143/137 — the
      // teardown cezar asked for, not a codex failure (#703).
      if (this.terminatedByCezar && isSignalTerminationExit(exitCode)) {
        this.emit({
          type: 'note',
          message: `codex app-server did not exit on its own after close; terminated by cezar (code ${exitCode})`,
        });
        this.emit({ type: 'done' });
        return base;
      }

      if (exitCode !== 0 && exitCode !== null) {
        const stderr = stderrChunks.join('').trim();
        const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
        const message = `codex app-server exited with code ${exitCode}${detail}`;
        this.emit({ type: 'error', message });
        throw new Error(message);
      }

      this.emit({ type: 'done' });
      return base;
    })();
  }

  get open(): boolean {
    return this.stdinOpen && this.rpc.open && !this.hasExited();
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  sendAgentMessage(content: ContentBlock[], inputIds: readonly string[] = []): false | Promise<void> {
    // #505: a running turn is steered with turn/steer; only an unanswered native ask
    // or an in-flight submission refuses.
    // Until the thread and its first turn exist there is nothing to steer or start;
    // a refusal here earns one readiness hint when startup completes.
    if (this.open && !this.startupComplete) { this.refusedBeforeStartup = true; return false; }
    if (!this.open || this.pendingUserInput || this.agentSubmissionPending) return false;
    this.agentInputReady = false;
    this.agentSubmissionPending = true;
    if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
    this.autoEndTimer = undefined;
    const submissionId = randomUUID();
    this.submissions.accept(submissionId, inputIds, '');
    this.inFlightSubmissionId = submissionId;
    // Reserve synchronously; only the matching RPC result acknowledges delivery.
    return this.startOrSteerTurn(textOf(content), submissionId).catch((err: unknown) => {
      this.submissions.consume(submissionId); // never accepted: the caller keeps ownership
      if (this.stdinOpen) this.emit({ type: 'error', message: `codex: agent input failed: ${String(err)}` });
      throw err;
    }).finally(() => {
      this.agentSubmissionPending = false;
      if (this.inFlightSubmissionId === submissionId) this.inFlightSubmissionId = undefined;
      if (this.stdinOpen && this.agentInputReady && !this.pendingUserInput) {
        this.opts.onAgentInputReady?.();
        this.scheduleAutoEnd();
      }
    });
  }

  private scheduleAutoEnd(): void {
    if (!this.opts.autoEndAfterFirstTurn || !this.open || this.autoEndTimer || this.agentSubmissionPending) return;
    this.autoEndTimer = setTimeout(() => {
      this.autoEndTimer = undefined;
      if (this.opts.shouldAutoEnd?.() !== false) this.end();
    }, AUTO_END_DELAY_MS);
    this.autoEndTimer.unref?.();
  }

  sendMessage(content: ContentBlock[]): boolean {
    this.agentInputReady = false;
    if (!this.open) return false;
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    const text = textOf(content);
    if (!text) return true;
    if (this.pendingUserInput) {
      const pending = this.pendingUserInput;
      this.pendingUserInput = undefined;
      this.rpc.respond({ id: pending.rpcId, result: { answers: userInputAnswers(pending.questions, text) } });
      return this.open;
    }
    // Wait for the thread to exist, then steer the live turn or start a new one.
    void this.ready
      .then(() => this.startOrSteerTurn(text))
      .catch((err: unknown) => {
        if (this.stdinOpen) {
          const message = err instanceof Error ? err.message : String(err);
          this.emit({ type: 'note', message: `codex: turn failed: ${message}` });
        }
      });
    return true;
  }

  discardQueuedMessages(): void {}

  end(): void {
    if (!this.stdinOpen) return;
    this.closeInput('session ended');
    try {
      endCodexAppServer(
        this.child,
        (term, kill) => {
          this.eofTermTimer = term;
          this.eofKillTimer = kill;
        },
        () => {
          this.terminatedByCezar = true;
        },
      );
    } catch {
      // already gone
    }
  }

  interrupt(): void {
    if (this.hardStopStarted || this.hasExited()) return;
    this.hardStopStarted = true;
    if (this.eofTermTimer) clearTimeout(this.eofTermTimer);
    if (this.eofKillTimer) clearTimeout(this.eofKillTimer);
    // Native cancellation is best effort; never wait for its ACK to stop.
    if (this.stdinOpen && this.threadId && this.activeTurnId) {
      void this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId }).catch(() => undefined);
    }
    this.closeInput('codex session stopped');
    this.terminatedByCezar = true;
    this.child.kill('SIGTERM');
    this.stopKillTimer = setTimeout(() => {
      if (!this.hasExited()) this.child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    this.stopKillTimer.unref?.();
  }

  private closeInput(reason: string): void {
    this.stdinOpen = false;
    this.rejectPendingUserInput(reason);
    this.agentInputReady = false;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
    this.rpc.close(reason);
  }

  private fail(error: Error, diagnostic = 'failed'): void {
    if (!this.stdinOpen) return;
    this.failure ??= error;
    // Stage-only diagnostics never include prompt/config/env or raw stderr.
    const message = this.startupComplete ? 'Codex app-server failed; closing app-server'
      : `Codex startup ${diagnostic} while waiting for ${this.startupPhase}; closing app-server`;
    try { this.emit({ type: 'note', message }); }
    catch { /* A failing diagnostic sink cannot release a still-live process. */ }
    this.interrupt();
  }

  private assertOpen(): void {
    if (!this.open) throw new Error('codex session closed');
  }

  private startupWaitingFor(phase: string): void {
    this.assertOpen();
    this.startupPhase = phase;
    this.emit({ type: 'note', message: `Codex startup: waiting for ${phase}` });
  }

  private checkStartupComplete(): void {
    if (!this.openingAcknowledged || !this.firstTurnStarted || !this.stdinOpen) return;
    if (this.startupComplete) return;
    this.startupComplete = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    // Input refused during startup can now steer the opening turn (#505).
    if (this.refusedBeforeStartup) queueMicrotask(() => {
      this.refusedBeforeStartup = false;
      if (this.open && !this.pendingUserInput && !this.agentSubmissionPending) this.opts.onAgentInputReady?.();
    });
  }

  // ---- protocol -----------------------------------------------------------

  private async bootstrap(): Promise<void> {
    this.startupWaitingFor('initialize');
    await this.rpc.initialize();
    this.assertOpen();

    const overrides = {
      model: this.spec.model,
      cwd: this.spec.cwd,
      // Full access is the `auto` preset shared by all backends. Besides avoiding prompts, this
      // keeps container installs working when bubblewrap cannot create a UID map (#563).
      // CEZ_CODEX_NETWORK=0 remains the backwards-compatible explicit sandbox opt-out.
      sandbox: process.env.CEZ_CODEX_NETWORK === '0' ? 'workspace-write' : 'danger-full-access',
      // ThreadStartParams AND ThreadResumeParams accept dotted config overrides.
      // Both feature generations exist in Codex 0.153.4; no global config write.
      ...((this.spec.restrictNativeDelegation || this.spec.cezarTools) ? { config: {
        ...(this.spec.restrictNativeDelegation ? { 'features.multi_agent': false, 'features.multi_agent_v2': false } : {}),
        ...(this.spec.cezarTools ? { [`mcp_servers.${this.spec.cezarTools.name}`]: { command: this.spec.cezarTools.command, args: this.spec.cezarTools.args, env_vars: ['CEZ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET'] } } : {}),
      } } : {}),
    };
    if (this.spec.resume && this.spec.sessionId) {
      this.startupWaitingFor('thread/resume');
      await this.rpc.request('thread/resume', { threadId: this.spec.sessionId, ...clean(overrides) });
      this.assertOpen();
      this.threadId = this.spec.sessionId;
    } else {
      this.startupWaitingFor('thread/start');
      const res = await this.rpc.request('thread/start', clean(overrides));
      this.assertOpen();
      this.threadId = threadIdOf(res) ?? this.spec.sessionId;
    }
    if (this.threadId) {
      this.emit({ type: 'session', sessionId: this.threadId });
      // The result path (thread/start response, or thread/resume which sends
      // no thread/started notification) — deduplicated inside the mapper.
      const threadId = this.threadId;
      this.emitUi((state) => codexSessionStarted(threadId, state));
    }

    // Seed the first turn. The system prompt (skill body + handoff contract)
    // has no dedicated app-server field, so it rides along as a leading block
    // of the opening message.
    const first = prependSystemPrompt(this.spec.systemPrompt, this.spec.userPrompt);
    this.startupWaitingFor('turn/start');
    await this.startOrSteerTurn(first);
    this.assertOpen();
    this.openingAcknowledged = true;
    this.checkStartupComplete();
    if (!this.startupComplete) this.startupWaitingFor('first main-thread turn');
  }

  private async startOrSteerTurn(text: string, clientUserMessageId?: string): Promise<void> {
    this.assertOpen();
    if (!this.threadId) throw new Error('codex app-server did not return a thread id');
    this.agentInputReady = false;
    const input = [{ type: 'text', text, text_elements: [] }];
    // Echoed as the consumed userMessage item's `clientId` (#505).
    const ids = clientUserMessageId ? { clientUserMessageId } : {};
    if (this.activeTurnId) {
      const boundary = this.turnBoundaryVersion;
      try {
        await this.rpc.request('turn/steer', {
          threadId: this.threadId,
          input,
          expectedTurnId: this.activeTurnId,
          ...ids,
        });
        // Accepted, but the turn completed before the model read it: nothing will read
        // it now, so start a turn with it under the same client id (#505).
        const stranded = clientUserMessageId !== undefined && this.turnBoundaryVersion !== boundary &&
          !this.activeTurnId && this.submissions.has(clientUserMessageId);
        if (!stranded) return;
      } catch (err) {
        // Only a definitive refusal falls back: the server answered with an error AND
        // the turn ended meanwhile. A timeout or closed transport is ambiguous — the
        // steer may have landed — so it rejects without a retry (#505).
        if (!(err instanceof CodexRpcResponseError) || this.turnBoundaryVersion === boundary || this.activeTurnId) throw err;
      }
    }
    // Ask the app-server for reasoning summaries; without this the model runs
    // with its default (no summary), so the reasoning thread stays empty even
    // though the mapper and UI can render it. The override persists for this
    // turn and every subsequent turn, so seeding it on turn/start is enough.
    const boundaryVersion = this.turnBoundaryVersion;
    const res = await this.rpc.request('turn/start', {
      threadId: this.threadId,
      input,
      ...ids,
      ...codexTurnStartExtras(this.spec),
    });
    // This turn's own input: its completion proves the model processed it (#505).
    if (clientUserMessageId) this.turnStartSubmissions.add(clientUserMessageId);
    if (this.turnBoundaryVersion === boundaryVersion) this.activeTurnId = turnIdOf(res) ?? this.activeTurnId;
  }

  private dispatch(msg: CodexAppServerMessage): void {
    if (this.rpc.dispatchResponse(msg)) return;
    if (msg.method === 'item/tool/requestUserInput' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
      this.handleUserInputRequest(msg.id, msg.params ?? {});
      return;
    }
    if (typeof msg.method === 'string') this.handleNotification(msg.method, msg.params ?? {});
  }

  private handleUserInputRequest(rpcId: number | string, params: Record<string, unknown>): void {
    const questions = codexAskQuestions(params.questions);
    if (!questions) {
      this.rpc.respond({ id: rpcId, error: { code: -32602, message: 'unsupported or malformed requestUserInput payload' } });
      return;
    }
    if (this.pendingUserInput) this.rejectPendingUserInput('superseded by a newer requestUserInput');
    this.pendingUserInput = { rpcId, questions };
    this.opts.onUiEvent?.({ type: 'ask.requested', requestId: `codex-${String(rpcId)}`, questions });
  }

  private rejectPendingUserInput(message: string): void {
    const pending = this.pendingUserInput;
    if (!pending) return;
    this.pendingUserInput = undefined;
    this.rpc.respond({ id: pending.rpcId, error: { code: -32000, message } });
  }

  /** True when a turn notification belongs to a sub-agent CHILD thread rather than this run's
   *  own main thread — its lifecycle must not start or end the parent turn (#600). The app-server
   *  multiplexes every thread over one connection, so a spawned skill's child `turn/completed`
   *  would otherwise emit a `turn-end` and park the actively-working run under "Needs you".
   *  Fail-open: an absent `threadId` (the single-thread wire shape) or our own id counts as ours. */
  private isForeignThreadTurn(params: Record<string, unknown>): boolean {
    const eventThreadId = stringField(params, 'threadId');
    return !!eventThreadId && !!this.threadId && eventThreadId !== this.threadId;
  }

  /** A `turn/started|completed|failed` notification for a sub-agent child thread — dropped
   *  before either channel processes it (#600). Only turn lifecycle is filtered; child item
   *  events still map, so nested sub-agent activity keeps rendering. */
  private isForeignTurnLifecycle(msg: CodexAppServerMessage): boolean {
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (!method || !TURN_LIFECYCLE_METHODS.has(method)) return false;
    return this.isForeignThreadTurn((msg.params ?? {}) as Record<string, unknown>);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'turn/started': {
        if (!this.isForeignThreadTurn(params)) this.turnBoundaryVersion += 1;
        if (this.isForeignThreadTurn(params)) break; // sub-agent child thread — not our turn (#600)
        if (this.threadId && turnIdOf(params)) {
          this.firstTurnStarted = true;
          this.checkStartupComplete();
        }
        this.activeTurnId = turnIdOf(params) ?? this.activeTurnId;
        break;
      }
      case 'item/agentMessage/delta': {
        // Child text belongs only to v2; buffering it here would pollute the
        // parent's marker parse when the coalescer flushes at turn-end (#149).
        if (this.isForeignThreadTurn(params)) break;
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) this.textCoalescer.append(stringField(params, 'itemId'), delta);
        break;
      }
      case 'item/started': {
        const item = (params.item as Record<string, unknown>) ?? {};
        const type = stringField(item, 'type');
        if (type === 'userMessage' && !this.isForeignThreadTurn(params)) {
          // The model received this input now; `clientId` names our submission (#505).
          const clientId = stringField(item, 'clientId');
          const ids = clientId ? this.submissions.consume(clientId) : [];
          if (ids.length) this.opts.onAgentInputConsumed?.(ids);
        }
        // Only tool-like items become tool events; message/reasoning stream as text.
        if (type && !NON_TOOL_ITEMS.has(type)) {
          const id = stringField(item, 'id') ?? `item-${this.rpc.allocateId()}`;
          this.toolCalls.push({ id, name: type, input: item });
          this.emit({ type: 'tool-call', id, tool: type, input: item });
        }
        break;
      }
      case 'item/completed': {
        const item = (params.item as Record<string, unknown>) ?? {};
        const type = stringField(item, 'type');
        const id = stringField(item, 'id') ?? '';
        if (type === 'agentMessage') {
          if (this.isForeignThreadTurn(params)) break;
          // One v1 `text` per finished message — the snapshot's full text when
          // present (also covers turns that send no deltas), else the deltas.
          this.textCoalescer.complete(id || undefined, typeof item.text === 'string' ? item.text : undefined);
        } else if (type && !NON_TOOL_ITEMS.has(type) && id) {
          this.emit({
            type: 'tool-result',
            toolCallId: id,
            result: safeStringify(item),
            isError: /error|failed/i.test(stringField(item, 'status') ?? ''),
          });
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const total = tokenTotal(params);
        if (total > 0) {
          this.tokensUsed = total;
          this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed });
        }
        break;
      }
      case 'turn/completed':
      case 'turn/failed': {
        if (this.isForeignThreadTurn(params)) break; // don't end the parent turn on a child turn (#600)
        this.turnBoundaryVersion += 1;
        this.pendingUserInput = undefined;
        this.activeTurnId = undefined;
        // An interrupted/failed item never sees item/completed — surface its
        // partial prose before the turn boundary (run.ts reads markers there).
        this.textCoalescer.flush();
        const outcome = codexTurnOutcome(method, params);
        if (outcome.error !== undefined && !this.terminatedByCezar) {
          this.emit({ type: 'error', message: outcome.error });
        }
        this.agentInputReady = this.open;
        // A completed turn processed its own input; a failed one may never have reached the
        // model, so its input stays pending and is reported unconsumed below.
        const started = outcome.error === undefined ? [...this.turnStartSubmissions].flatMap(id => this.submissions.consume(id)) : [];
        this.turnStartSubmissions.clear();
        if (started.length) this.opts.onAgentInputConsumed?.(started);
        // An in-flight steer is owned by its RPC outcome, not by this boundary.
        const inFlight = this.inFlightSubmissionId ? this.submissions.consume(this.inFlightSubmissionId) : [];
        const unconsumedInputIds = this.submissions.takeUnconsumed();
        if (this.inFlightSubmissionId && inFlight.length) this.submissions.accept(this.inFlightSubmissionId, inFlight, '');
        this.emit(unconsumedInputIds.length ? { type: 'turn-end', unconsumedInputIds } : { type: 'turn-end' });
        this.scheduleAutoEnd();
        break;
      }
      default:
        break;
    }
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  /** The mapper never throws, but a defect in it must still never disturb
   *  the v1 stream — hence the belt-and-braces try. */
  private emitUi(map: (state: CodexUiMapperState) => CodexUiMapping): void {
    try {
      const mapped = map(this.uiState);
      this.uiState = mapped.state;
      if (this.opts.onUiEvent) {
        for (const event of mapped.events) this.opts.onUiEvent(event);
      }
    } catch {
      // v2 mapping is best-effort; v1 consumers stay unaffected.
    }
  }
}

// ---- helpers --------------------------------------------------------------

function codexAskQuestions(value: unknown): AskQuestion[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const questions: unknown[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const question = raw as Record<string, unknown>;
    if (question.isSecret === true) return null;
    const id = stringField(question, 'id');
    const header = stringField(question, 'header');
    const prompt = stringField(question, 'question');
    if (!id || !header || !prompt || !Array.isArray(question.options)) return null;
    const options = question.options.map((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
      const record = option as Record<string, unknown>;
      const label = stringField(record, 'label');
      const description = stringField(record, 'description');
      return label ? { label, ...(description ? { description } : {}) } : null;
    }).filter((option): option is { label: string; description?: string } => option !== null);
    questions.push({ id, header, question: prompt, options, multiSelect: false });
  }
  return parseAskRequest({ questions })?.questions ?? null;
}

function userInputAnswers(questions: AskQuestion[], text: string): Record<string, { answers: string[] }> {
  const lines = text.split(/\r?\n/);
  const hasStructuredAnswer = questions.some((question) => lines.some((line) => line.startsWith(`${question.header}:`)));
  const answers: Record<string, { answers: string[] }> = {};
  for (const [index, question] of questions.entries()) {
    const prefix = `${question.header}:`;
    const matching = lines.find((line) => line.startsWith(prefix));
    const raw = matching?.slice(prefix.length).trim() ?? (!hasStructuredAnswer && index === 0 ? text.trim() : '');
    answers[question.id ?? String(index)] = {
      answers: raw === '' ? [] : raw.split(',').map((answer) => answer.trim()).filter(Boolean),
    };
  }
  return answers;
}

/** ThreadItem `type`s that are conversation text, not tool activity. */
const NON_TOOL_ITEMS = new Set(['agentMessage', 'userMessage', 'reasoning', 'plan']);

/** Turn-lifecycle notification methods — the only frames whose child-thread copies must be
 *  dropped so a sub-agent turn can't be mistaken for the parent's (#600). */
const TURN_LIFECYCLE_METHODS = new Set(['turn/started', 'turn/completed', 'turn/failed']);

/** Notifications that only collect output; never dispatch control after close. */
const PASSIVE_OUTPUT_METHODS = new Set([
  'item/started', 'item/updated', 'item/completed', 'item/agentMessage/delta',
  'item/reasoning/textDelta', 'item/reasoning/summaryDelta', 'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta', 'thread/tokenUsage/updated', 'turn/plan/updated',
]);

const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);

/**
 * The reasoning-summary override sent on `turn/start` (TurnStartParams.summary).
 * Defaults to `auto` so reasoning is visible out of the box — without it the
 * app-server runs with its own default (no summary) and the reasoning thread
 * stays empty even when the model reasons. `CEZ_CODEX_REASONING` overrides the
 * default (`auto`/`concise`/`detailed`, or `none` to opt out); an unrecognized
 * value falls back to `auto`.
 */
export function reasoningSummary(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CEZ_CODEX_REASONING?.trim().toLowerCase();
  if (!raw) return 'auto';
  return REASONING_SUMMARIES.has(raw) ? raw : 'auto';
}

/**
 * Fields sent on `turn/start` besides thread/input. `summary` is the existing
 * `CEZ_CODEX_REASONING` knob (out of scope for #45). `effort` is the per-run
 * pin — omitted when unset so the app-server keeps its default.
 */
export function codexTurnStartExtras(
  spec: Pick<AgentRunSpec, 'effort'>,
  env: NodeJS.ProcessEnv = process.env,
): { summary: string; effort?: string } {
  const effort = parseEffort(spec.effort);
  return {
    summary: reasoningSummary(env),
    ...(effort ? { effort } : {}),
  };
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Drop undefined values so we never send `"model": null` to the server. */
function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function threadIdOf(res: Record<string, unknown>): string | undefined {
  const thread = res.thread as { id?: unknown } | undefined;
  return typeof thread?.id === 'string' ? thread.id : stringField(res, 'threadId');
}

function turnIdOf(obj: Record<string, unknown>): string | undefined {
  const turn = obj.turn as { id?: unknown } | undefined;
  return typeof turn?.id === 'string' ? turn.id : stringField(obj, 'turnId');
}

/** Cumulative tokens from a `thread/tokenUsage/updated` notification:
 *  `params.tokenUsage.total.totalTokens`. */
function tokenTotal(params: Record<string, unknown>): number {
  const usage = params.tokenUsage as { total?: { totalTokens?: unknown } } | undefined;
  const total = usage?.total?.totalTokens;
  return typeof total === 'number' ? total : 0;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
