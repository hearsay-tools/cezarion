import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.ts';
import { buildClaudeArgs, ClaudeCliRunner } from './claude-cli-runner.ts';
import { EOF_KILL_GRACE_MS, EOF_TERM_GRACE_MS, KILL_GRACE_MS } from './runner-runtime.ts';
import type { UiEvent } from './ui-events.ts';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning its real stub binary through the untouched `spawn`. */
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
 * The per-backend system-prompt delivery mechanism (spec §protocol v2
 * mapping table): claude gets `--append-system-prompt`, codex/opencode get
 * the prompt prepended to the opening user message (`prependSystemPrompt`,
 * shared by both runners).
 */
describe('buildClaudeArgs systemPrompt', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits --append-system-prompt with the exact text', () => {
    const args = buildClaudeArgs({ ...spec, systemPrompt: 'Extra rules.\n\n---\n\nContract.' });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Extra rules.\n\n---\n\nContract.');
  });

  it('omits the flag entirely when no systemPrompt is set', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--append-system-prompt');
  });
});

describe('buildClaudeArgs effort (#45)', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits --effort next to --model when a canonical pin is set', () => {
    const args = buildClaudeArgs({ ...spec, model: 'opus', effort: 'xhigh' });
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('xhigh');
  });

  it('omits the flag when effort is unset so the harness keeps its default', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--effort');
  });

  it('omits the flag for auto/unknown values rather than sending a no-op string', () => {
    expect(buildClaudeArgs({ ...spec, effort: 'auto' })).not.toContain('--effort');
    expect(buildClaudeArgs({ ...spec, effort: 'nope' })).not.toContain('--effort');
  });
});

