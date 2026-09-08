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
import {
  buildClaudeArgs,
  ClaudeCliRunner,
  EOF_KILL_GRACE_MS,
  EOF_TERM_GRACE_MS,
  KILL_GRACE_MS,
} from './claude-cli-runner.ts';
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

it('keeps non-human input out of a Claude turn already queued by a human', async () => {
  const { driveSeam, waitFor } = await import('./harness-parity.testkit.ts');
  await driveSeam('claude', 'hold', {
    whileOpen: async (session, { v1 }) => {
      expect(session.sendMessage([{ type: 'text', text: 'mock:ask' }])).toBe(true);
      await waitFor(() => v1.filter(event => event.type === 'turn-end').length === 1);
      expect(session.sendAgentMessage([{ type: 'text', text: 'must stay queued' }])).toBe(false);
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
