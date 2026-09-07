import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { AUTO_END_DELAY_MS } from './claude-cli-runner.ts';
import { KILL_GRACE_MS, OpencodeServerRunner } from './opencode-server-runner.ts';
import type { UiEvent } from './ui-events.ts';

const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/**
 * #858 — the OpenCode half of #844. `opencode serve` installs its own SIGTERM handler, so the
 * teardown watchdog must decide "is it dead?" from a real exit, never from `ChildProcess.killed`,
 * which Node flips the moment a signal is *delivered*. Gating on the flag made the SIGKILL
 * unreachable for exactly the server it exists for: one leaked process per teardown, and — because
 * every teardown path here is followed by `await this.exited` — a session result that never settles.
 */
describe('SIGTERM→SIGKILL escalation for an opencode server that survives SIGTERM', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 5150,
      // Node's semantics: delivery flips `killed` whether or not the child dies.
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  /** No wall-clock deadline; the test drives the teardown itself. */
  function startSession(timeoutMs: number) {
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs }).startSession({
      userPrompt: 'do it',
      cwd: process.cwd(),
    });
    // The server never comes up behind a fake child, so the result rejects/settles on its own path.
    void session.result.catch(() => undefined);
    return session;
  }

  it('escalates after end() even once Node flagged the server as killed', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      session.end();
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('escalates on the wall-clock timeout path', () => {
    withFakeChild((fake) => {
      startSession(20);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once the server really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      session.end();
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('sends one SIGTERM per session however many teardown paths run', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      // `interrupt()` on the deadline and the result promise's `finally` both
      // reach terminate() for the same session; the escalation is armed once.
      session.interrupt();
      session.end();
      session.interrupt();
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('does not signal at all when the server exited before the teardown', () => {
    withFakeChild((fake) => {
      const session = startSession(0);
      fake.exit(0);

      session.end();
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual([]);
    });
  });
});

/**
 * #4 (upstream #897) — the runner used to long-poll `POST /session/:id/message`
 * and synthesize v1 `turn-end` from that response's settlement, so undici's
 * default 300s headers timeout ended any longer turn with `prompt failed:
 * fetch failed` and cezar parked a healthy run. The turn now starts with
 * `POST /session/:id/prompt_async` and ends from the SSE `session.idle` —
 * the same signal the v2 mapper already uses.
 */
describe('turn lifecycle over prompt_async + session.idle', { timeout: 15_000 }, () => {
  interface MockServerOptions {
    promptStatus?: number;
    followupPromptDelayMs?: number;
    refuseSse?: boolean;
    sseStatus?: number;
    questionReplyStatus?: number;
    questionReplyDelayMs?: number;
    questionGetDelayMs?: number;
  }

  /** In-process stand-in for `opencode serve`: just the endpoints the runner
   *  touches, with the test driving the SSE bus frame by frame. */
  async function startMockServer(opts: MockServerOptions = {}) {
    const clients: ServerResponse[] = [];
    const promptPosts: string[] = [];
    const promptBodies: unknown[] = [];
    const questionGets: number[] = [];
    const questionReplies: Array<{ path: string; body: unknown }> = [];
    const questionRejects: Array<{ path: string; body: unknown }> = [];
    const pendingQuestions: unknown[] = [];
    let questionReplyStatus = opts.questionReplyStatus ?? 200;
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.startsWith('/event')) {
        if (opts.refuseSse) {
          res.destroy();
          return;
        }
        if (opts.sseStatus) {
          res.writeHead(opts.sseStatus, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Flush the headers now — the runner awaits the SSE connection before
        // its first prompt, and Node holds headers back until the first write.
        res.flushHeaders();
        clients.push(res);
        return;
      }
      if (req.method === 'GET' && url === '/question') {
        questionGets.push(Date.now());
        res.writeHead(200, { 'content-type': 'application/json' });
        if (opts.questionGetDelayMs) setTimeout(() => res.end(JSON.stringify(pendingQuestions)), opts.questionGetDelayMs);
        else res.end(JSON.stringify(pendingQuestions));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        if (req.method === 'POST' && url === '/session') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'ses_test' }));
          return;
        }
        if (req.method === 'POST' && /^\/session\/ses_test\/(prompt_async|message)$/.test(url)) {
          promptPosts.push(url);
          promptBodies.push(JSON.parse(body || '{}'));
          const acknowledge = () => {
            res.writeHead(opts.promptStatus ?? 200, { 'content-type': 'application/json' });
            res.end('{}');
          };
          if (promptPosts.length > 1 && opts.followupPromptDelayMs) setTimeout(acknowledge, opts.followupPromptDelayMs);
          else acknowledge();
          return;
        }
        if (req.method === 'POST' && /^\/question\/[^/]+\/reply$/.test(url)) {
          questionReplies.push({ path: url, body: JSON.parse(body || '{}') });
          const reply = () => {
            res.writeHead(questionReplyStatus, { 'content-type': 'application/json' });
            res.end('{}');
          };
          if (opts.questionReplyDelayMs) setTimeout(reply, opts.questionReplyDelayMs);
          else reply();
          return;
        }
        if (req.method === 'POST' && /^\/question\/[^/]+\/reject$/.test(url)) {
          questionRejects.push({ path: url, body: JSON.parse(body || '{}') });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      promptPosts,
      promptBodies,
      questionGets,
      questionReplies,
      questionRejects,
      pendingQuestions,
      setQuestionReplyStatus(status: number): void {
        questionReplyStatus = status;
      },
      send(event: unknown): void {
        for (const c of clients) if (!c.destroyed) c.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      dropSse(): void {
        for (const c of clients) c.destroy();
        clients.length = 0;
      },
      async close(): Promise<void> {
        // Keep-alive sockets from the runner's fetch pool would otherwise
        // block `server.close` forever.
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /** Fake `opencode serve` child: prints the mock server's URL like the real
   *  binary, and dies immediately on any teardown signal. */
  function servedChild(url: string): ChildProcessWithoutNullStreams {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4242,
      kill: () => {
        Object.assign(child, { exitCode: 0, killed: true });
        emitter.emit('exit', 0, null);
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    stdout.write(`opencode server listening on ${url}\n`);
    return child;
  }

  /** Fake spawn failure: the process never started, so the runner only ever
   *  sees the ENOENT `error` event plus the immediate death (the shape node
   *  produces for a binary that is not on PATH). */
  function enoentChild(): ChildProcessWithoutNullStreams {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: undefined,
      kill: () => false,
    }) as unknown as ChildProcessWithoutNullStreams;
    const err = Object.assign(new Error('spawn opencode ENOENT'), {
      code: 'ENOENT',
      errno: -2,
      path: 'opencode',
    });
    process.nextTick(() => {
      emitter.emit('error', err);
      Object.assign(child, { exitCode: 1 });
      emitter.emit('exit', 1, null);
      emitter.emit('close', 1, null);
    });
    return child;
  }

  // Generous: under a fully loaded suite run these tests share the machine
  // with hundreds of files, and a tight bound here is a flake, not a check.
  async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const count = (events: AgentEvent[], type: string) => events.filter((e) => e.type === type).length;

  interface Harness {
    events: AgentEvent[];
    uiEvents: UiEvent[];
    mock: Awaited<ReturnType<typeof startMockServer>>;
    session: ReturnType<OpencodeServerRunner['startSession']>;
  }

  async function withSession(
    opts: MockServerOptions & {
      onUiEvent?: (event: UiEvent) => void;
      onAgentInputReady?: () => void;
      autoEndAfterFirstTurn?: boolean;
      effort?: string;
      model?: string;
    },
    run: (h: Harness) => Promise<void>,
  ): Promise<void> {
    const mock = await startMockServer(opts);
    spawnHook.override = () => servedChild(mock.url);
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 30_000 }).startSession(
      { userPrompt: 'go', cwd: process.cwd(), effort: opts.effort, model: opts.model },
      (e) => events.push(e),
      {
        autoEndAfterFirstTurn: opts.autoEndAfterFirstTurn,
        onAgentInputReady: opts.onAgentInputReady,
        onUiEvent: (e) => {
          uiEvents.push(e);
          opts.onUiEvent?.(e);
        },
      },
    );
    try {
      await run({ events, uiEvents, mock, session });
    } finally {
      spawnHook.override = null;
      session.end();
      await session.result.catch(() => undefined);
      await mock.close();
    }
  }

  function sendQuestion(
    mock: Harness['mock'],
    input: unknown,
    id = 'tool_question',
    status = 'running',
  ): void {
    mock.send({
      type: 'message.part.updated',
      properties: {
        part: {
          id,
          sessionID: 'ses_test',
          type: 'tool',
          tool: 'question',
          state: { status, input },
        },
      },
    });
  }

  it('posts the prompt to prompt_async and ends the turn on session.idle, not on the POST response', async () => {
    await withSession({}, async ({ events, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      expect(mock.promptPosts[0]).toBe('/session/ses_test/prompt_async');

      // The POST has resolved; the turn must still be open.
      await sleep(60);
      expect(count(events, 'turn-end')).toBe(0);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);
    });
  });

  it('posts a canonical effort pin as variant and omits it when unset (#45)', async () => {
    await withSession({ effort: 'high' }, async ({ mock }) => {
      await waitFor(() => mock.promptBodies.length === 1);
      expect(mock.promptBodies[0]).toMatchObject({ variant: 'high' });
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
    });
    await withSession({}, async ({ mock }) => {
      await waitFor(() => mock.promptBodies.length === 1);
      expect(mock.promptBodies[0]).not.toHaveProperty('variant');
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
    });
  });

  it('ignores session.idle from another session and ends the turn once on repeats', async () => {
    await withSession({}, async ({ events, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_other' } });
      await sleep(60);
      expect(count(events, 'turn-end')).toBe(0);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') >= 1);
      await sleep(60);
      expect(count(events, 'turn-end')).toBe(1);
    });
  });

  it('surfaces a note and ends the turn exactly once when the prompt POST fails', async () => {
    await withSession({ promptStatus: 500 }, async ({ events, mock, session }) => {
      await waitFor(() => count(events, 'turn-end') === 1);
      const notes = events.filter(
        (e) => e.type === 'note' && e.message.startsWith('opencode: prompt failed:'),
      );
      expect(notes).toHaveLength(1);

      // A stray idle afterwards must not end the already-ended turn again.
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await sleep(60);
      expect(count(events, 'turn-end')).toBe(1);

      // A first prompt that never posted is a failed session, not an empty
      // successful one — run.ts records failure from v1 `error` only.
      await waitFor(() => count(events, 'error') >= 1);
      await session.result;
      expect(count(events, 'error')).toBe(1);
      expect(events.findIndex(e => e.type === 'error')).toBeLessThan(events.findIndex(e => e.type === 'turn-end'));
      expect(session.open).toBe(false);
    });
  });

  it('drops SSE parts belonging to another session', async () => {
    await withSession({}, async ({ events, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);

      mock.send({
        type: 'message.updated',
        properties: { info: { id: 'msg_f', sessionID: 'ses_other', role: 'assistant' } },
      });
      mock.send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_f',
            messageID: 'msg_f',
            sessionID: 'ses_other',
            type: 'text',
            text: 'foreign',
            time: { start: 1, end: 2 },
          },
        },
      });
      mock.send({
        type: 'message.updated',
        properties: { info: { id: 'msg_m', sessionID: 'ses_test', role: 'assistant' } },
      });
      mock.send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_m',
            messageID: 'msg_m',
            sessionID: 'ses_test',
            type: 'text',
            text: 'ours',
            time: { start: 1, end: 2 },
          },
        },
      });
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);

      const texts = events.filter((e) => e.type === 'text').map((e) => e.text);
      expect(texts).toContain('ours');
      expect(texts.join('\n')).not.toContain('foreign');
    });
  });

  it('forwards a session.error into the v1 error stream before the terminal idle', async () => {
    await withSession({}, async ({ events, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);

      // Provider/auth failures arrive ONLY as `session.error` frames now that
      // the prompt POST returns before the turn runs — dropping them would
      // let the terminal idle file a failed turn as a successful step.
      mock.send({
        type: 'session.error',
        properties: { sessionID: 'ses_other', error: { name: 'X', data: { message: 'not ours' } } },
      });
      mock.send({
        type: 'session.error',
        properties: {
          sessionID: 'ses_test',
          error: { name: 'ProviderAuthError', data: { message: 'API key expired' } },
        },
      });
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);

      const errors = events.filter((e) => e.type === 'error').map((e) => e.message);
      expect(errors).toEqual(['opencode: provider request failed: API key expired']);
    });
  });

  // #53 — an upstream provider outage arrived as a bare `Not Found`, and
  // `opencode: Not Found` read exactly like a missing executable. The runner
  // is the only place that knows the selected provider/model, so it names
  // them and keeps any structured upstream status or code.
  it('identifies the provider and model in a runtime provider error', async () => {
    await withSession({ model: 'openai/gpt-5.6-sol' }, async ({ events, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);

      mock.send({
        type: 'session.error',
        properties: {
          sessionID: 'ses_test',
          error: { name: 'AI_APICallError', message: 'Not Found' },
        },
      });
      await waitFor(() => count(events, 'error') === 1);

      const message = events.find((e) => e.type === 'error')!.message;
      expect(message).toBe('opencode: provider openai/gpt-5.6-sol request failed: Not Found');
      // A runtime failure must never read like the spawn-failure guidance.
      expect(message).not.toMatch(/not found on PATH/i);
    });
  });

  it('keeps the structured upstream status or code in a forwarded provider error', async () => {
    await withSession({ model: 'openai/gpt-5.6-sol' }, async ({ events, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);

      mock.send({
        type: 'session.error',
        properties: {
          sessionID: 'ses_test',
          error: { name: 'AI_APICallError', message: 'Not Found', statusCode: 404 },
        },
      });
      mock.send({
        type: 'session.error',
        properties: {
          sessionID: 'ses_test',
          error: {
            name: 'ProviderError',
            message: 'quota exhausted',
            data: { code: 'insufficient_quota' },
          },
        },
      });
      await waitFor(() => count(events, 'error') === 2);

      const messages = events.filter((e) => e.type === 'error').map((e) => e.message);
      expect(messages[0]).toBe(
        'opencode: provider openai/gpt-5.6-sol request failed: Not Found (HTTP 404)',
      );
      expect(messages[1]).toBe(
        'opencode: provider openai/gpt-5.6-sol request failed: quota exhausted (code insufficient_quota)',
      );
    });
  });

  it('still separates a provider Not Found from a missing binary when no model is set', async () => {
    await withSession({}, async ({ events, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);

      mock.send({
        type: 'session.error',
        properties: { sessionID: 'ses_test', error: { message: 'Not Found' } },
      });
      await waitFor(() => count(events, 'error') === 1);

      expect(events.find((e) => e.type === 'error')!.message).toBe(
        'opencode: provider request failed: Not Found',
      );
    });
  });

  // The other half of #53: a genuinely missing executable keeps its explicit
  // PATH + installation guidance, distinct from any provider runtime error.
  it('keeps PATH and installation guidance for a missing binary', async () => {
    const child = enoentChild();
    spawnHook.override = () => child;
    try {
      const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 30_000 }).startSession({
        userPrompt: 'go',
        cwd: process.cwd(),
        model: 'openai/gpt-5.6-sol',
      });
      await expect(session.result).rejects.toThrow(/`opencode` not found on PATH/);
      await expect(session.result).rejects.toThrow(/https:\/\/opencode\.ai/);
    } finally {
      spawnHook.override = null;
    }
  });

  it('queues a follow-up prompt until the current turn ends', async () => {
    await withSession({}, async ({ events, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);

      // Mid-turn steering: opencode gets the next prompt only once the
      // current turn's idle has closed it, so each turn gets its own idle
      // and its own turn-end instead of the first idle closing the second.
      session.sendMessage([{ type: 'text', text: 'follow-up' }]);
      await sleep(80);
      expect(mock.promptPosts).toHaveLength(1);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => mock.promptPosts.length === 2);
      expect(count(events, 'turn-end')).toBe(1);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 2);
    });
  });

  it('maps a native question to ask.requested and sends selected answers to its reply endpoint', async () => {
    await withSession({}, async ({ events, uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_test', sessionID: 'ses_test' });

      const input = {
        questions: [
          {
            header: 'Architecture decisions',
            question: 'Which test framework?',
            options: [
              { label: 'Vitest', description: 'Use the existing suite' },
              { label: 'Node test', description: 'Use node:test' },
            ],
            multiple: true,
          },
        ],
      };
      sendQuestion(mock, input, 'tool_question', 'pending');
      sendQuestion(mock, input, 'tool_question', 'pending');

      await waitFor(() => uiEvents.some((event) => event.type === 'ask.requested'));
      expect(uiEvents.filter((event) => event.type === 'ask.requested')).toEqual([
        {
          type: 'ask.requested',
          requestId: 'q_test',
          questions: [
            {
              header: 'Architecture',
              question: 'Which test framework?',
              options: [
                { label: 'Vitest', description: 'Use the existing suite' },
                { label: 'Node test', description: 'Use node:test' },
              ],
              multiSelect: true,
            },
          ],
        },
      ]);

      session.sendMessage([{ type: 'text', text: 'Architecture: Vitest, Node test' }]);
      await waitFor(() => mock.questionReplies.length === 1);
      expect(mock.questionReplies).toEqual([
        {
          path: '/question/q_test/reply',
          body: { answers: [['Vitest', 'Node test']] },
        },
      ]);
      expect(mock.promptPosts).toHaveLength(1);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);
      session.sendMessage([{ type: 'text', text: 'continue normally' }]);
      await waitFor(() => mock.promptPosts.length === 2);
    });
  });

  it('caps native question fields and options and uses plain text for the first answer', async () => {
    await withSession({}, async ({ uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_caps', sessionID: 'ses_test' });
      sendQuestion(mock, {
        questions: [
          {
            header: `  ${'H'.repeat(20)}  `,
            question: `  ${'Q'.repeat(420)}  `,
            options: [
              { label: `  ${'A'.repeat(70)}  `, description: 'D'.repeat(300) },
              { label: 'Beta', description: 'Second' },
              { label: 'Gamma', description: 'Third' },
              { label: 'Delta', description: 'Fourth' },
              { label: 'Ignored', description: 'Fifth' },
            ],
          },
          {
            header: 'Deploy',
            question: 'Which environment?',
            options: [{ label: 'Staging' }, { label: 'Production' }],
          },
        ],
      });

      await waitFor(() => uiEvents.some((event) => event.type === 'ask.requested'));
      const ask = uiEvents.find((event) => event.type === 'ask.requested');
      expect(ask).toEqual({
        type: 'ask.requested',
        requestId: 'q_caps',
        questions: [
          {
            header: 'HHHHHHHHHHHH',
            question: 'Q'.repeat(400),
            options: [
              { label: 'A'.repeat(60), description: 'D'.repeat(280) },
              { label: 'Beta', description: 'Second' },
              { label: 'Gamma', description: 'Third' },
              { label: 'Delta', description: 'Fourth' },
            ],
          },
          {
            header: 'Deploy',
            question: 'Which environment?',
            options: [{ label: 'Staging' }, { label: 'Production' }],
          },
        ],
      });

      session.sendMessage([{ type: 'text', text: '  Use sensible defaults  ' }]);
      await waitFor(() => mock.questionReplies.length === 1);
      expect(mock.questionReplies[0]).toEqual({
        path: '/question/q_caps/reply',
        body: { answers: [['Use sensible defaults'], []] },
      });
      expect(mock.promptPosts).toHaveLength(1);
    });
  });

  it('routes repeated Header lines to matching questions in order', async () => {
    await withSession({}, async ({ uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_repeated', sessionID: 'ses_test' });
      sendQuestion(mock, {
        questions: [
          {
            header: 'Choice',
            question: 'Which database?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
          {
            header: 'Choice',
            question: 'Which cache?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
        ],
      });
      await waitFor(() => uiEvents.some((event) => event.type === 'ask.requested'));

      session.sendMessage([{ type: 'text', text: 'Choice: One\nChoice: Two' }]);
      await waitFor(() => mock.questionReplies.length === 1);
      expect(mock.questionReplies[0]).toEqual({
        path: '/question/q_repeated/reply',
        body: { answers: [['One'], ['Two']] },
      });
    });
  });

  it('contains an onUiEvent exception while emitting a native ask', async () => {
    await withSession(
      {
        onUiEvent: (event) => {
          if (event.type === 'ask.requested') throw new Error('consumer failed');
        },
      },
      async ({ events, uiEvents, mock, session }) => {
        await waitFor(() => mock.promptPosts.length === 1);
        mock.pendingQuestions.push({ id: 'q_throw', sessionID: 'ses_test' });
        sendQuestion(mock, {
          questions: [
            {
              header: 'Choice',
              question: 'Which option?',
              options: [{ label: 'One' }, { label: 'Two' }],
            },
          ],
        });
        await waitFor(() => uiEvents.some((event) => event.type === 'ask.requested'));

        session.sendMessage([{ type: 'text', text: 'Choice: One' }]);
        await waitFor(() => mock.questionReplies.length === 1);
        expect(mock.questionReplies[0]).toEqual({
          path: '/question/q_throw/reply',
          body: { answers: [['One']] },
        });
        expect(events.some((event) => event.type === 'error')).toBe(false);
      },
    );
  });

  it('keeps and re-emits a native ask when its reply POST fails so the user can retry', async () => {
    await withSession({ questionReplyStatus: 500 }, async ({ events, uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_retry', sessionID: 'ses_test' });
      sendQuestion(mock, {
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
        ],
      });
      await waitFor(() => uiEvents.filter((event) => event.type === 'ask.requested').length === 1);

      session.sendMessage([{ type: 'text', text: 'Choice: One' }]);
      await waitFor(() =>
        events.some(
          (event) =>
            event.type === 'note' &&
            event.message === 'opencode: question reply failed: POST /question/q_retry/reply → 500 {}',
        ),
      );
      await waitFor(() => uiEvents.filter((event) => event.type === 'ask.requested').length === 2);
      expect(uiEvents.filter((event) => event.type === 'ask.requested').map((event) => event.requestId)).toEqual([
        'q_retry',
        'q_retry',
      ]);
      expect(mock.promptPosts).toHaveLength(1);

      mock.setQuestionReplyStatus(200);
      session.sendMessage([{ type: 'text', text: 'Choice: Two' }]);
      await waitFor(() => mock.questionReplies.length === 2);
      expect(mock.questionReplies.map((reply) => reply.body)).toEqual([
        { answers: [['One']] },
        { answers: [['Two']] },
      ]);
      expect(mock.promptPosts).toHaveLength(1);
    });
  });

  it('does not recapture or prompt while a native question reply is in flight', async () => {
    await withSession({ questionReplyDelayMs: 250 }, async ({ uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_delayed', sessionID: 'ses_test' });
      const input = {
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
        ],
      };
      sendQuestion(mock, input);
      await waitFor(() => uiEvents.filter((event) => event.type === 'ask.requested').length === 1);

      session.sendMessage([{ type: 'text', text: 'Choice: One' }]);
      await waitFor(() => mock.questionReplies.length === 1);
      sendQuestion(mock, input);
      session.sendMessage([{ type: 'text', text: 'must not become a prompt' }]);
      await sleep(80);

      expect(uiEvents.filter((event) => event.type === 'ask.requested')).toHaveLength(1);
      expect(mock.questionGets).toHaveLength(1);
      expect(mock.questionReplies).toHaveLength(1);
      expect(mock.promptPosts).toHaveLength(1);
    });
  });

  it('never recaptures a handled question part but captures a different part in a later turn', async () => {
    await withSession({}, async ({ events, uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_once', sessionID: 'ses_test' });
      const input = {
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
        ],
      };
      sendQuestion(mock, input, 'part_once');
      await waitFor(() => uiEvents.filter((event) => event.type === 'ask.requested').length === 1);

      session.sendMessage([{ type: 'text', text: 'Choice: One' }]);
      await waitFor(() => mock.questionReplies.length === 1);
      await sleep(40);
      sendQuestion(mock, input, 'part_once', 'completed');
      await sleep(80);

      expect(uiEvents.filter((event) => event.type === 'ask.requested')).toHaveLength(1);
      expect(mock.questionGets).toHaveLength(1);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);
      session.sendMessage([{ type: 'text', text: 'continue' }]);
      await waitFor(() => mock.promptPosts.length === 2);
      mock.pendingQuestions.splice(0, 1, { id: 'q_later', sessionID: 'ses_test' });
      sendQuestion(mock, input, 'part_later');
      await waitFor(() => uiEvents.filter((event) => event.type === 'ask.requested').length === 2);
      expect(mock.questionGets).toHaveLength(2);
      expect(uiEvents.filter((event) => event.type === 'ask.requested')[1]).toMatchObject({
        requestId: 'q_later',
      });
    });
  });

  it('waits for a valid later snapshot of the same pending question part', async () => {
    await withSession({}, async ({ uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_parsed_later', sessionID: 'ses_test' });
      const input = {
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
        ],
      };

      sendQuestion(mock, {}, 'part_parsed_later', 'pending');
      await sleep(80);
      expect(mock.questionGets).toEqual([]);
      expect(mock.questionRejects).toEqual([]);
      expect(uiEvents.filter((event) => event.type === 'ask.requested')).toEqual([]);

      sendQuestion(mock, input, 'part_parsed_later', 'running');
      await waitFor(() => uiEvents.some((event) => event.type === 'ask.requested'));
      expect(mock.questionGets).toHaveLength(1);
      expect(mock.questionRejects).toEqual([]);
      expect(uiEvents.find((event) => event.type === 'ask.requested')).toEqual({
        type: 'ask.requested',
        requestId: 'q_parsed_later',
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
        ],
      });

      session.sendMessage([{ type: 'text', text: 'Choice: Two' }]);
      await waitFor(() => mock.questionReplies.length === 1);
      expect(mock.questionReplies[0]).toEqual({
        path: '/question/q_parsed_later/reply',
        body: { answers: [['Two']] },
      });
    });
  });

  it('queues messages sent during a successful question reply and prompts in order after idle', async () => {
    await withSession({ questionReplyDelayMs: 180 }, async ({ events, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_queue', sessionID: 'ses_test' });
      sendQuestion(mock, {
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
        ],
      });
      await waitFor(() => mock.questionGets.length === 1);

      session.sendMessage([{ type: 'text', text: 'Choice: One' }]);
      await waitFor(() => mock.questionReplies.length === 1);
      session.sendMessage([{ type: 'text', text: 'first queued prompt' }]);
      session.sendMessage([{ type: 'text', text: 'second queued prompt' }]);
      await sleep(240);
      expect(mock.promptPosts).toHaveLength(1);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => mock.promptPosts.length === 2);
      expect(mock.promptBodies[1]).toEqual({ parts: [{ type: 'text', text: 'first queued prompt' }] });
      expect(count(events, 'turn-end')).toBe(1);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => mock.promptPosts.length === 3);
      expect(mock.promptBodies[2]).toEqual({ parts: [{ type: 'text', text: 'second queued prompt' }] });
    });
  });

  it('keeps queued text through a failed reply until a later explicit answer succeeds', async () => {
    await withSession(
      { questionReplyStatus: 500, questionReplyDelayMs: 120 },
      async ({ events, mock, session }) => {
        await waitFor(() => mock.promptPosts.length === 1);
        mock.pendingQuestions.push({ id: 'q_queue_retry', sessionID: 'ses_test' });
        sendQuestion(mock, {
          questions: [
            {
              header: 'Choice',
              question: 'Which option?',
              options: [{ label: 'One' }, { label: 'Two' }],
            },
          ],
        });
        await waitFor(() => mock.questionGets.length === 1);

        session.sendMessage([{ type: 'text', text: 'Choice: One' }]);
        await waitFor(() => mock.questionReplies.length === 1);
        session.sendMessage([{ type: 'text', text: 'queued after failed answer' }]);
        await waitFor(() =>
          events.some(
            (event) => event.type === 'note' && event.message.includes('question reply failed'),
          ),
        );
        expect(mock.promptPosts).toHaveLength(1);
        expect(mock.questionReplies).toHaveLength(1);

        mock.setQuestionReplyStatus(200);
        session.sendMessage([{ type: 'text', text: 'Choice: Two' }]);
        await waitFor(() => mock.questionReplies.length === 2);
        await sleep(180);
        expect(mock.questionReplies.map((reply) => reply.body)).toEqual([
          { answers: [['One']] },
          { answers: [['Two']] },
        ]);
        expect(mock.promptPosts).toHaveLength(1);

        mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
        await waitFor(() => mock.promptPosts.length === 2);
        expect(mock.promptBodies[1]).toEqual({
          parts: [{ type: 'text', text: 'queued after failed answer' }],
        });
      },
    );
  });

  it('hints readiness after an idle human prompt receives its late HTTP acknowledgement', async () => {
    let ready = 0;
    await withSession({ followupPromptDelayMs: 150, onAgentInputReady: () => { ready++; } }, async ({ events, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);
      session.sendMessage([{ type: 'text', text: 'human next turn' }]);
      await waitFor(() => mock.promptPosts.length === 2);
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 2);
      expect(session.sendAgentMessage([{ type: 'text', text: 'agent later turn' }])).toBe(false);
      await waitFor(() => ready === 1);
      expect(session.sendAgentMessage([{ type: 'text', text: 'agent later turn' }])).toBe(true);
      await waitFor(() => mock.promptPosts.length === 3);
    });
  });

  it('does not let non-human input overtake queued human turns at SSE idle', async () => {
    await withSession({}, async ({ events, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      session.sendMessage([{ type: 'text', text: 'human next turn' }]);
      // The v1 callback is the manager's drain boundary: run it synchronously,
      // before promise waiters can begin the already queued human prompt.
      const push = events.push.bind(events);
      let attempted: boolean | undefined;
      events.push = (...incoming) => {
        const length = push(...incoming);
        if (incoming.some(event => event.type === 'turn-end') && attempted === undefined) {
          attempted = session.sendAgentMessage([{ type: 'text', text: 'agent later turn' }]);
        }
        return length;
      };
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => attempted !== undefined);
      expect(attempted).toBe(false);
      await waitFor(() => mock.promptPosts.length === 2);
      expect(mock.promptBodies[1]).toEqual({ parts: [{ type: 'text', text: 'human next turn' }] });
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 2);
      expect(session.sendAgentMessage([{ type: 'text', text: 'agent later turn' }])).toBe(true);
      await waitFor(() => mock.promptPosts.length === 3);
      expect(mock.promptBodies[2]).toEqual({ parts: [{ type: 'text', text: 'agent later turn' }] });
    });
  });

  it('hints non-human readiness only after a successful late reply retry, never on failure', async () => {
    let ready = 0;
    await withSession({ questionReplyDelayMs: 100, questionReplyStatus: 500, onAgentInputReady: () => { ready++; } }, async ({ events, uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_agent_retry', sessionID: 'ses_test' });
      sendQuestion(mock, { questions: [{ header: 'Choice', question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }] }] });
      await waitFor(() => uiEvents.some(event => event.type === 'ask.requested'));
      session.sendMessage([{ type: 'text', text: 'Choice: One' }]);
      await waitFor(() => mock.questionReplies.length === 1);
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);
      expect(session.sendAgentMessage([{ type: 'text', text: 'agent instruction' }])).toBe(false);
      await waitFor(() => uiEvents.filter(event => event.type === 'ask.requested').length === 2);
      expect(ready).toBe(0);
      mock.setQuestionReplyStatus(200);
      session.sendMessage([{ type: 'text', text: 'Choice: Two' }]);
      await waitFor(() => ready === 1);
      expect(session.sendAgentMessage([{ type: 'text', text: 'agent instruction' }])).toBe(true);
      await waitFor(() => mock.promptPosts.length === 2);
      expect(mock.promptBodies[1]).toEqual({ parts: [{ type: 'text', text: 'agent instruction' }] });
      expect(mock.questionReplies).toHaveLength(2);
    });
  });

  it('keeps post-idle messages queued until a delayed reply succeeds and drains them FIFO', async () => {
    await withSession({ questionReplyDelayMs: 260 }, async ({ events, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_idle_success', sessionID: 'ses_test' });
      sendQuestion(mock, {
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
        ],
      });
      await waitFor(() => mock.questionGets.length === 1);

      session.sendMessage([{ type: 'text', text: 'Choice: One' }]);
      await waitFor(() => mock.questionReplies.length === 1);
      session.sendMessage([{ type: 'text', text: 'queued A' }]);
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);
      session.sendMessage([{ type: 'text', text: 'queued B' }]);
      await sleep(100);
      expect(mock.promptPosts).toHaveLength(1);

      await waitFor(() => mock.promptPosts.length === 2);
      expect(mock.promptBodies[1]).toEqual({ parts: [{ type: 'text', text: 'queued A' }] });
      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => mock.promptPosts.length === 3);
      expect(mock.promptBodies[2]).toEqual({ parts: [{ type: 'text', text: 'queued B' }] });
    });
  });

  it('restores an ask after an early-idle reply failure and retains queued text through retry', async () => {
    await withSession(
      { questionReplyStatus: 500, questionReplyDelayMs: 180 },
      async ({ events, uiEvents, mock, session }) => {
        await waitFor(() => mock.promptPosts.length === 1);
        mock.pendingQuestions.push({ id: 'q_idle_retry', sessionID: 'ses_test' });
        sendQuestion(mock, {
          questions: [
            {
              header: 'Choice',
              question: 'Which option?',
              options: [{ label: 'One' }, { label: 'Two' }],
            },
          ],
        });
        await waitFor(() => uiEvents.filter((event) => event.type === 'ask.requested').length === 1);

        session.sendMessage([{ type: 'text', text: 'Choice: One' }]);
        await waitFor(() => mock.questionReplies.length === 1);
        session.sendMessage([{ type: 'text', text: 'queued A' }]);
        mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
        await waitFor(() => count(events, 'turn-end') === 1);
        await waitFor(() => uiEvents.filter((event) => event.type === 'ask.requested').length === 2);
        expect(mock.promptPosts).toHaveLength(1);

        mock.setQuestionReplyStatus(200);
        session.sendMessage([{ type: 'text', text: 'Choice: Two' }]);
        await waitFor(() => mock.questionReplies.length === 2);
        await sleep(80);
        expect(mock.promptPosts).toHaveLength(1);
        expect(mock.questionReplies.map((reply) => reply.body)).toEqual([
          { answers: [['One']] },
          { answers: [['Two']] },
        ]);

        await waitFor(() => mock.promptPosts.length === 2);
        expect(mock.promptBodies[1]).toEqual({ parts: [{ type: 'text', text: 'queued A' }] });
      },
    );
  });

  it('defers auto-end while an early-idle reply still owns queued prompt delivery', async () => {
    await withSession(
      { autoEndAfterFirstTurn: true, questionReplyDelayMs: AUTO_END_DELAY_MS + 180, questionGetDelayMs: 75 },
      async ({ events, uiEvents, mock, session }) => {
        await waitFor(() => mock.promptPosts.length === 1);
        mock.pendingQuestions.push({ id: 'q_idle_auto_end', sessionID: 'ses_test' });
        sendQuestion(mock, {
          questions: [
            {
              header: 'Choice',
              question: 'Which option?',
              options: [{ label: 'One' }, { label: 'Two' }],
            },
          ],
        });
        await waitFor(() => uiEvents.some(event => event.type === 'ask.requested'));
        expect(mock.questionGets).toHaveLength(1);
        // Receiving GET is not receiving its response: a human can answer only after
        // the runner publishes the question, including over a delayed local response.
        expect(uiEvents.find(event => event.type === 'ask.requested')).toMatchObject({ requestId: 'q_idle_auto_end' });

        session.sendMessage([{ type: 'text', text: 'Choice: One' }]);
        await waitFor(() => mock.questionReplies.length === 1);
        session.sendMessage([{ type: 'text', text: 'queued after idle' }]);
        mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
        await waitFor(() => count(events, 'turn-end') === 1);
        await sleep(AUTO_END_DELAY_MS + 60);

        expect(session.open).toBe(true);
        expect(mock.promptPosts).toHaveLength(1);
        await waitFor(() => mock.promptPosts.length === 2);
        expect(mock.promptBodies[1]).toEqual({
          parts: [{ type: 'text', text: 'queued after idle' }],
        });
      },
    );
  });

  it('rejects malformed-first native input without shifting the valid second question', async () => {
    await withSession({}, async ({ events, uiEvents, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_malformed_first', sessionID: 'ses_test' });
      sendQuestion(mock, {
        questions: [
          {
            header: 'Broken',
            question: 'Cannot represent this?',
            options: [{ label: 'Only one' }],
          },
          {
            header: 'Valid',
            question: 'Must not shift?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      });

      await waitFor(() =>
        events.some(
          (event) =>
            event.type === 'note' &&
            event.message === 'opencode: unsupported native question rejected',
        ),
      );
      expect(uiEvents.filter((event) => event.type === 'ask.requested')).toEqual([]);
      expect(mock.questionReplies).toEqual([]);
      expect(mock.questionRejects).toEqual([
        { path: '/question/q_malformed_first/reject', body: {} },
      ]);
      expect(events).toContainEqual({
        type: 'note',
        message: 'opencode: unsupported native question rejected',
      });
    });
  });

  it.each([
    ['empty list', { questions: [] }],
    [
      'more than four questions',
      {
        questions: Array.from({ length: 5 }, (_, index) => ({
          header: `Q${index}`,
          question: `Question ${index}?`,
          options: [{ label: 'Yes' }, { label: 'No' }],
        })),
      },
    ],
    [
      'malformed question',
      {
        questions: [null],
      },
    ],
    [
      'fewer than two usable options',
      {
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'One' }, { label: '  ' }, null],
          },
        ],
      },
    ],
    [
      'schema uniqueness failure',
      {
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'Same' }, { label: 'Same' }],
          },
        ],
      },
    ],
  ])('rejects invalid native input with a found ID: %s', async (_label, input) => {
    await withSession({}, async ({ events, uiEvents, mock }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      mock.pendingQuestions.push({ id: 'q_invalid', sessionID: 'ses_test' });
      sendQuestion(mock, input);

      await waitFor(() =>
        events.some(
          (event) =>
            event.type === 'note' &&
            event.message === 'opencode: unsupported native question rejected',
        ),
      );
      expect(mock.questionGets).toHaveLength(1);
      expect(mock.questionReplies).toEqual([]);
      expect(uiEvents.filter((event) => event.type === 'ask.requested')).toEqual([]);
      expect(events).toContainEqual({
        type: 'note',
        message: 'opencode: unsupported native question rejected',
      });
      expect(count(events, 'turn-end')).toBe(0);
    });
  });

  it('terminates the turn and session when an invalid native request ID cannot be found', async () => {
    await withSession({}, async ({ events, uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      sendQuestion(mock, { questions: [] });

      await waitFor(() => !session.open);
      expect(mock.questionGets).toHaveLength(8);
      expect(mock.questionRejects).toEqual([]);
      expect(uiEvents.filter((event) => event.type === 'ask.requested')).toEqual([]);
      expect(events).toContainEqual({
        type: 'error',
        message: 'opencode: unsupported native question could not be rejected: no pending question id',
      });
      expect(count(events, 'turn-end')).toBe(1);
    });
  });

  it('does not post a prompt when all pending-question ID lookups fail', async () => {
    await withSession({}, async ({ events, uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      sendQuestion(mock, {
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
        ],
      });

      await waitFor(() => uiEvents.some((event) => event.type === 'ask.requested'));
      expect(mock.questionGets).toHaveLength(8);
      expect(uiEvents.find((event) => event.type === 'ask.requested')).toEqual({
        type: 'ask.requested',
        requestId: expect.stringMatching(/^opencode-/),
        questions: [
          {
            header: 'Choice',
            question: 'Which option?',
            options: [{ label: 'One' }, { label: 'Two' }],
          },
        ],
      });

      session.sendMessage([{ type: 'text', text: 'One' }]);
      await waitFor(() => mock.questionGets.length === 9);
      await waitFor(() =>
        events.some(
          (event) =>
            event.type === 'note' &&
            event.message === 'opencode: question reply failed: no pending question id',
        ),
      );
      expect(mock.questionReplies).toEqual([]);
      expect(mock.promptPosts).toHaveLength(1);
      const asks = uiEvents.filter((event) => event.type === 'ask.requested');
      expect(asks).toHaveLength(2);
      expect(asks[1]).toEqual(asks[0]);

      mock.pendingQuestions.push({ id: 'q_late', sessionID: 'ses_test' });
      session.sendMessage([{ type: 'text', text: 'Two' }]);
      await waitFor(() => mock.questionReplies.length === 1);
      expect(mock.questionGets).toHaveLength(10);
      expect(mock.questionReplies[0]).toEqual({
        path: '/question/q_late/reply',
        body: { answers: [['Two']] },
      });
      expect(mock.promptPosts).toHaveLength(1);
    });
  });

  it('discards a question capture that completes after its turn ended', async () => {
    await withSession({}, async ({ events, uiEvents, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);
      sendQuestion(mock, {
        questions: [
          {
            header: 'Stale',
            question: 'Should this survive?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      });
      await waitFor(() => mock.questionGets.length === 1);

      mock.send({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
      await waitFor(() => count(events, 'turn-end') === 1);
      mock.pendingQuestions.push({ id: 'q_too_late', sessionID: 'ses_test' });
      await sleep(250);
      expect(uiEvents.filter((event) => event.type === 'ask.requested')).toEqual([]);

      session.sendMessage([{ type: 'text', text: 'a later prompt' }]);
      await waitFor(() => mock.promptPosts.length === 2);
      expect(mock.questionReplies).toEqual([]);
    });
  });

  it('ends the turn and the session when the event stream drops mid-turn', async () => {
    await withSession({}, async ({ events, mock, session }) => {
      await waitFor(() => mock.promptPosts.length === 1);

      // The bus is the only source of `session.idle` now — losing it must not
      // park the turn forever.
      mock.dropSse();
      await waitFor(() => count(events, 'turn-end') === 1);
      // An error, not a note — a turn whose output was cut off must fail the
      // step, and run.ts records failure from v1 `error` only.
      const errors = events.filter(
        (e) => e.type === 'error' && e.message.includes('event stream'),
      );
      expect(errors).toHaveLength(1);
      await session.result;
      expect(session.open).toBe(false);
    });
  });

  it('fails the session loudly when the event stream answers with an error status', async () => {
    await withSession({ sseStatus: 500 }, async ({ events, session }) => {
      await waitFor(() => count(events, 'error') >= 1);
      await session.result;
      expect(count(events, 'turn-end')).toBe(0);
      expect(session.open).toBe(false);
    });
  });

  it('fails the session loudly when the event stream cannot connect', async () => {
    await withSession({ refuseSse: true }, async ({ events, session }) => {
      await waitFor(() => count(events, 'error') >= 1);
      await session.result;
      // The prompt never posts into a session that cannot hear its events.
      expect(count(events, 'turn-end')).toBe(0);
    });
  });
});
