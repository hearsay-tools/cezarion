import { opencodeSkillWarning } from './opencode-session-error.ts';
import { summarizeRunnerStderr } from './runner-stderr.ts';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseEffort } from '@open-mercato/cezar-contract';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentToolCallRecord,
  ContentBlock,
  AgentRunSpecSupport,
  InputDelivery,
} from './agent-runner.ts';
import { InputSubmissions } from './input-submissions.ts';
import type { AgentSession, SessionOptions } from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt, trackChildExit } from './agent-runner.ts';
import { signalSession, spawnSessionLeader } from './session-process.ts';
import { buildChildEnv } from './agent-env.ts';
import { ciOpenCodeEnv } from '../ci-wait/injection.ts';
import { parseAskRequest, type AskQuestion } from './ask.ts';
import { boundOutputDrainAfterExit, AUTO_END_DELAY_MS, DEFAULT_RUN_TIMEOUT_MS } from './runner-runtime.ts';
import { formatModelIdentity, parseModelIdentity } from './model-identity.ts';
import { V1TextCoalescer } from './v1-text-coalescer.ts';
import {
  createOpencodeUiState,
  mapOpencodeEvent,
  opencodeSessionStarted,
  opencodeTurnStarted,
  type OpencodeUiMapperState,
  type OpencodeUiMapping,
} from './opencode-ui-mapper.ts';

export interface OpencodeRunnerOptions {
  /** Override the binary name/path; defaults to `opencode` on PATH. */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
  /** Tests only: how long a start may stay silent before the requested port is
   *  assumed. Production keeps `SERVER_START_TIMEOUT_MS`. */
  serverStartTimeoutMs?: number;
}

interface PendingOpencodeQuestion {
  requestId?: string;
  askRequestId: string;
  questions: AskQuestion[];
}

const SERVER_START_TIMEOUT_MS = 30_000;

/**
 * Pause before the one retry of a server that exited before listening (#872).
 * opencode 1.18.33, started within ~2 s of SIGTERM to the previous server on
 * the same DB, printed `ServeError` and exited; the next start succeeded. The
 * failing start can die well inside that window, so the pause alone spans it;
 * it is only ever paid by a start that already failed.
 */
export const SERVE_START_RETRY_DELAY_MS = 2_000;

/** One `opencode serve` process — a session has one, or two after a retried start. */
interface ServeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  /** "Has the server actually terminated?" — never `child.killed`, which only
   *  reports delivery and would disarm the escalation (#844/#858). */
  readonly hasExited: () => boolean;
  /** Settles on `exit` or `close`. */
  readonly exited: Promise<void>;
  /** Settles once stdout and stderr are drained (bounded after exit). */
  readonly outputDrained: Promise<unknown>;
  readonly stderrChunks: string[];
  /** The port requested on the command line; the fallback when no URL is printed. */
  readonly port: number;
  /** ENOENT and friends: the process never ran, so it is never retried. */
  spawnFailed: Error | null;
  /** One teardown per process — see `terminate()`. */
  signalled: boolean;
}

/** The URL wait saw the process exit before it printed a URL. */
class ServeExitedBeforeListening extends Error {
  constructor() {
    super('opencode serve exited before it started listening');
  }
}

/** Grace between the teardown SIGTERM and the SIGKILL that follows it. */
export const KILL_GRACE_MS = 4_000;

/**
 * `AgentRunner` over `opencode serve` — a headless HTTP server (the same one
 * the opencode TUI talks to) with an SSE event stream. One server per session,
 * bound to the run's `cwd` (worktree), gives OpenCode the same multi-turn shape
 * as the Claude runner: each `sendMessage` posts another prompt to the same
 * session (history is kept server-side), and `session/abort` cancels.
 * Continue and restart recovery GET /session/{id} and prompt that session; a 404
 * falls back to one fresh session with the full system prompt.
 *
 * Auth = the host's opencode config/logins. The agent runs autonomously
 * (auto-approved permissions); this adapter does not map `spec.allowedTools`.
 * Governed delegation adds only a supported session-level task deny rule.
 * `spec.model` is `provider/model`.
 */
/**
 * What `opencode serve` receives from each `AgentRunSpec` field (#284). The
 * server auto-approves permissions and this adapter maps no per-tool
 * allowlist, so `allowedTools`/`bashAllowlist` are declared dropped rather than
 * mapped (spec 2026-07-17-permission-modes). Resume GETs `/session/{id}` and
 * prompts it; a 404 opens one fresh session. Held against the recorded HTTP
 * requests by the harness parity matrix.
 */
export const OPENCODE_SPEC_SUPPORT: AgentRunSpecSupport = {
  cezarTools: { honored: true, via: 'merged OPENCODE_CONFIG_CONTENT local mcp entry' },
  systemPrompt: { honored: true, via: 'prepended to the opening prompt_async text through prependSystemPrompt' },
  userPrompt: { honored: true, via: 'prompt_async text part' },
  images: { honored: false, reason: 'the adapter posts text parts only; image blocks are dropped' },
  cwd: { honored: true, via: 'opencode serve spawn cwd; the session is bound to it' },
  allowedTools: { honored: false, reason: 'permissions are auto-approved server-side and no per-tool allowlist is mapped' },
  restrictNativeDelegation: { honored: true, via: 'POST /session permission rule denying task (D1); PATCH /session/{id} permission on resume when the deny is absent — the deny persists on the session once added (a later unrestricted Continue cannot remove it; fails closed)' },
  bashAllowlist: { honored: false, reason: 'no per-tool allowlist is mapped, so no command-prefix restriction either' },
  additionalDirectories: { honored: false, reason: 'the server works from cwd; no extra-root mapping' },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: 'prompt_async model { providerID, modelID }, split from provider/model' },
  effort: { honored: true, via: 'prompt_async variant, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch on the child process' },
  sessionId: { honored: true, via: 'GET /session/{id} when resume is set; a fresh POST /session mints its own id' },
  resume: { honored: true, via: 'GET /session/{id} in place of POST /session; 404 falls back to a fresh session' },
  resumeFallbackSystemPrompt: { honored: true, via: 'opening prependSystemPrompt of a fresh POST /session when GET /session/{id} returns 404 on resume' },
};
/** How long an idle session may sit on steered input before it counts as a lost wake. */
export const OPENCODE_LOST_WAKE_GRACE_MS = 2_000;

export class OpencodeServerRunner implements AgentRunner {
  readonly backend = 'opencode' as const;
  readonly specSupport = OPENCODE_SPEC_SUPPORT;
  readonly systemPromptOnResume = 'in-thread' as const;
  readonly inputDelivery: InputDelivery = {
    mode: 'steer', consumption: 'observable',
    via: 'prompt_async while busy; assistant message.updated parentID at consumption',
  };

  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly serverStartTimeoutMs: number;
  private lastSession: OpencodeSession | null = null;