describe('buildClaudeArgs approval gate', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('denies unapproved tools without prompting by default', () => {
    const args = buildClaudeArgs(spec, {});
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('dontAsk');
  });

  it('enables Claude approval prompts only when explicitly requested', () => {
    const args = buildClaudeArgs(spec, { CEZ_APPROVAL_GATE: '1' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('acceptEdits');
  });
});

describe('buildClaudeArgs permission mode', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('selects bypass with --dangerously-skip-permissions and no --permission-mode', () => {
    const args = buildClaudeArgs(spec, { CEZ_CLAUDE_PERMISSION_MODE: 'bypass' });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('honours an explicit mode over CEZ_APPROVAL_GATE', () => {
    const args = buildClaudeArgs(spec, {
      CEZ_CLAUDE_PERMISSION_MODE: 'dontAsk',
      CEZ_APPROVAL_GATE: '1',
    });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('dontAsk');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('passes --setting-sources when CEZ_CLAUDE_SETTING_SOURCES is set', () => {
    const args = buildClaudeArgs(spec, {
      CEZ_CLAUDE_PERMISSION_MODE: 'bypass',
      CEZ_CLAUDE_SETTING_SOURCES: 'user,project,local',
    });
    expect(args).toContain('--dangerously-skip-permissions');
    const idx = args.indexOf('--setting-sources');
    expect(args[idx + 1]).toBe('user,project,local');
  });

  it('omits --setting-sources when the env var is unset or empty', () => {
    expect(buildClaudeArgs(spec, {})).not.toContain('--setting-sources');
    expect(buildClaudeArgs(spec, { CEZ_CLAUDE_SETTING_SOURCES: '' })).not.toContain(
      '--setting-sources',
    );
  });

  it('falls back to dontAsk when CEZ_CLAUDE_PERMISSION_MODE is unknown', () => {
    const args = buildClaudeArgs(spec, { CEZ_CLAUDE_PERMISSION_MODE: 'manual' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('dontAsk');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('keeps CEZ_APPROVAL_GATE when CEZ_CLAUDE_PERMISSION_MODE is unknown', () => {
    const args = buildClaudeArgs(spec, {
      CEZ_CLAUDE_PERMISSION_MODE: 'manual',
      CEZ_APPROVAL_GATE: '1',
    });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('acceptEdits');
  });

  it('selects acceptEdits without CEZ_APPROVAL_GATE', () => {
    const args = buildClaudeArgs(spec, { CEZ_CLAUDE_PERMISSION_MODE: 'acceptEdits' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('acceptEdits');
  });
});

/**
 * #703 — a session cezar tore down itself must not settle as an agent
 * failure. Every agent CLI installs its own stop-signal handler and exits
 * `128 + signal`, so the runner sees a NON-ZERO code for a teardown it
 * asked for (goal achieved → `end()`, or a user cancel → `interrupt()`).
 */
describe('isSignalTerminationExit', () => {
  it('recognizes the 128+signal codes a signalled CLI reports', () => {
    expect(isSignalTerminationExit(130)).toBe(true); // SIGINT
    expect(isSignalTerminationExit(137)).toBe(true); // SIGKILL
    expect(isSignalTerminationExit(143)).toBe(true); // SIGTERM
  });

  it('leaves genuine failures and clean exits alone', () => {
    for (const code of [0, 1, 2, 127, null]) {
      expect(isSignalTerminationExit(code)).toBe(false);
    }
  });
});

describe('a teardown cezar initiated', () => {
  const stubBin = fileURLToPath(
    new URL('./__fixtures__/claude/stub-ignores-eof-exits-143.mjs', import.meta.url),
  );

  it('settles the session instead of failing it when the CLI exits 143', async () => {
    const runner = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `signalChild`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('work done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      uiEvents.some((event) => event.type === 'turn.completed' && event.stopReason === 'error'),
    ).toBe(false);
    expect(uiEvents).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);
});

/**
 * #844 — the watchdogs used to ask `!child.killed` before escalating, but Node
 * sets `killed` the moment a signal is *delivered*. claude installs its own
 * SIGTERM handler, so the flag went true while the process ran on and the
 * SIGKILL that exists for exactly that case was never sent — one leaked CLI per
 * teardown. The escalation now follows real termination instead.
 */
describe('SIGTERM→SIGKILL escalation for a CLI that survives SIGTERM', () => {
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
      pid: 4242,
      // Node's semantics: delivery flips `killed`; a CLI with its own handler
      // keeps running with `exitCode` still null.
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

  it('escalates after end() even though Node already flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('escalates on the wall-clock timeout path as well', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once the CLI really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });
});

describe('prependSystemPrompt (codex/opencode delivery)', () => {
  it('prepends the prompt as a leading block of the first user message', () => {
    expect(prependSystemPrompt('Extra rules.', 'do it')).toBe('Extra rules.\n\n---\n\ndo it');
  });

  it('leaves the user prompt untouched when no systemPrompt is set', () => {
    expect(prependSystemPrompt(undefined, 'do it')).toBe('do it');
  });
});

describe('ClaudeCliRunner token usage', () => {
  it('forwards a reported zero-dollar result even when Claude reports an error', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-zero-cost-'));
    try {
      await new ClaudeCliRunner({ bin: mockBin, timeoutMs: 10_000 }).run(
        { userPrompt: 'mock:auth-error', cwd, sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58' },
        (event) => events.push(event),
      ).catch(() => undefined);
      expect(events.filter((event) => event.type === 'cost')).toEqual([{ type: 'cost', usd: 0 }]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it('counts the aggregate result usage without re-adding assistant-frame snapshots', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-token-usage-'));

    try {
      const result = await runner.run(
        {
          userPrompt: 'fix the login redirect',
          cwd,
          env: {
            CEZ_HANDOFF_FILE: '',
            CEZ_MOCK_ARGS_FILE: '',
            CEZ_TODOS_FILE: '',
          },
          sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58',
        },
        (event) => events.push(event),
      );

      // The mock emits four assistant usage snapshots before its aggregate
      // result usage (1,270 input + 185 output). Only the result is authoritative.
      expect(result.tokensUsed).toBe(1_455);
      expect(events.filter((event) => event.type === 'token-usage')).toEqual([
        { type: 'token-usage', tokensUsed: 1_455 },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

it('steers non-human input behind a queued human turn but never after its CEZ:ASK', async () => {
  // Pre-#505 the queued human turn refused all agent input until it ended. Claude now
  // steers a mid-turn line into the running turn; only a pending CEZ:ASK still refuses.
  const { driveSeam, waitFor } = await import('./harness-parity.testkit.ts');
  await driveSeam('claude', 'hold', {
    whileOpen: async (session, { v1 }) => {
      expect(session.sendMessage([{ type: 'text', text: 'mock:ask' }])).toBe(true);
      await waitFor(() => v1.filter(event => event.type === 'turn-end').length === 1);
      expect(session.sendAgentMessage([{ type: 'text', text: 'steered while busy' }])).not.toBe(false);
      await waitFor(() => v1.filter(event => event.type === 'turn-end').length === 2);
      expect(session.sendAgentMessage([{ type: 'text', text: 'must not answer the ask' }])).toBe(false);
    },
  });
});

describe('Claude non-human stdin acknowledgement boundary', () => {
  it.each(['acknowledged', 'write error', 'closed'] as const)('%s settles only the reserved write and never a mere turn-end', async outcome => {
    const { Writable } = await import('node:stream');
    let completeWrite: ((error?: Error | null) => void) | undefined;
    let writes = 0;
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stdin = new Writable({ write(_chunk, _encoding, callback) {
      writes++;
      if (writes === 1) callback();
      else completeWrite = callback;
    } });
    const child = Object.assign(emitter, { stdin, stdout, stderr: new PassThrough(),
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
      kill: () => { close(); return true; },
    }) as unknown as ChildProcessWithoutNullStreams;
    const close = () => {
      if (child.exitCode !== null) return;
      Object.assign(child, { exitCode: 0 }); stdout.end();
      emitter.emit('exit', 0, null); emitter.emit('close', 0, null);
    };
    stdin.on('finish', close);
    spawnHook.override = () => child;
    const events: AgentEvent[] = [];
    const runner = new ClaudeCliRunner({ bin: 'unused-pipe-fixture' });
    const session = runner.startSession({ userPrompt: 'opening', cwd: '/tmp', timeoutMs: 0 }, event => events.push(event), { autoEndAfterFirstTurn: true });
    const resultFrame = () => stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'turn complete', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
    try {
      resultFrame();
      await vi.waitFor(() => expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1));
      const ack = session.sendAgentMessage([{ type: 'text', text: 'reserved' }]);
      expect(ack).toBeInstanceOf(Promise);
      if (!ack) throw new Error('expected reserved write');
      let settlement: 'pending' | 'accepted' | 'rejected' = 'pending';
      const observed = ack.then(() => { settlement = 'accepted'; }, () => { settlement = 'rejected'; });
      resultFrame();
      await vi.waitFor(() => expect(events.filter(event => event.type === 'turn-end')).toHaveLength(2));
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(settlement).toBe('pending'); expect(session.open).toBe(true);
      expect(session.sendAgentMessage([{ type: 'text', text: 'duplicate' }])).toBe(false);
      expect(writes).toBe(2);
      if (outcome === 'closed') close();
      else completeWrite?.(outcome === 'write error' ? new Error('pipe refused') : undefined);
      await observed;
      expect(settlement).toBe(outcome === 'acknowledged' ? 'accepted' : 'rejected');
      if (outcome === 'acknowledged') await vi.waitFor(() => expect(session.open).toBe(false));
    } finally {
      session.interrupt(); close();
      await session.result;
      spawnHook.override = null;
    }
  });
});

/**
 * #146 — a human follow-up written BEFORE the opening result must survive the
 * auto-end window. Real timers throughout: the 250 ms reopen window is the
 * thing under test, so nothing here fakes or advances a clock.
 */
describe('Claude auto-end with a prompt turn still pending (#146)', () => {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  /** A controlled child over real pipes: the test decides exactly when each
   *  `result` frame lands, and records the moment the runner closes stdin. */
  function pipeFixture() {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let stdinEnded = false;
    stdin.on('finish', () => { stdinEnded = true; });
    stdin.resume();
    const child = Object.assign(emitter, { stdin, stdout, stderr: new PassThrough(),
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
      kill: () => { close(143); return true; },
    }) as unknown as ChildProcessWithoutNullStreams;
    const close = (code = 0) => {
      if (child.exitCode !== null) return;
      Object.assign(child, { exitCode: code }); stdout.end();
      emitter.emit('exit', code, null); emitter.emit('close', code, null);
    };
    const result = (text: string) => stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', result: text, usage: { input_tokens: 1, output_tokens: 1 },
    }) + '\n');
    return { child, close, result, stdinEnded: () => stdinEnded };
  }

  function start(fixture: ReturnType<typeof pipeFixture>, opts: { autoEndAfterFirstTurn?: boolean }) {
    spawnHook.override = () => fixture.child;
    const events: AgentEvent[] = [];
    const runner = new ClaudeCliRunner({ bin: 'unused-pipe-fixture' });
    const session = runner.startSession({ userPrompt: 'opening', cwd: '/tmp', timeoutMs: 0 }, event => events.push(event), opts);
    const turnEnds = () => events.filter(event => event.type === 'turn-end').length;
    return { session, events, turnEnds };
  }

  afterEach(() => { spawnHook.override = null; });

  it('keeps stdin open through a follow-up queued before the opening result, then closes after the final result', async () => {
    const fixture = pipeFixture();
    const { session, turnEnds } = start(fixture, { autoEndAfterFirstTurn: true });
    try {
      // The follow-up lands while the opening turn is still running.
      expect(session.sendMessage([{ type: 'text', text: 'queued follow-up' }])).toBe(true);
      await sleep(75);
      fixture.result('opening turn');
      await vi.waitFor(() => expect(turnEnds()).toBe(1));
      // Well past the 250 ms window: the queued turn is still running, so
      // stdin must still be open.
      await sleep(400);
      expect(session.open).toBe(true);
      expect(fixture.stdinEnded()).toBe(false);
      await sleep(300);
      fixture.result('follow-up turn');
      await vi.waitFor(() => expect(turnEnds()).toBe(2));
      // The final result starts the normal close window.
      await vi.waitFor(() => expect(fixture.stdinEnded()).toBe(true), { timeout: 2_000 });
      expect(session.open).toBe(false);
    } finally {
      fixture.close();
      await session.result;
    }
  });

  it('closes after a single final result exactly as before', async () => {
    const fixture = pipeFixture();
    const { session, turnEnds } = start(fixture, { autoEndAfterFirstTurn: true });
    try {
      await sleep(75);
      fixture.result('only turn');
      await vi.waitFor(() => expect(turnEnds()).toBe(1));
      await vi.waitFor(() => expect(fixture.stdinEnded()).toBe(true), { timeout: 2_000 });
      expect(session.open).toBe(false);
    } finally {
      fixture.close();
      await session.result;
    }
  });

  it('leaves an interactive session open after every result', async () => {
    const fixture = pipeFixture();
    const { session, turnEnds } = start(fixture, {});
    try {
      expect(session.sendMessage([{ type: 'text', text: 'queued follow-up' }])).toBe(true);
      fixture.result('opening turn');
      await vi.waitFor(() => expect(turnEnds()).toBe(1));
      fixture.result('follow-up turn');
      await vi.waitFor(() => expect(turnEnds()).toBe(2));
      await sleep(400);
      expect(session.open).toBe(true);
      expect(fixture.stdinEnded()).toBe(false);
    } finally {
      session.end();
      fixture.close();
      await session.result;
    }
  });

  it('explicit interrupt terminates the session while a prompt turn is still pending', async () => {
    const fixture = pipeFixture();
    const { session, turnEnds } = start(fixture, { autoEndAfterFirstTurn: true });
    expect(session.sendMessage([{ type: 'text', text: 'queued follow-up' }])).toBe(true);
    fixture.result('opening turn');
    await vi.waitFor(() => expect(turnEnds()).toBe(1));
    session.interrupt();
    expect(session.open).toBe(false);
    const result = await session.result;
    expect(result.text).toContain('opening turn');
    expect(fixture.child.exitCode).toBe(143);
  });

  it('real mock binary: a follow-up written before the opening result finishes before stdin closes', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-queued-turn-'));
    const turnEnds = () => events.filter(event => event.type === 'turn-end').length;
    let openAtSecondTurnEnd: boolean | undefined;
    const session = runner.startSession(
      {
        userPrompt: 'mock:hold opening',
        cwd,
        env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: '', CEZ_TODOS_FILE: '' },
        sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58',
      },
      (event) => {
        events.push(event);
        if (event.type === 'turn-end' && turnEnds() === 2) openAtSecondTurnEnd = session.open;
      },
      { autoEndAfterFirstTurn: true },
    );
    try {
      // The mock serializes turns and holds each `mock:hold` turn ~750 ms, so
      // this follow-up is accepted long before the opening result arrives.
      expect(session.sendMessage([{ type: 'text', text: 'mock:hold follow-up' }])).toBe(true);
      await vi.waitFor(() => expect(turnEnds()).toBe(1), { timeout: 5_000 });
      await sleep(400);
      expect(session.open).toBe(true);
      await vi.waitFor(() => expect(turnEnds()).toBe(2), { timeout: 5_000 });
      expect(openAtSecondTurnEnd).toBe(true);
      const result = await session.result;
      expect(session.open).toBe(false);
      expect(result.text).toContain('parity hold');
    } finally {
      session.interrupt();
      await session.result.catch(() => undefined);
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe('agent input steering (#505)', () => {
  const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
  const waitUntil = async (cond: () => boolean) => {
    const start = Date.now();
    while (!cond()) { if (Date.now() - start > 10_000) throw new Error('waitUntil timed out'); await new Promise(r => setTimeout(r, 10)); }
  };
  const start = (opts: Parameters<ClaudeCliRunner['startSession']>[2] = {}) => {
    const events: AgentEvent[] = [];
    const session = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'mock:steer-tool', cwd: process.cwd(), sessionId: '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90', env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } },
      event => events.push(event), opts);
    return { session, events };
  };

  it('steers agent input into the running turn and reports consumption by uuid', async () => {
    const consumed: string[][] = []; const ui: UiEvent[] = [];
    const { session, events } = start({ onAgentInputConsumed: ids => consumed.push([...ids]), onUiEvent: event => ui.push(event) });
    await waitUntil(() => events.some(e => e.type === 'tool-call'));
    const ack = session.sendAgentMessage([{ type: 'text', text: 'mid-turn update' }], ['in-1']);
    expect(ack).not.toBe(false);
    await ack;
    expect(consumed).toEqual([]); // the pipe write is not consumption
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    expect(consumed).toEqual([['in-1']]);
    expect(events.filter(e => e.type === 'turn-end')).toHaveLength(1);
    expect(ui.filter(e => e.type === 'turn.started')).toHaveLength(1);
    expect(events.some(e => e.type === 'text' && e.text.includes('saw: mid-turn update'))).toBe(true);
    // One result settled both lines, so the runner is idle again.
    expect(session.sendAgentMessage([{ type: 'text', text: 'next' }], ['in-2'])).not.toBe(false);
    session.end(); await session.result;
  });

  it('keeps accepting agent input after a human follow-up merged into the turn', async () => {
    // Pre-#505 pendingPromptTurns counted 2 here and agentInputReady stayed false.
    const { session, events } = start();
    await waitUntil(() => events.some(e => e.type === 'tool-call'));
    expect(session.sendMessage([{ type: 'text', text: 'human follow-up' }])).toBe(true);
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    expect(session.sendAgentMessage([{ type: 'text', text: 'after' }], ['in-3'])).not.toBe(false);
    session.end(); await session.result;
  });

  it('passes --replay-user-messages', () => {
    expect(buildClaudeArgs({ userPrompt: 'x', cwd: '/tmp' }, {})).toContain('--replay-user-messages');
  });
});

describe('agent input written after the last model call (#505)', () => {
  const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
  it('reports a line the CLI ran as its next queued turn as consumed then', async () => {
    const events: AgentEvent[] = []; const consumed: string[][] = []; const ui: UiEvent[] = [];
    const session = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'mock:hold', cwd: process.cwd(), sessionId: '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90', env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } },
      event => events.push(event), { onAgentInputConsumed: ids => consumed.push([...ids]), onUiEvent: event => ui.push(event) });
    // The mock answers each stdin line as its own queued turn outside mock:steer-tool.
    await new Promise(resolve => setTimeout(resolve, 100));
    await session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo late line' }], ['late-1']);
    const start = Date.now();
    while (events.filter(e => e.type === 'turn-end').length < 2) { if (Date.now() - start > 10_000) throw new Error('no second turn-end'); await new Promise(r => setTimeout(r, 10)); }
    const firstEnd = events.findIndex(e => e.type === 'turn-end');
    expect(consumed).toEqual([['late-1']]);
    expect(events.slice(firstEnd).some(e => e.type === 'text' && e.text.includes('late line'))).toBe(true);
    // Each turn opens exactly once in v2, including the queued one.
    expect(ui.filter(e => e.type === 'turn.started')).toHaveLength(2);
    session.end(); await session.result;
  });
});

describe('Claude result coverage prefers the lines it names (#505 review)', () => {
  afterEach(() => { spawnHook.override = null; });
  it('does not settle a line still in the pipe when queued_turn_count is 0 but user_message_uuids names only the earlier line', async () => {
    const emitter = new EventEmitter();
    const stdout = new PassThrough(); const stdin = new PassThrough();
    const written: Array<{ uuid: string }> = []; let buffered = '';
    stdin.on('data', chunk => { buffered += String(chunk); let i; while ((i = buffered.indexOf('\n')) >= 0) { written.push(JSON.parse(buffered.slice(0, i))); buffered = buffered.slice(i + 1); } });
    const child = Object.assign(emitter, { stdin, stdout, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
      kill: () => { close(); return true; } }) as unknown as ChildProcessWithoutNullStreams;
    const close = () => { if (child.exitCode !== null) return; Object.assign(child, { exitCode: 0 }); stdout.end(); emitter.emit('exit', 0, null); emitter.emit('close', 0, null); };
    spawnHook.override = () => child;
    const events: AgentEvent[] = []; const ui: UiEvent[] = []; const consumed: string[][] = [];
    const session = new ClaudeCliRunner({ bin: 'unused-pipe-fixture' }).startSession({ userPrompt: 'opening', cwd: '/tmp', timeoutMs: 0 },
      event => events.push(event), { onUiEvent: event => ui.push(event), onAgentInputConsumed: ids => consumed.push([...ids]) });
    try {
      await vi.waitFor(() => expect(written).toHaveLength(1));
      await session.sendAgentMessage([{ type: 'text', text: 'late line' }], ['late']);
      await vi.waitFor(() => expect(written).toHaveLength(2));
      // The CLI computed this result before it read the late line: it names only the opening.
      stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', queued_turn_count: 0,
        user_message_uuids: [written[0]!.uuid], usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
      await vi.waitFor(() => expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1));
      expect(consumed).toEqual([]); // the late line is not read yet
      stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'late done', queued_turn_count: 0,
        user_message_uuids: [written[1]!.uuid], usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
      await vi.waitFor(() => expect(consumed).toEqual([['late']]));
    } finally { session.interrupt(); close(); await session.result; }
  });
});

describe('Claude failed result (#505 review)', () => {
  const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
  it('never marks a line read by an error result', async () => {
    const events: AgentEvent[] = []; const consumed: string[][] = [];
    const session = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'inspect the working tree', cwd: process.cwd(), sessionId: '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90', env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_CLAUDE_NO_REPLAY: '1' } },
      event => events.push(event), { onAgentInputConsumed: ids => consumed.push([...ids]) });
    const start = Date.now();
    while (!events.some(e => e.type === 'turn-end')) { if (Date.now() - start > 10_000) throw new Error('no turn-end'); await new Promise(r => setTimeout(r, 10)); }
    await session.sendAgentMessage([{ type: 'text', text: 'mock:auth-error guidance' }], ['in-failed']);
    while (!events.some(e => e.type === 'error') && events.filter(e => e.type === 'turn-end').length < 2) { if (Date.now() - start > 10_000) throw new Error('no second turn'); await new Promise(r => setTimeout(r, 10)); }
    await new Promise(r => setTimeout(r, 200));
    expect(consumed).toEqual([]);
    session.interrupt(); await session.result.catch(() => undefined);
  });
});

describe('Claude --replay-user-messages feature detection (#505 review)', () => {
  it('omits the flag when the installed CLI does not list it', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'cez-claude-old-'));
    const argsFile = join(dir, 'args.json');
    const bin = join(dir, 'claude-old.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--help')) { console.log('Usage: claude [options]\\\\n  --input-format <format>'); process.exit(0); }
if (process.argv.includes('--replay-user-messages')) { console.error("error: unknown option '--replay-user-messages'"); process.exit(1); }
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }));
`, { mode: 0o755 });
    try {
      const result = await new ClaudeCliRunner({ bin, timeoutMs: 10_000 }).run({ userPrompt: 'hello', cwd: dir });
      expect(result.text).toBe('ok');
      expect(JSON.parse(readFileSync(argsFile, 'utf8'))).not.toContain('--replay-user-messages');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Claude queued-turn announcement with a synchronous follow-up (#505 local review)', () => {
  const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
  it('announces a turn submitted from the turn-end callback exactly once', async () => {
    const ui: UiEvent[] = []; let ends = 0;
    let session!: ReturnType<ClaudeCliRunner['startSession']>;
    session = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'inspect the working tree', cwd: process.cwd(), sessionId: '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90', env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } },
      event => { if (event.type === 'turn-end' && ++ends === 1) session.sendMessage([{ type: 'text', text: 'mock:agent-echo nudge' }]); },
      { onUiEvent: event => ui.push(event) });
    const start = Date.now();
    while (ends < 2) { if (Date.now() - start > 10_000) throw new Error('no second turn-end'); await new Promise(r => setTimeout(r, 10)); }
    await new Promise(r => setTimeout(r, 200));
    expect(ui.filter(e => e.type === 'turn.started')).toHaveLength(ui.filter(e => e.type === 'turn.completed').length);
    session.end(); await session.result;
  });
});