  constructor(opts: OpencodeRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.CEZ_OPENCODE_BIN ?? (process.env.CEZ_DRY_RUN === '1'
      ? fileURLToPath(new URL('../../scripts/mock-opencode-serve.mjs', import.meta.url)) : 'opencode');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.serverStartTimeoutMs = opts.serverStartTimeoutMs ?? SERVER_START_TIMEOUT_MS;
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
    const session = new OpencodeSession(this.bin, this.timeoutMs, this.serverStartTimeoutMs, spec, onEvent, opts);
    this.lastSession = session;
    return session;
  }
}

/** One live `opencode serve` process driving a single session. */
class OpencodeSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;

  /** The live server process. A start retry replaces it (#872), so every
   *  liveness, pid, signal and stderr read goes through this field. */
  private serve!: ServeProcess;
  /** The first start, once the retry spawned for it ALSO exited before
   *  listening on its own (#872) — the one case that names both attempts. */
  private failedStart: ServeProcess | undefined;
  /** The retry's own spawn threw synchronously (EAGAIN, EMFILE…), so no second
   *  process exists and the first start's exit alone would misname the failure. */
  private retrySpawnError: Error | undefined;
  /** Aborted by teardown; cancels a pending start retry. */
  private readonly startRetry = new AbortController();
  private serverOpen = true;
  private exitFailure: string | undefined;
  private baseUrl: string | undefined;
  private sessionId: string | undefined;
  private ready!: Promise<void>;
  private readonly sse = new AbortController();
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private readonly textChunks: string[] = [];
  /** Per text-part cursor so only newly-appended text is buffered (deltas). */
  private readonly textSeen = new Map<string, number>();
  /** Streamed part deltas buffered per part — v1 `text` is emitted once per
   *  finished part (claude parity: one event per complete block), never per
   *  delta, so the persisted transcript and the headless CLI get whole
   *  paragraphs. Streaming display rides protocol v2's `item.delta`. */
  private readonly textCoalescer = new V1TextCoalescer((text) => {
    this.textChunks.push(text);
    this.emit({ type: 'text', text });
  });
  private readonly toolsSeen = new Set<string>();
  /** messageID → role. Parts carry no role; only assistant parts are surfaced
   *  (the user's own message also streams as parts over the same SSE feed). */
  private readonly msgRole = new Map<string, string>();
  /** Accepted agent prompts, the user message carrying each, and prompts that
   *  opened their turn (read when that turn goes idle) (#505). */
  private readonly submissions = new InputSubmissions();
  private readonly userMessageSubmission = new Map<string, string>();
  private readonly turnOpeners = new Set<string>();
  private refusedBeforeOpening = false;
  private turnErrored = false;
  private lostWakeTimer: NodeJS.Timeout | undefined;
  private tokensUsed = 0;
  /** OpenCode reports a cumulative cost for each message, not the session. */
  private readonly costByMessage = new Map<string, number>();
  /** A prompt was posted and its `session.idle` has not arrived yet. */
  private turnActive = false;
  private agentInputReady = false;
  private agentRequest: AbortController | undefined;
  /** Human prompts scheduled behind the active turn, through their HTTP ack. */
  private pendingPromptRequests = 0;
  /** A provider error must not abort its own independently arriving receipt. */
  private agentAcknowledgement?: Promise<void>;
  private providerErrorPending?: { message: string; reported: boolean };
  /** `finishTurn` ran for the current turn — repeats and stray idles no-op. */
  private turnEnded = false;
  /** Monotonic identity used to reject async work completed by an older turn. */
  private turnSerial = 0;
  /** Settles when the open turn finishes; re-armed at each turn start. The
   *  gate `prompt` waits on so turns never overlap (see there). */
  private turnFinished: Promise<void> = Promise.resolve();
  private turnFinishedResolve: () => void = () => {};
  /** Protocol v2 emission — additive alongside v1 (`onEvent` keeps flowing
   *  byte-identical); the channel is `opts.onUiEvent` (RunManager wiring
   *  lands in R2 step 2.1). Both streams take their turn-end from the wire
   *  `session.idle` (v1 since #4 — see `finishTurn`). */
  private uiState: OpencodeUiMapperState = createOpencodeUiState();
  /** Question tool parts are snapshots. Once capture starts for an identity,
   * every later state snapshot for that same part/call is already handled. */
  private readonly handledQuestionParts = new Set<string>();
  private pendingQuestion: PendingOpencodeQuestion | undefined;
  private questionCapture: Promise<void> | undefined;
  private questionReply: Promise<void> | undefined;
  /** User text submitted while a question reply POST is unsettled. It is not
   * another answer; deliver it as ordinary prompts only after reply success. */
  private readonly queuedQuestionMessages: string[] = [];
  /** Bumped by `discardQueuedMessages` so a `prompt()` waiter that captured
   * the previous generation returns instead of posting after idle. */
  private queuedPromptGeneration = 0;
  /** Human `prompt()` waiters in the current generation that have not posted yet (#486). */
  private humanPromptWaiters = 0;
  private autoEndTimer: NodeJS.Timeout | undefined;
  private timedOut = false;
  private openingPromptFailed = false;

  constructor(
    private readonly bin: string,
    timeoutMs: number,
    private readonly serverStartTimeoutMs: number,
    private readonly spec: AgentRunSpec,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
  ) {
    this.serve = this.spawnServe();

    // The server prints its URL on stdout once listening.
    const urlReady = this.startServer();

    const limitMs = spec.timeoutMs ?? timeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        this.timedOut = true;
        this.interrupt();
      }, limitMs);
      deadline.unref?.();
    }

    this.ready = (async () => {
      this.baseUrl = await urlReady;
      await this.bootstrap();
    })();

    this.result = (async (): Promise<AgentRunResult> => {
      try {
        await this.ready;
        // Live for the whole session; the SSE loop runs until end()/interrupt.
        await this.serve.exited;
      } catch (err) {
        if (!this.timedOut && !this.openingPromptFailed) {
          const message = err instanceof Error ? err.message : String(err);
          this.exitFailure = `opencode: ${message}`;
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
        this.sse.abort();
        this.serverOpen = false;
        this.agentRequest?.abort();
        this.terminate();
      }

      const serve = this.serve;
      await serve.exited;
      await serve.outputDrained;
      if (serve.spawnFailed) {
        this.emit({ type: 'error', message: serve.spawnFailed.message });
        throw serve.spawnFailed;
      }

      // SSE closure can precede the process exit event. Choose one authoritative
      // error after settlement, before the synthetic turn-end, retaining the code.
      const code = serve.child.exitCode;
      const signal = serve.child.signalCode;
      const crashed = (signal !== null && !serve.signalled)
        || (code !== null && code !== 0 && !(serve.signalled && isSignalTerminationExit(code)));
      if (!this.timedOut && (crashed || this.exitFailure)) {
        const stderr = serve.stderrChunks.join('');
        const detail = summarizeRunnerStderr(stderr);
        if (this.retrySpawnError) {
          if (stderr.trim()) this.emit({ type: 'note', message: `opencode serve stderr:\n${stderr}` });
          this.emit({
            type: 'error',
            message: `opencode serve exited before listening (${describeEarlyExit(serve)}) and its retry could not start: ${this.retrySpawnError.message}`,
          });
        } else if (this.failedStart) {
          // #872: the retry failed too — one error naming both attempts.
          const attempts = [this.failedStart, serve];
          const notes = attempts.map((attempt, i) => {
            const text = attempt.stderrChunks.join('');
            return text.trim() ? `opencode serve stderr (attempt ${i + 1}):\n${text}` : '';
          }).filter(Boolean);
          if (notes.length) this.emit({ type: 'note', message: notes.join('\n') });
          const described = attempts.map((attempt, i) => `attempt ${i + 1}: ${describeEarlyExit(attempt)}`);
          this.emit({ type: 'error', message: `opencode serve exited before listening on both attempts — ${described.join('; ')}` });
        } else {
          if (stderr.trim()) this.emit({ type: 'note', message: `opencode serve stderr:\n${stderr}` });
          const message = crashed
            ? `opencode serve exited with ${describeExit(serve)}${detail ? ` — ${detail}` : ''}`
            : this.exitFailure!;
          this.emit({ type: 'error', message });
        }
      }

      // Timeout/interrupt can cut the SSE feed before its `session.idle` —
      // close the turn (idempotent) so consumers still see the v1 boundary,
      // and recover prose buffered mid-part.
      this.finishTurn();
      this.textCoalescer.flush();
      // Chunks are whole blocks now (one per finished part), so newline-join
      // like the other runners, not the old delta concatenation.
      const text = this.textChunks.join('\n').trim();
      const base: AgentRunResult = {
        text,
        toolCalls: this.toolCalls,
        tokensUsed: this.tokensUsed,
        sessionId: this.sessionId ?? spec.sessionId,
      };
      if (this.timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        this.emit({ type: 'error', message: `opencode timed out after ${mins}m and was killed` });
      }
      this.emit({ type: 'done' });
      return base;
    })();
  }

  get open(): boolean {
    return this.serverOpen;
  }

  get pid(): number | undefined {
    return this.serve.child.pid;
  }

  sendAgentMessage(content: ContentBlock[], inputIds: readonly string[] = []): false | Promise<void> {
    // #505: a busy session is steered with prompt_async; only a pending native question,
    // a queued human prompt or an in-flight agent POST refuses.
    // Nothing may run ahead of the task: refuse until the opening prompt has started,
    // then hint once so the refused input steers the opening turn.
    if (this.serverOpen && this.turnSerial === 0) { this.refusedBeforeOpening = true; return false; }
    if (!this.serverOpen || !this.sessionId || this.pendingQuestion || this.questionReply || this.pendingPromptRequests > 0 || this.agentRequest) return false;
    this.agentInputReady = false;
    const request = new AbortController();
    this.agentRequest = request;
    const text = textOf(content);
    const submissionId = randomUUID();
    const steering = this.turnActive;
    this.submissions.accept(submissionId, inputIds, text);
    if (!steering && inputIds.length) this.turnOpeners.add(submissionId);
    const post = steering ? this.steerPrompt(text, request.signal) : this.prompt(text, 'agent', request.signal);
    const acknowledgement = post.catch((err: unknown) => {
      this.submissions.consume(submissionId); this.turnOpeners.delete(submissionId);
      throw err;
    }).finally(() => {
      if (this.agentRequest === request) this.agentRequest = undefined;
      if (this.serverOpen && !this.providerErrorPending && !this.turnActive && !this.pendingQuestion && !this.questionReply) {
        this.agentInputReady = true;
        this.opts.onAgentInputReady?.();
        this.scheduleAutoEnd();
      }
    });
    this.agentAcknowledgement = acknowledgement;
    return acknowledgement;
  }

  sendMessage(content: ContentBlock[]): boolean {
    this.agentInputReady = false;
    if (!this.serverOpen) return false;
    this.cancelAutoEnd();
    const text = textOf(content);
    if (!text) return true;
    if (this.questionReply) {
      this.queuedQuestionMessages.push(text);
      return true;
    }
    if (this.pendingQuestion) {
      const pending = this.pendingQuestion;
      const reply = this.replyQuestion(pending, text);
      this.questionReply = reply;
      const clearReply = () => {
        if (this.questionReply === reply) this.questionReply = undefined;
        this.notifyAgentInputReady();
      };
      void reply.then(clearReply, clearReply);
      return true;
    }
    // `prompt` already emitted the note and closed the turn before rethrowing,
    // and a rejected `ready` already failed the session on the result path —
    // there is nothing left to report here.
    this.deliverPrompt(text);
    return true;
  }

  discardQueuedMessages(): void {
    this.queuedPromptGeneration += 1;
    this.queuedQuestionMessages.length = 0;
    this.humanPromptWaiters = 0; // #486: must read false immediately, not when waiters resume
  }

  holdsHumanInput(): boolean {
    return this.humanPromptWaiters > 0 || this.queuedQuestionMessages.length > 0;
  }
  heldHumanInputCount(): number {
    return this.humanPromptWaiters + this.queuedQuestionMessages.length;
  }

  private deliverPrompt(text: string): void {
    this.pendingPromptRequests += 1;
    void this.ready.then(() => this.prompt(text)).then(() => {
      this.pendingPromptRequests -= 1;
      this.notifyAgentInputReady();
    }, () => {
      this.pendingPromptRequests -= 1;
    });
  }

  private notifyAgentInputReady(): void {
    if (this.serverOpen && this.turnEnded && !this.turnActive && !this.pendingQuestion &&
      !this.questionReply && this.pendingPromptRequests === 0) {
      this.agentInputReady = true;
      this.opts.onAgentInputReady?.();
    } else if (this.serverOpen && this.turnActive && !this.pendingQuestion && !this.questionReply &&
      this.pendingPromptRequests === 0 && !this.agentRequest) {
      // A reply or prompt acknowledgement cleared the last barrier mid-turn: held agent
      // input can steer the running turn now, not after it (#505 local review).
      this.opts.onAgentInputReady?.();
    }
  }

  private cancelAutoEnd(): void {
    if (!this.autoEndTimer) return;
    clearTimeout(this.autoEndTimer);
    this.autoEndTimer = undefined;
  }

  private scheduleAutoEnd(): void {
    if (!this.opts.autoEndAfterFirstTurn || !this.serverOpen || this.autoEndTimer || this.agentRequest) return;
    this.autoEndTimer = setTimeout(() => {
            this.autoEndTimer = undefined;
            if (this.opts.shouldAutoEnd?.() !== false) this.end();
          }, AUTO_END_DELAY_MS);
    this.autoEndTimer.unref?.();
  }

  end(): void {
    if (!this.serverOpen) return;
    this.serverOpen = false;
    this.agentRequest?.abort();
    this.sse.abort();
    this.terminate();
  }

  interrupt(): void {
    this.serverOpen = false;
    this.agentRequest?.abort();
    if (this.baseUrl && this.sessionId) {
      void this.http('POST', `/session/${this.sessionId}/abort`, undefined).catch(() => undefined);
    }
    this.sse.abort();
    this.terminate();
  }

  /**
   * The one place either signal is sent: SIGTERM now, SIGKILL once the grace
   * window elapses.
   *
   * Both steps gate on `hasExited()`, never on `child.killed` — the latter
   * flips the moment SIGTERM is *delivered*, so the old nested
   * `exitCode == null && !killed` guard disarmed the escalation for exactly the
   * server it was written for: one that installs its own SIGTERM handler stayed
   * alive with `killed = true` and `exitCode === null`, outliving the whole
   * window (#858, the same defect #844 fixed for the other two backends). Every
   * caller here is followed by `await serve.exited`, so a server that survived
   * SIGTERM did not just leak — it hung the session's result forever.
   *
   * One teardown per session: all three call sites can run for the same session
   * (`interrupt()` on the deadline, then the result promise's `finally`), and
   * once SIGTERM is out with SIGKILL armed there is nothing a second pass adds.
   * The old `!child.killed` test deduplicated this as a side effect of being
   * wrong; `signalled` keeps that property on purpose. It lives on the process,
   * not the session: only the live one is ever signalled, and a start retry
   * (#872) replaces it only after the first exited unsignalled.
   *
   * Teardown also cancels a pending start retry, so no second server spawns
   * after `end()`, `interrupt()` or the deadline.
   */
  private terminate(): void {
    this.startRetry.abort();
    const serve = this.serve;
    if (serve.signalled || serve.hasExited()) return;
    serve.signalled = true;
    signalSession(serve.child, 'SIGTERM');
    setTimeout(() => {
      if (serve.hasExited()) return;
      signalSession(serve.child, 'SIGKILL');
    }, KILL_GRACE_MS).unref?.();
  }

  // ---- server lifecycle ---------------------------------------------------

  /** Spawn one `opencode serve` on a random high port and wire its lifecycle.
   *  A synchronous spawn throw is wrapped; an async spawn error is latched on
   *  the process record. */
  private spawnServe(): ServeProcess {
    // Random high port; the actual bound URL is read back from stdout.
    const port = 40000 + Math.floor(Math.random() * 20000);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnSessionLeader(this.bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: this.spec.cwd,
        env: buildChildEnv({ backend: 'opencode', extraEnv: ciOpenCodeEnv(this.spec) }),
      });
    } catch (err) {
      throw wrapSpawnError(err, this.bin);
    }
    const hasExited = trackChildExit(child);
    boundOutputDrainAfterExit(child);
    // `exit` settles process liveness, not its pipes. The shared 250ms drain
    // bound prevents an inherited descendant pipe from retaining this session.
    const outputDrained = Promise.all([child.stdout, child.stderr].map(stream =>
      finished(stream, { cleanup: true }).catch(() => undefined),
    ));
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
    });
    const serve: ServeProcess = {
      child, hasExited, exited, outputDrained, port,
      stderrChunks: [], spawnFailed: null, signalled: false,
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      serve.spawnFailed = wrapSpawnError(err, this.bin);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => serve.stderrChunks.push(chunk));
    return serve;
  }

  /**
   * Wait for the server URL, retrying once — after `SERVE_START_RETRY_DELAY_MS`,
   * on a fresh port — when the process exited before it printed one (#872).
   * Never retried: a spawn error (the process never ran), the no-URL timeout
   * (it falls back to the requested port), and a session already torn down.
   */
  private async startServer(): Promise<string> {
    try {
      return await this.waitForServerUrl(this.serve);
    } catch (err) {
      const first = this.serve;
      if (!(err instanceof ServeExitedBeforeListening)) throw err;
      // Settle the process first: an ENOENT `error` and late stderr both land
      // around `exit`, and the retry decision and its note need them.
      await first.exited;
      await first.outputDrained;
      if (first.spawnFailed || first.child.pid === undefined || !this.serverOpen || this.timedOut) throw err;
      const detail = summarizeRunnerStderr(first.stderrChunks.join(''));
      this.emit({
        type: 'note',
        message: `opencode serve exited before listening (${describeExit(first)}); retrying once${detail ? ` — ${detail}` : ''}`,
      });
      try {
        await delay(SERVE_START_RETRY_DELAY_MS, undefined, { signal: this.startRetry.signal });
      } catch {
        // Torn down during the pause: report the first start's failure as before.
        throw err;
      }
      if (this.startRetry.signal.aborted || !this.serverOpen || this.timedOut) throw err;
      let next: ServeProcess;
      try {
        next = this.spawnServe();
      } catch (spawnErr) {
        this.retrySpawnError = spawnErr instanceof Error ? spawnErr : new Error(String(spawnErr));
        throw spawnErr;
      }
      this.serve = next;
      if (next.child.pid !== undefined) this.opts.onPidChange?.(next.child.pid);
      try {
        return await this.waitForServerUrl(next);
      } catch (retryErr) {
        // Only an unprompted second early exit names both attempts; a retry
        // torn down by the session reports through the ordinary paths.
        if (retryErr instanceof ServeExitedBeforeListening && !next.signalled) this.failedStart = first;
        throw retryErr;
      }
    }
  }

  private waitForServerUrl(serve: ServeProcess): Promise<string> {
    const { child } = serve;
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        cleanup();
        // Nothing parsed — try the port we asked for.
        resolve(`http://127.0.0.1:${serve.port}`);
      }, this.serverStartTimeoutMs);
      timer.unref?.();
      const onData = (chunk: string) => {
        buffer += chunk;
        const m = /https?:\/\/[\d.]+:\d+/.exec(buffer);
        if (m) {
          cleanup();
          resolve(m[0]);
        }
      };
      const onExit = () => {
        cleanup();
        reject(new ServeExitedBeforeListening());
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onData);
      child.once('exit', onExit);
    });
  }

  private nativeDelegationPermission(): { permission: Array<{ permission: string; pattern: string; action: string }> } {
    return { permission: [{ permission: 'task', pattern: '*', action: 'deny' }] };
  }

  /** 404 → `'missing'`. Any other non-OK status fails bootstrap (no fallback). */
  private async tryGetSession(id: string): Promise<Record<string, unknown> | 'missing'> {
    if (!this.baseUrl) throw new Error('opencode server not ready');
    const res = await fetch(`${this.baseUrl}/session/${encodeURIComponent(id)}`, { method: 'GET' });
    if (res.status === 404) return 'missing';
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`GET /session/${id} → ${res.status} ${detail.slice(0, 200)}`);
    }
    const text = await res.text();
    if (!text) return { id };
    try {
      const parsed = JSON.parse(text) as unknown;
      return isRecord(parsed) ? parsed : { id };
    } catch {
      return { id };
    }
  }

  private async attachSession(id: string, applyDelegationRule: boolean): Promise<void> {
    this.sessionId = id;
    this.emit({ type: 'session', sessionId: id });
    this.emitUi((state) => opencodeSessionStarted(id, state));
    if (applyDelegationRule) {
      await this.http('PATCH', `/session/${encodeURIComponent(id)}`, this.nativeDelegationPermission());
    }
  }

  private async bootstrap(): Promise<void> {
    const requested = this.spec.resume ? this.spec.sessionId : undefined;
    let resumed = false;
    if (requested) {
      const existing = await this.tryGetSession(requested);
      if (existing === 'missing') {
        this.emit({
          type: 'note',
          message: `OpenCode session ${requested} no longer exists; the continuation runs in a fresh session without the earlier conversation.`,
        });
      } else {
        const applyDelegationRule = Boolean(this.spec.restrictNativeDelegation)
          && !hasNativeDelegationDeny(existing.permission);
        await this.attachSession(stringField(existing, 'id') ?? requested, applyDelegationRule);
        resumed = true;
      }
    }
    if (!resumed) {
      const created = await this.http('POST', '/session', {
        title: 'cezar task',
        // OpenCode 1.18.33 /doc: session.create permission rules. The native task
        // tool checks this permission; other agent/project permissions stay intact.
        ...(this.spec.restrictNativeDelegation ? this.nativeDelegationPermission() : {}),
      });
      const sessionId = stringField(created, 'id');
      if (!sessionId) throw new Error('opencode did not return a session id');
      await this.attachSession(sessionId, false);
    }

    // The SSE subscription must be LIVE before the first prompt posts —
    // events the server emits while the POST is in flight would otherwise be
    // lost (a race this await closes; the bundled mock made it visible).
    await this.consumeEvents();

    // Lost-session fallback uses the full skill-inclusive prompt Continue
    // stashed in resumeFallbackSystemPrompt; a true resume re-prepends only
    // extra+handoff (the skill already lives in the thread).
    const systemPrompt = !resumed && requested
      ? (this.spec.resumeFallbackSystemPrompt ?? this.spec.systemPrompt)
      : this.spec.systemPrompt;
    const first = prependSystemPrompt(systemPrompt, this.spec.userPrompt);
    await this.prompt(first, 'opening');
    if (this.refusedBeforeOpening) queueMicrotask(() => {
      this.refusedBeforeOpening = false;
      if (this.serverOpen && !this.pendingQuestion && !this.questionReply && !this.agentRequest) this.opts.onAgentInputReady?.();
    });
  }

  private async prompt(text: string, origin: 'opening' | 'human' | 'agent' = 'human', signal?: AbortSignal): Promise<void> {
    // One turn at a time. `prompt_async` acknowledges before the turn runs,
    // so `ready` no longer serializes prompts the way the long-poll did — a
    // follow-up posted mid-turn would share the turnActive/turnEnded pair
    // with the running turn and let that turn's idle close this one. Waiters
    // resume in FIFO order; a teardown (`finishTurn` runs on every exit
    // path) releases them into the `serverOpen` check below.
    const generation = this.queuedPromptGeneration;
    const humanWaiter = origin === 'human';
    if (humanWaiter) this.humanPromptWaiters += 1;
    while (this.turnActive) await this.turnFinished;
    if (humanWaiter && generation === this.queuedPromptGeneration) {
      this.humanPromptWaiters = Math.max(0, this.humanPromptWaiters - 1);
    }
    if (generation !== this.queuedPromptGeneration) return;
    // A queued prompt may have started waiting before the preceding idle armed
    // auto-end. Cancel at actual delivery time, not only at sendMessage time.
    this.cancelAutoEnd();
    if (!this.sessionId || !this.serverOpen) return;
    this.openTurn();
    // Turn boundary, v1 and v2 alike — the prompt POST is the turn start
    // (§7.1); the end comes from the SSE `session.idle`, never from the HTTP
    // response below. `POST /session/:id/message` long-polled the whole turn,
    // and undici's default 300s headers timeout ended it as `prompt failed:
    // fetch failed` (#4, upstream #897); `prompt_async` returns immediately.
    this.emitUi(opencodeTurnStarted);
    const body = this.promptBody(text);
    try {
      await this.http('POST', `/session/${this.sessionId}/prompt_async`, body, signal);
    } catch (err) {
      // No turn started server-side, so no `session.idle` will ever close it —
      // surface the failure and end the turn here instead of parking the run.
      const message = err instanceof Error ? err.message : String(err);
      if (origin === 'agent' && this.providerErrorPending) {
        // Latch the initiating provider failure before rejection reaches the
        // manager's ACK handler (including grace expiry and explicit abort).
        this.providerErrorPending.reported = true;
        if (this.serverOpen) this.emit({ type: 'error', message: this.providerErrorPending.message });
      } else if (origin === 'agent') {
        // Fatal BEFORE the synthetic boundary: the rejected submission stays
        // queued and must not drain more input or settle DONE.
        if (this.serverOpen) {
          this.emit({ type: 'error', message: `opencode: agent input failed: ${message}` });
          this.interrupt();
        }
      } else if (origin === 'opening') {
        this.emit({ type: 'note', message: `opencode: prompt failed: ${message}` });
        // A dropped ACK can be the first sign of a process crash. Retain HTTP
        // rejection details, but let settlement choose one error before turn-end.
        this.openingPromptFailed = true;
        this.exitFailure = `opencode: ${message}`;
        this.interrupt();
      } else {
        this.emit({ type: 'note', message: `opencode: prompt failed: ${message}` });
      }
      if (!this.providerErrorPending && origin !== 'opening') this.finishTurn();
      // Bootstrap still rejects; its result path reports the latched opening
      // failure. Human follow-ups keep their nonfatal note and turn boundary.
      throw err;
    }
  }

  private promptBody(text: string): Record<string, unknown> {
    const body: Record<string, unknown> = { parts: [{ type: 'text', text }] };
    // `spec.model` arrives already normalised to canonical `provider/model`
    // (the run wiring's fail-loud gate). Split it with the shared parser — the
    // one every runner uses — into opencode's `{ providerID, modelID }`.
    const id = parseModelIdentity(this.spec.model);
    if (id) body.model = { providerID: id.provider, modelID: id.model };
    const effort = parseEffort(this.spec.effort);
    if (effort) body.variant = effort;
    return body;
  }

  /** Busy agent input: the running prompt loop rereads it between steps (1.18.32 probe).
   *  No new turn opens; the running turn's idle ends it (#505). */
  private async steerPrompt(text: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.http('POST', `/session/${this.sessionId}/prompt_async`, this.promptBody(text), signal);
    } catch (err) {
      if (this.serverOpen) {
        this.emit({ type: 'error', message: `opencode: agent input failed: ${err instanceof Error ? err.message : String(err)}` });
        this.interrupt();
      }
      throw err;
    }
  }

  /** The single v1 turn-end: from the session's own `session.idle`, the
   *  prompt-POST failure path, or the teardown safety net — whichever comes
   *  first; the guards make every later call a no-op. */
  /** Turn bookkeeping for a prompt POST, or for a server run that started on its own
   *  to answer steered input (#505). */
  private openTurn(): void {
    this.clearLostWakeTimer();
    this.turnActive = true;
    this.agentInputReady = false;
    this.turnEnded = false;
    this.turnSerial += 1;
    this.turnFinished = new Promise((resolve) => {
      this.turnFinishedResolve = resolve;
    });
  }

  private clearLostWakeTimer(): void {
    if (this.lostWakeTimer) clearTimeout(this.lostWakeTimer);
    this.lostWakeTimer = undefined;
  }

  private finishTurn(): void {
    if (!this.turnActive || this.turnEnded) return;
    this.turnEnded = true;
    this.turnActive = false;
    this.questionCapture = undefined;
    // SSE idle can beat the independent reply HTTP response. The active reply
    // owns pending-question cleanup; without one, the pending ask is stale.
    if (!this.questionReply) this.pendingQuestion = undefined;
    this.turnFinishedResolve();
    // A part that never saw `time.end` (abort, server quirk) still surfaces
    // its prose before the turn boundary (run.ts reads markers there).
    this.textCoalescer.flush();
    this.agentInputReady = true;
    // A prompt that opened this turn was processed by it; steered input the turn never
    // answered (no assistant message named it as parentID) is a lost wake (#505).
    // A turn that failed may never have reached the model: its opener stays pending, so a
    // closing session returns it to the queue (#505 review).
    const opened = this.turnErrored ? [] : [...this.turnOpeners].flatMap(id => this.submissions.consume(id));
    this.turnOpeners.clear();
    this.turnErrored = false;
    if (opened.length) this.opts.onAgentInputConsumed?.(opened);
    this.emit({ type: 'turn-end' });
    // Steered input the server holds is read by a follow-on run, or stranded by the
    // upstream lost wake (anomalyco/opencode#46842). Only a quiet grace window tells
    // them apart; then report it so cezar submits it as a new prompt.
    if (this.submissions.pending > 0) {
      this.clearLostWakeTimer();
      this.lostWakeTimer = setTimeout(() => {
        this.lostWakeTimer = undefined;
        if (!this.serverOpen || this.turnActive) return;
        const inputIds = this.submissions.takeUnconsumed();
        this.userMessageSubmission.clear();
        if (inputIds.length) this.emit({ type: 'input-unconsumed', inputIds });
      }, OPENCODE_LOST_WAKE_GRACE_MS);
      this.lostWakeTimer.unref?.();
    }
    if (!this.questionReply) this.scheduleAutoEnd();
  }

  // ---- SSE stream ---------------------------------------------------------

  /** Resolves once the SSE stream is CONNECTED (headers in) — the frames are
   *  then drained in the background. Callers await the connection so no
   *  event emitted after this resolves can be missed.
   *
   *  Speaks node:http, not fetch: undici's default Agent cuts a response
   *  body idle for 300s, which would sever a quiet turn's bus mid-run (#4) —
   *  node's own client has no idle timeout. (`process.getBuiltinModule`
   *  cannot fix that: undici is bundled into node but not exposed as a
   *  built-in, so there is no no-timeout dispatcher to hand fetch without
   *  taking undici as a real dependency.)
   *
   *  A connection that cannot be established throws, failing `bootstrap`:
   *  with `prompt_async` this stream is the only source of turn-ends, so a
   *  session that cannot hear it is dead on arrival, not degraded. */
  private async consumeEvents(): Promise<void> {
    if (!this.baseUrl) return;
    let res: IncomingMessage;
    try {
      res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          `${this.baseUrl}/event`,
          { headers: { accept: 'text/event-stream' }, signal: this.sse.signal },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });
    } catch (err) {
      if (this.sse.signal.aborted) return; // torn down during bootstrap — not a failure
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`event stream failed to connect: ${message}`);
    }
    // node:http hands over EVERY response, error statuses included — a proxy's
    // 401 or a non-SSE 500 body is not an event bus, however well it parses.
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      res.resume(); // discard the body so the socket is released
      throw new Error(`event stream failed to connect: HTTP ${status}`);
    }
    void this.readEvents(res);
  }

  private async readEvents(res: IncomingMessage): Promise<void> {
    // StringDecoder under the hood — multi-byte characters split across
    // chunks arrive whole, like the TextDecoder streaming mode did.
    res.setEncoding('utf8');
    let buffer = '';
    try {
      for await (const chunk of res) {
        this.opts.onActivity?.(); // Includes SSE heartbeat comments.
        buffer += chunk as string;
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          await this.handleFrame(frame);
        }
      }
    } catch {
      // aborted — normal on end()/interrupt
    } finally {
      // `session.idle` rides this stream and nothing else — a feed that dies
      // while the server is still up would otherwise park the current turn
      // forever and leave every later prompt unanswerable. An `error`, not a
      // note: the turn's remaining output is lost, so the step must record a
      // failure (run.ts classifies from v1 `error` only), never pass as an
      // empty success. Then close the turn (flushing what did arrive) and end
      // the session; "Continue" GETs this session id on the next server.
      if (this.serverOpen && !this.sse.signal.aborted) {
        this.exitFailure = 'opencode: event stream closed unexpectedly';
        this.end();
      }
    }
  }

  private async handleFrame(frame: string): Promise<void> {
    const dataLines = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;
    let evt: OpencodeEvent;
    try {
      evt = JSON.parse(dataLines.join('\n')) as OpencodeEvent;
    } catch {
      return;
    }
    this.emitUi((state) => mapOpencodeEvent(evt, state));
    const sid = stringField(evt.properties ?? {}, 'sessionID');
    if (evt.type === 'session.error' && !opencodeSkillWarning(evt.properties ?? {}) && (sid === undefined || sid === this.sessionId) && this.agentRequest) {
      // HTTP and SSE are independent sockets: the error can overtake a positive
      // prompt ACK. Let that exact request settle before v1 makes RunManager
      // interrupt it. Keep later SSE idle frames behind the same barrier.
      // Reuse the teardown grace as a hard bound: a wedged ACK cannot keep a
      // failed turn alive indefinitely. Explicit end/interrupt still abort now.
      const failure = { message: this.sessionErrorMessage(evt.properties?.error), reported: false };
      this.providerErrorPending = failure;
      const request = this.agentRequest;
      const timer = setTimeout(() => request.abort(), KILL_GRACE_MS);
      try {
        await this.agentAcknowledgement?.catch(() => undefined);
        if (this.serverOpen && !failure.reported) this.handleEvent(evt);
      } finally {
        clearTimeout(timer);
        this.providerErrorPending = undefined;
      }
    } else {
      this.handleEvent(evt);
    }
  }

  /** #53 — a forwarded session error must never read like a missing
   *  executable: a bare upstream `Not Found` used to surface as
   *  `opencode: Not Found`, indistinguishable from the spawn failure whose
   *  PATH/installation guidance lives in `wrapSpawnError`. Name the selected
   *  provider/model — only the runner knows it — and keep any structured
   *  upstream status or code, so a provider outage is recognizable as one. */
  private sessionErrorMessage(error: unknown): string {
    const id = parseModelIdentity(this.spec.model);
    const context = id ? `provider ${formatModelIdentity(id)}` : 'provider';
    const detail = sessionErrorDetail(error);
    const suffix = detail ? ` (${detail})` : '';
    return `opencode: ${context} request failed: ${sessionErrorText(error)}${suffix}`;
  }

  private handleEvent(evt: OpencodeEvent): void {
    const type = evt.type ?? '';
    const props = evt.properties ?? {};
    if (type === 'message.updated' || type === 'message.created' || type === 'message.completed') {
      const info = (props.info as Record<string, unknown>) ?? props;
      const mid = stringField(info, 'id');
      const role = stringField(info, 'role');
      if (mid && role) this.msgRole.set(mid, role);
      // The model answers a steered user message: it has read it (#505).
      const parent = role === 'assistant' ? stringField(info, 'parentID') : undefined;
      const submission = parent ? this.userMessageSubmission.get(parent) : undefined;
      if (parent && submission) {
        this.userMessageSubmission.delete(parent);
        // After an idle, the server started a new run for steered input: a new turn.
        if (!this.turnActive && this.serverOpen) { this.openTurn(); this.emitUi(opencodeTurnStarted); }
        const ids = this.submissions.consume(submission);
        if (ids.length) this.opts.onAgentInputConsumed?.(ids);
      }
      this.absorbUsage(info);
    } else if (type === 'message.part.updated' || type === 'message.part.created') {
      this.handlePart((props.part as Record<string, unknown>) ?? props);
    } else if (type === 'session.idle') {
      // THE turn-end signal. The SSE bus is server-wide, so a child session's
      // (sub-agent's) idle must not close the main turn; an idle with no
      // sessionID is treated as ours, like the v2 mapper does.
      const sid = stringField(props, 'sessionID');
      if (sid === undefined || sid === this.sessionId) this.finishTurn();
    } else if (type === 'session.error') {
      const warning = opencodeSkillWarning(props);
      if (warning) {
        this.emit({ type: 'note', message: warning });
        return;
      }
      // The wire's failure signal, now that the prompt POST returns
      // before the turn runs: forward it to v1, whose `error` events are what
      // run.ts records failed steps from — dropped, the terminal idle would
      // file a provider/auth failure as a successful step. The idle that
      // follows still closes the turn.
      const sid = stringField(props, 'sessionID');
      if (sid === undefined || sid === this.sessionId) {
        this.turnErrored = true;
        this.emit({ type: 'error', message: this.sessionErrorMessage(props.error) });
      }
    }
  }

  private handlePart(part: Record<string, unknown>): void {
    // The SSE bus carries every session on the server — drop parts that
    // belong to another one (a sub-agent's stream is surfaced by v2 only).
    const partSession = stringField(part, 'sessionID');
    if (partSession !== undefined && this.sessionId !== undefined && partSession !== this.sessionId)
      return;
    // Only surface parts of assistant messages — the user's own message streams
    // over the same feed. Role is known early (the message.updated event
    // precedes its parts); an unknown role means "not assistant yet" → skip.
    const messageID = stringField(part, 'messageID');
    if (messageID && this.msgRole.get(messageID) !== 'assistant') {
      // A user message carrying submitted agent text: remember which submission it is.
      if (this.msgRole.get(messageID) === 'user' && stringField(part, 'type') === 'text' && !this.userMessageSubmission.has(messageID)) {
        const submission = this.submissions.findByText(stringField(part, 'text') ?? '');
        if (submission && ![...this.userMessageSubmission.values()].includes(submission)) this.userMessageSubmission.set(messageID, submission);
      }
      return;
    }
    const kind = stringField(part, 'type');
    const id = stringField(part, 'id') ?? messageID ?? '';
    if (kind === 'text') {
      const full = stringField(part, 'text') ?? '';
      const seen = this.textSeen.get(id) ?? 0;
      if (full.length > seen) {
        this.textSeen.set(id, full.length);
        this.textCoalescer.append(id, full.slice(seen));
      }
      // `time.end` marks the part finished (same signal the v2 mapper uses) —
      // emit the whole block once, preferring the snapshot's full text.
      const time = part.time as Record<string, unknown> | undefined;
      if (time && typeof time === 'object' && typeof time.end === 'number') {
        this.textCoalescer.complete(id, full);
      }
    } else if (kind === 'tool') {
      const state = (part.state as Record<string, unknown> | undefined) ?? {};
      const status = stringField(state, 'status');
      const name = stringField(part, 'tool') ?? stringField(part, 'name') ?? 'tool';
      const questionPartId =
        stringField(part, 'id') ?? stringField(part, 'callID') ?? messageID;
      const questionInput = state.input ?? state;
      const questionReady =
        name === 'question' && (toCezarQuestions(questionInput) !== null || status !== 'pending');
      if (
        questionReady &&
        this.turnActive &&
        this.pendingQuestion === undefined &&
        this.questionCapture === undefined &&
        this.questionReply === undefined &&
        (questionPartId === undefined || !this.handledQuestionParts.has(questionPartId))
      ) {
        if (questionPartId) this.handledQuestionParts.add(questionPartId);
        const capture = this.captureQuestion(questionInput);
        this.questionCapture = capture;
        const clearCapture = () => {
          if (this.questionCapture === capture) this.questionCapture = undefined;
        };
        void capture.then(clearCapture, clearCapture);
      }
      const callId = id || `${name}-${this.toolsSeen.size}`;
      if (!this.toolsSeen.has(callId)) {
        this.toolsSeen.add(callId);
        this.toolCalls.push({ id: callId, name, input: state.input ?? state });
        this.emit({ type: 'tool-call', id: callId, tool: name, input: state.input ?? state });
      }
      if (status === 'completed' || status === 'error') {
        this.emit({
          type: 'tool-result',
          toolCallId: callId,
          result: safeStringify(state.output ?? state.result ?? state),
          isError: status === 'error',
        });
      }
    }
  }

  /** Pull cumulative tokens/cost out of an assistant message info object. */
  private absorbUsage(info: Record<string, unknown> | undefined): void {
    if (!info) return;
    const tokens = info.tokens as Record<string, unknown> | undefined;
    if (tokens) {
      const input = numField(tokens, 'input');
      const output = numField(tokens, 'output');
      const reasoning = numField(tokens, 'reasoning');
      const total = input + output + reasoning;
      if (total > this.tokensUsed) {
        this.tokensUsed = total;
        this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed });
      }
    }
    const messageId = stringField(info, 'id');
    const cost = info.cost;
    if (
      messageId && info.role === 'assistant' &&
      (info.sessionID === undefined || info.sessionID === this.sessionId) &&
      typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
    ) {
      const previous = this.costByMessage.get(messageId);
      if (previous === undefined || cost > previous) {
        this.emit({ type: 'cost', usd: cost - (previous ?? 0) });
        this.costByMessage.set(messageId, cost);
      }
    }
  }

  private async captureQuestion(input: unknown): Promise<void> {
    const questions = toCezarQuestions(input);
    const turnSerial = this.turnSerial;
    let requestId: string | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!this.turnActive || this.turnSerial !== turnSerial) return;
      requestId = await this.pendingQuestionId().catch(() => undefined);
      if (requestId) break;
      if (attempt < 7) await sleep(150);
    }
    if (!this.turnActive || this.turnSerial !== turnSerial) return;
    if (!questions) {
      if (!requestId) {
        this.emit({
          type: 'error',
          message:
            'opencode: unsupported native question could not be rejected: no pending question id',
        });
        this.finishTurn();
        this.end();
        return;
      }
      try {
        await this.http(
          'POST',
          `/question/${encodeURIComponent(requestId)}/reject`,
          undefined,
        );
        this.emit({ type: 'note', message: 'opencode: unsupported native question rejected' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({
          type: 'error',
          message: `opencode: unsupported native question rejection failed: ${message}`,
        });
        this.finishTurn();
        this.end();
      }
      return;
    }
    const pending: PendingOpencodeQuestion = {
      requestId,
      askRequestId:
        requestId ?? `opencode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      questions,
    };
    this.pendingQuestion = pending;
    this.emitQuestion(pending);
  }

  private emitQuestion(pending: PendingOpencodeQuestion): void {
    this.emitUi((state) => ({
      state,
      events: [
        {
          type: 'ask.requested',
          requestId: pending.askRequestId,
          questions: pending.questions,
        },
      ],
    }));
  }

  private async pendingQuestionId(): Promise<string | undefined> {
    const value: unknown = await this.http('GET', '/question', undefined);
    if (!Array.isArray(value)) return undefined;
    for (const entry of value) {
      if (!isRecord(entry) || stringField(entry, 'sessionID') !== this.sessionId) continue;
      const id = stringField(entry, 'id');
      if (id) return id;
    }
    return undefined;
  }

  private async replyQuestion(pending: PendingOpencodeQuestion, text: string): Promise<void> {
    try {
      const requestId = pending.requestId ?? (await this.pendingQuestionId());
      if (!requestId) throw new Error('no pending question id');
      pending.requestId = requestId;
      await this.http('POST', `/question/${encodeURIComponent(requestId)}/reply`, {
        answers: questionAnswers(pending.questions, text),
      });
      if (this.pendingQuestion === pending) this.pendingQuestion = undefined;
      const queued = this.queuedQuestionMessages.splice(0);
      for (const message of queued) this.deliverPrompt(message);
      if (queued.length === 0 && this.turnEnded) this.scheduleAutoEnd();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'note', message: `opencode: question reply failed: ${message}` });
      if (this.pendingQuestion === pending) this.emitQuestion(pending);
    }
  }

  // ---- http ---------------------------------------------------------------

  private async http(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.baseUrl) throw new Error('opencode server not ready');
    // Plain fetch is fine here: every call is a short round-trip now that
    // prompts go through `prompt_async` — nothing long-polls anymore.
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      signal,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status} ${detail.slice(0, 200)}`);
    }
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  /** The mapper never throws, but a defect in it must still never disturb
   *  the v1 stream — hence the belt-and-braces try. */
  private emitUi(map: (state: OpencodeUiMapperState) => OpencodeUiMapping): void {
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

interface OpencodeEvent {
  type?: string;
  properties?: Record<string, unknown>;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function toCezarQuestions(value: unknown): AskQuestion[] | null {
  if (!isRecord(value) || !Array.isArray(value.questions)) return null;
  if (value.questions.length < 1 || value.questions.length > 4) return null;
  const questions: AskQuestion[] = [];
  for (const rawQuestion of value.questions) {
    if (!isRecord(rawQuestion)) return null;
    const header = clippedString(rawQuestion.header, 12);
    const question = clippedString(rawQuestion.question, 400);
    if (!header || !question || !Array.isArray(rawQuestion.options)) return null;
    const options: AskQuestion['options'] = [];
    for (const rawOption of rawQuestion.options) {
      if (options.length === 4) break;
      if (!isRecord(rawOption)) continue;
      const label = clippedString(rawOption.label, 60);
      if (!label) continue;
      const description = clippedString(rawOption.description, 280);
      options.push({ label, ...(description ? { description } : {}) });
    }
    if (options.length < 2) return null;
    questions.push({
      header,
      question,
      options,
      ...(rawQuestion.multiple === true ? { multiSelect: true } : {}),
    });
  }
  return parseAskRequest({ questions })?.questions ?? null;
}

function questionAnswers(questions: AskQuestion[], text: string): string[][] {
  const answers = questions.map(() => [] as string[]);
  const matched = new Set<number>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const index = questions.findIndex(
      (question, questionIndex) =>
        !matched.has(questionIndex) && trimmed.startsWith(`${question.header}:`),
    );
    if (index < 0) continue;
    matched.add(index);
    answers[index] = trimmed
      .slice(questions[index]!.header.length + 1)
      .split(',')
      .map((answer) => answer.trim())
      .filter(Boolean);
  }
  if (matched.size === 0 && answers[0]) answers[0] = [text.trim()];
  return answers;
}

function clippedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** OpenCode 1.18.33 PATCHes permission by append (no replace, no dedupe). */
function hasNativeDelegationDeny(permission: unknown): boolean {
  if (!Array.isArray(permission)) return false;
  return permission.some((rule) =>
    isRecord(rule)
    && rule.permission === 'task'
    && rule.pattern === '*'
    && rule.action === 'deny',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/** Same reading of the wire error shape as the v2 mapper's `errorText`
 *  (`opencode-ui-mapper.ts`): a bare string, `{message}`, `{data:{message}}`
 *  (the real server's `ProviderAuthError` shape), or `{name}` as a last resort. */
function sessionErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return 'session error';
  const rec = error as Record<string, unknown>;
  const data = typeof rec.data === 'object' && rec.data !== null ? (rec.data as Record<string, unknown>) : undefined;
  return (
    stringField(rec, 'message') ??
    (data && stringField(data, 'message')) ??
    stringField(rec, 'name') ??
    'session error'
  );
}

/** Structured upstream status or code, when the wire error carries one —
 *  the AI SDK's `AI_APICallError` exposes a numeric `statusCode`, and some
 *  providers nest a `code` inside `data`. Status wins over code; anything
 *  else adds nothing (#53). */
function sessionErrorDetail(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const rec = error as Record<string, unknown>;
  const data = isRecord(rec.data) ? rec.data : undefined;
  const status =
    numField(rec, 'statusCode') ||
    numField(rec, 'status') ||
    (data ? numField(data, 'statusCode') : 0) ||
    (data ? numField(data, 'status') : 0);
  if (status > 0) return `HTTP ${status}`;
  const rawCode = rec.code ?? (data ? data.code : undefined);
  if (typeof rawCode === 'string' && rawCode.trim()) return `code ${rawCode.trim()}`;
  if (typeof rawCode === 'number') return `code ${rawCode}`;
  return undefined;
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' ? v : 0;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** `code N` or `signal S` for a server process that exited. */
function describeExit(serve: ServeProcess): string {
  const { exitCode, signalCode } = serve.child;
  return exitCode !== null ? `code ${exitCode}` : `signal ${signalCode}`;
}

/** `code N — <stderr summary>` for one start that exited before listening. */
function describeEarlyExit(serve: ServeProcess): string {
  const detail = summarizeRunnerStderr(serve.stderrChunks.join(''));
  return `${describeExit(serve)}${detail ? ` — ${detail}` : ''}`;
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found on PATH — install OpenCode (https://opencode.ai) and run \`opencode\` once to configure a provider`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
