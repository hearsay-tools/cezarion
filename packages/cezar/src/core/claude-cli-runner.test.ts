import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.ts';
import { buildClaudeArgs, ClaudeCliRunner, claudeHelpFeatures } from './claude-cli-runner.ts';
import { EOF_KILL_GRACE_MS, EOF_TERM_GRACE_MS, KILL_GRACE_MS } from './runner-runtime.ts';
import type { UiEvent } from './ui-events.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';
import { TOOL_GRANT_CASES } from './tool-grant-parity-cells.testkit.ts';

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
  const spec = { userPrompt: 'do it', cwd: '/tmp', toolGrant: UNSET_TOOL_GRANT };

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

describe('buildClaudeArgs hook events (#961)', () => {
  const spec = { userPrompt: 'p', cwd: '/tmp', toolGrant: UNSET_TOOL_GRANT };

  it('passes --include-hook-events when the CLI supports it', () => {
    expect(buildClaudeArgs(spec, {}, { replayUserMessages: true, includeHookEvents: true })).toContain('--include-hook-events');
  });

  it('omits --include-hook-events for an older CLI', () => {
    expect(buildClaudeArgs(spec, {}, { replayUserMessages: true, includeHookEvents: false })).not.toContain('--include-hook-events');
    expect(buildClaudeArgs(spec, {}, { replayUserMessages: true })).not.toContain('--include-hook-events');
  });

  it('probes help once for both features', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-claude-help-'));
    try {
      const bin = join(dir, 'claude');
      const count = join(dir, 'count');
      writeFileSync(bin, `#!/bin/sh\necho x >> '${count}'\necho '  --replay-user-messages  Re-emit user messages'\n`);
      chmodSync(bin, 0o755);
      expect(claudeHelpFeatures(bin)).toEqual({ replayUserMessages: true, includeHookEvents: false });
      expect(claudeHelpFeatures(bin)).toEqual({ replayUserMessages: true, includeHookEvents: false });
      expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildClaudeArgs effort (#45)', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp', toolGrant: UNSET_TOOL_GRANT };

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
  const spec = { userPrompt: 'do it', cwd: '/tmp', toolGrant: UNSET_TOOL_GRANT };

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

describe('buildClaudeArgs governed native messaging', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp', sessionId: 'governed-session' };

  describe.each([false, true])('resume=%s', resume => {
    describe.each(['dontAsk', 'acceptEdits', 'bypass'])('permission mode=%s', mode => {
      it.each(TOOL_GRANT_CASES)('denies native delegation and peer messaging for $id without changing grants', entry => {
        const ordinary = buildClaudeArgs({ ...spec, resume, toolGrant: entry.grant('claude') }, { CEZ_CLAUDE_PERMISSION_MODE: mode });
        const restricted = buildClaudeArgs({ ...spec, resume, toolGrant: entry.grant('claude'), restrictNativeDelegation: true }, { CEZ_CLAUDE_PERMISSION_MODE: mode });
        const index = restricted.indexOf('--disallowedTools');
        expect(index).toBeGreaterThanOrEqual(0);
        expect(restricted[index + 1]).toBe('Agent,Task,Workflow,SendMessage,ListAgents');
        expect(ordinary).not.toContain('--disallowedTools');
        expect(restricted.filter((_, i) => i !== index && i !== index + 1)).toEqual(ordinary);
      });
    });
  });

  // hearsay-tools/cezarion#1994: other Claude sessions must not inject untracked text into a
  // task, at shipped defaults and under D1 alike. Outbound SendMessage stays at defaults
  // because it also follows up the session's own subagents.
  describe.each([false, true])('restrictNativeDelegation=%s', restrictNativeDelegation => {
    it.each(TOOL_GRANT_CASES)('refuses inbound cross-session messages for $id', entry => {
      const args = buildClaudeArgs({ ...spec, toolGrant: entry.grant('claude'), restrictNativeDelegation }, {});
      const index = args.indexOf('--settings');
      expect(index).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(args[index + 1]!)).toEqual({ crossSessionInbound: 'refuse' });
      expect(args.filter(arg => arg === '--settings')).toHaveLength(1);
    });
  });

  it('keeps outbound SendMessage and ListAgents available at shipped defaults', () => {
    expect(buildClaudeArgs({ ...spec, toolGrant: UNSET_TOOL_GRANT }, {})).not.toContain('--disallowedTools');
  });

  it('keeps the native messaging deny when an explicit grant names both tools', () => {
    const args = buildClaudeArgs({ ...spec, restrictNativeDelegation: true,
      toolGrant: { kind: 'explicit', tools: ['Read', 'SendMessage', 'ListAgents'] },
    }, {});
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,SendMessage,ListAgents');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Agent,Task,Workflow,SendMessage,ListAgents');
  });
});

describe('buildClaudeArgs permission mode', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp', toolGrant: UNSET_TOOL_GRANT };

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
      { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'do it', cwd: process.cwd() },
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
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({ toolGrant: UNSET_TOOL_GRANT,
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
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({ toolGrant: UNSET_TOOL_GRANT,
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

  it('settles a timeout when signal exit precedes stdout drain (#470)', async () => {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      fake.child.kill = signal => {
        Object.assign(fake.child, { killed: true, signalCode: signal });
        fake.child.emit('exit', null, signal);
        fake.child.emit('close', null, signal);
        return true;
      };
      const events: AgentEvent[] = [];
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({ toolGrant: UNSET_TOOL_GRANT,
        userPrompt: 'do it', cwd: process.cwd(),
      }, event => events.push(event));
      let settled = false;
      void session.result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(21);
      expect(settled).toBe(true);
      expect(events.some(e => e.type === 'error' && e.message.includes('timed out'))).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      spawnHook.override = null;
    }
  });

  it('keeps timeout escalation alive after stdout has drained (#470)', async () => {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({ toolGrant: UNSET_TOOL_GRANT,
        userPrompt: 'do it', cwd: process.cwd(),
      });
      let settled = false;
      void session.result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(20);
      expect(fake.child.stdout.destroyed).toBe(true);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(settled).toBe(false);
      fake.exit(137);
      await session.result;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      spawnHook.override = null;
    }
  });

  it('stops escalating once the CLI really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({ toolGrant: UNSET_TOOL_GRANT,
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
        { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'mock:auth-error', cwd, sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58' },
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
        { toolGrant: UNSET_TOOL_GRANT,
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
  // waitFor defaults to 10s and this cell awaits two of them sequentially.
  // Vitest's 5s testTimeout already cut the isolated run off at ~4s and the
  // Node 24.15.0 floor shard at 5s; 15s still cannot cover both waits plus
  // teardown if the first transition is slow (hearsay-tools/cezarion#976).
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
}, 25_000);

describe('Claude non-human stdin acknowledgement boundary', () => {
  it.each(['acknowledged', 'write error', 'closed'] as const)('%s settles only the reserved write and never a mere turn-end', async outcome => {
    vi.useFakeTimers();
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
    const session = runner.startSession({ toolGrant: UNSET_TOOL_GRANT, userPrompt: 'opening', cwd: '/tmp', timeoutMs: 0 }, event => events.push(event), { autoEndAfterFirstTurn: true });
    const resultFrame = () => stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'turn complete', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
    try {
      resultFrame();
      // bound: wait for this native turn-end before advancing the test.
      await vi.waitFor(() => expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1), { timeout: 10_000 });
      const ack = session.sendAgentMessage([{ type: 'text', text: 'reserved' }]);
      expect(ack).toBeInstanceOf(Promise);
      if (!ack) throw new Error('expected reserved write');
      let settlement: 'pending' | 'accepted' | 'rejected' = 'pending';
      const observed = ack.then(() => { settlement = 'accepted'; }, () => { settlement = 'rejected'; });
      resultFrame();
      // bound: wait for this native turn-end before advancing the test.
      await vi.waitFor(() => expect(events.filter(event => event.type === 'turn-end')).toHaveLength(2), { timeout: 10_000 });
      await vi.advanceTimersByTimeAsync(400);
      expect(settlement).toBe('pending'); expect(session.open).toBe(true);
      expect(session.sendAgentMessage([{ type: 'text', text: 'duplicate' }])).toBe(false);
      expect(writes).toBe(2);
      if (outcome === 'closed') close();
      else completeWrite?.(outcome === 'write error' ? new Error('pipe refused') : undefined);
      await observed;
      expect(settlement).toBe(outcome === 'acknowledged' ? 'accepted' : 'rejected');
      // bound: wait for the acknowledged input to allow session closure.
      if (outcome === 'acknowledged') await vi.waitFor(() => expect(session.open).toBe(false), { timeout: 10_000 });
    } finally {
      session.interrupt(); close();
      await session.result;
      spawnHook.override = null;
      vi.useRealTimers();
    }
  });
});

/**
 * #146 — a human follow-up written BEFORE the opening result must survive the
 * auto-end window. Controlled pipes use fake timers for the 250 ms window;
 * the bundled mock still runs its own clock in a real child process.
 */
describe('Claude auto-end with a prompt turn still pending (#146)', () => {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  /** A controlled child over real pipes: the test decides exactly when each
   *  `result` frame lands, and records the moment the runner closes stdin. */
  function pipeFixture() {
    vi.useFakeTimers();
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
    const session = runner.startSession({ toolGrant: UNSET_TOOL_GRANT, userPrompt: 'opening', cwd: '/tmp', timeoutMs: 0 }, event => events.push(event), opts);
    const turnEnds = () => events.filter(event => event.type === 'turn-end').length;
    return { session, events, turnEnds };
  }

  afterEach(() => { spawnHook.override = null; vi.useRealTimers(); });

  it('keeps stdin open through a follow-up queued before the opening result, then closes after the final result', async () => {
    const fixture = pipeFixture();
    const { session, turnEnds } = start(fixture, { autoEndAfterFirstTurn: true });
    try {
      // The follow-up lands while the opening turn is still running.
      expect(session.sendMessage([{ type: 'text', text: 'queued follow-up' }])).toBe(true);
      fixture.result('opening turn');
      // bound: wait for this native turn-end before sending the next input.
      await vi.waitFor(() => expect(turnEnds()).toBe(1), { timeout: 10_000 });
      // Well past the 250 ms window: the queued turn is still running, so
      // stdin must still be open.
      await vi.advanceTimersByTimeAsync(400);
      expect(session.open).toBe(true);
      expect(fixture.stdinEnded()).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      fixture.result('follow-up turn');
      // bound: wait for this native turn-end before sending the next input.
      await vi.waitFor(() => expect(turnEnds()).toBe(2), { timeout: 10_000 });
      // The final result starts the normal close window.
      // bound: wait for the runner to close the fixture's stdin after the final turn.
      await vi.waitFor(() => expect(fixture.stdinEnded()).toBe(true), { timeout: 10_000 });
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
      fixture.result('only turn');
      // bound: wait for this native turn-end before sending the next input.
      await vi.waitFor(() => expect(turnEnds()).toBe(1), { timeout: 10_000 });
      // bound: wait for the runner to close the fixture's stdin after the final turn.
      await vi.waitFor(() => expect(fixture.stdinEnded()).toBe(true), { timeout: 10_000 });
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
      // bound: wait for this native turn-end before sending the next input.
      await vi.waitFor(() => expect(turnEnds()).toBe(1), { timeout: 10_000 });
      fixture.result('follow-up turn');
      // bound: wait for this native turn-end before sending the next input.
      await vi.waitFor(() => expect(turnEnds()).toBe(2), { timeout: 10_000 });
      await vi.advanceTimersByTimeAsync(400);
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
    // bound: wait for this native turn-end before sending the next input.
    await vi.waitFor(() => expect(turnEnds()).toBe(1), { timeout: 10_000 });
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
      { toolGrant: UNSET_TOOL_GRANT,
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
      // bound: wait for this native turn-end before sending the next input.
      await vi.waitFor(() => expect(turnEnds()).toBe(1), { timeout: 10_000 });
      // bound: observe past Claude's 250 ms auto-end timer while the real mock holds its follow-up turn for 750 ms.
      await sleep(400);
      expect(session.open).toBe(true);
      // bound: wait for this native turn-end before sending the next input.
      await vi.waitFor(() => expect(turnEnds()).toBe(2), { timeout: 10_000 });
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
      { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'mock:steer-tool', cwd: process.cwd(), sessionId: '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90', env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } },
      event => events.push(event), opts);
    return { session, events };
  };

  it('holdsHumanInput is true while a human line is unsettled and false after its result (#486)', async () => {
    const { session, events } = start();
    await waitUntil(() => events.some(e => e.type === 'tool-call'));
    // The opening prompt is replayed as soon as the mock starts the turn; only
    // later human stdin lines are still unread at the tool-call.
    expect(session.sendMessage([{ type: 'text', text: 'human-unsettled-1' }])).toBe(true);
    expect(session.sendMessage([{ type: 'text', text: 'human-unsettled-2' }])).toBe(true);
    expect(session.heldHumanInputCount?.()).toBe(2);
    expect(session.holdsHumanInput()).toBe(true);
    expect(session.holdsHumanInput()).toBe((session.heldHumanInputCount?.() ?? 0) > 0);
    await waitUntil(() => events.some(e => e.type === 'turn-end'));
    expect(session.holdsHumanInput()).toBe(false);
    expect(session.heldHumanInputCount?.()).toBe(0);
    expect(session.holdsHumanInput()).toBe((session.heldHumanInputCount?.() ?? 0) > 0);
    session.end(); await session.result;
  });

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
    expect(buildClaudeArgs({ toolGrant: UNSET_TOOL_GRANT, userPrompt: 'x', cwd: '/tmp' }, {})).toContain('--replay-user-messages');
  });
});

describe('agent input written after the last model call (#505)', () => {
  const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
  it('reports a line the CLI ran as its next queued turn as consumed then', async () => {
    const events: AgentEvent[] = []; const consumed: string[][] = []; const ui: UiEvent[] = [];
    const session = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'mock:hold', cwd: process.cwd(), sessionId: '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90', env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } },
      event => events.push(event), { onAgentInputConsumed: ids => consumed.push([...ids]), onUiEvent: event => ui.push(event) });
    // The mock answers each stdin line as its own queued turn outside mock:steer-tool.
    // bound: the native turn-start marks the mock's opening turn before the late stdin line.
    await vi.waitFor(() => expect(ui.some(event => event.type === 'turn.started')).toBe(true), { timeout: 10_000 });
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

describe('Claude humanUnsettled is not cleared by queued_turn_count fallback (#486)', () => {
  afterEach(() => { spawnHook.override = null; });

  function pipeSession() {
    const emitter = new EventEmitter();
    const stdout = new PassThrough(); const stdin = new PassThrough();
    const written: Array<{ uuid: string }> = []; let buffered = '';
    stdin.on('data', chunk => { buffered += String(chunk); let i; while ((i = buffered.indexOf('\n')) >= 0) { written.push(JSON.parse(buffered.slice(0, i))); buffered = buffered.slice(i + 1); } });
    const child = Object.assign(emitter, { stdin, stdout, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
      kill: () => { close(); return true; } }) as unknown as ChildProcessWithoutNullStreams;
    const close = () => { if (child.exitCode !== null) return; Object.assign(child, { exitCode: 0 }); stdout.end(); emitter.emit('exit', 0, null); emitter.emit('close', 0, null); };
    spawnHook.override = () => child;
    const events: AgentEvent[] = [];
    const session = new ClaudeCliRunner({ bin: 'unused-pipe-fixture' }).startSession(
      { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'opening', cwd: '/tmp', timeoutMs: 0 }, event => events.push(event));
    return { session, events, stdout, written, close };
  }

  it('does not hold the opening prompt when its result has no user_message_uuids and no replay', async () => {
    const { session, events, stdout, written, close } = pipeSession();
    try {
      // bound: wait for this stdin write receipt before releasing the next turn.
      await vi.waitFor(() => expect(written).toHaveLength(1), { timeout: 10_000 });
      expect(session.holdsHumanInput()).toBe(false);
      stdout.write(JSON.stringify({
        type: 'result', subtype: 'success', result: 'done', queued_turn_count: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
      }) + '\n');
      // bound: wait for this native turn-end before advancing the test.
      await vi.waitFor(() => expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1), { timeout: 10_000 });
      expect(session.holdsHumanInput()).toBe(false);

      expect(session.sendMessage([{ type: 'text', text: 'human-mid' }])).toBe(true);
      // bound: wait for this stdin write receipt before releasing the next turn.
      await vi.waitFor(() => expect(written).toHaveLength(2), { timeout: 10_000 });
      expect(session.holdsHumanInput()).toBe(true);
      stdout.write(JSON.stringify({
        type: 'user', isReplay: true, uuid: written[1]!.uuid,
        message: { role: 'user', content: [{ type: 'text', text: 'human-mid' }] },
      }) + '\n');
      // bound: wait for the pending human-input queue to drain.
      await vi.waitFor(() => expect(session.holdsHumanInput()).toBe(false), { timeout: 10_000 });
    } finally { session.interrupt(); close(); await session.result; }
  });

  it('keeps the human hold when a result has queued_turn_count 0 but no user_message_uuids', async () => {
    const { session, events, stdout, written, close } = pipeSession();
    try {
      // bound: wait for this stdin write receipt before releasing the next turn.
      await vi.waitFor(() => expect(written).toHaveLength(1), { timeout: 10_000 });
      expect(session.sendMessage([{ type: 'text', text: 'human-mid' }])).toBe(true);
      // bound: wait for this stdin write receipt before releasing the next turn.
      await vi.waitFor(() => expect(written).toHaveLength(2), { timeout: 10_000 });
      expect(session.holdsHumanInput()).toBe(true);
      stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', queued_turn_count: 0,
        usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
      // bound: wait for this native turn-end before advancing the test.
      await vi.waitFor(() => expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1), { timeout: 10_000 });
      expect(session.holdsHumanInput()).toBe(true);
      stdout.write(JSON.stringify({ type: 'user', isReplay: true, uuid: written[1]!.uuid,
        message: { role: 'user', content: [{ type: 'text', text: 'human-mid' }] } }) + '\n');
      stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'named', queued_turn_count: 0,
        user_message_uuids: [written[0]!.uuid], usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
      // bound: wait for the pending human-input queue to drain.
      await vi.waitFor(() => expect(session.holdsHumanInput()).toBe(false), { timeout: 10_000 });
    } finally { session.interrupt(); close(); await session.result; }
  });

  it('clears the human hold immediately when user_message_uuids names the line', async () => {
    const { session, events, stdout, written, close } = pipeSession();
    try {
      // bound: wait for this stdin write receipt before releasing the next turn.
      await vi.waitFor(() => expect(written).toHaveLength(1), { timeout: 10_000 });
      expect(session.sendMessage([{ type: 'text', text: 'human-mid' }])).toBe(true);
      // bound: wait for this stdin write receipt before releasing the next turn.
      await vi.waitFor(() => expect(written).toHaveLength(2), { timeout: 10_000 });
      expect(session.holdsHumanInput()).toBe(true);
      stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', queued_turn_count: 0,
        user_message_uuids: [written[0]!.uuid, written[1]!.uuid], usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
      // bound: wait for this native turn-end before advancing the test.
      await vi.waitFor(() => expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1), { timeout: 10_000 });
      expect(session.holdsHumanInput()).toBe(false);
    } finally { session.interrupt(); close(); await session.result; }
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
    const session = new ClaudeCliRunner({ bin: 'unused-pipe-fixture' }).startSession({ toolGrant: UNSET_TOOL_GRANT, userPrompt: 'opening', cwd: '/tmp', timeoutMs: 0 },
      event => events.push(event), { onUiEvent: event => ui.push(event), onAgentInputConsumed: ids => consumed.push([...ids]) });
    try {
      // bound: wait for this stdin write receipt before releasing the next turn.
      await vi.waitFor(() => expect(written).toHaveLength(1), { timeout: 10_000 });
      await session.sendAgentMessage([{ type: 'text', text: 'late line' }], ['late']);
      // bound: wait for this stdin write receipt before releasing the next turn.
      await vi.waitFor(() => expect(written).toHaveLength(2), { timeout: 10_000 });
      // The CLI computed this result before it read the late line: it names only the opening.
      stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', queued_turn_count: 0,
        user_message_uuids: [written[0]!.uuid], usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
      // bound: wait for this native turn-end before advancing the test.
      await vi.waitFor(() => expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1), { timeout: 10_000 });
      expect(consumed).toEqual([]); // the late line is not read yet
      stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'late done', queued_turn_count: 0,
        user_message_uuids: [written[1]!.uuid], usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
      // bound: wait for the reserved input's consumption receipt.
      await vi.waitFor(() => expect(consumed).toEqual([['late']]), { timeout: 10_000 });
    } finally { session.interrupt(); close(); await session.result; }
  });
});

describe('Claude failed result (#505 review)', () => {
  const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
  it('never marks a line read by an error result', async () => {
    const events: AgentEvent[] = []; const consumed: string[][] = [];
    const session = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'inspect the working tree', cwd: process.cwd(), sessionId: '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90', env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_CLAUDE_NO_REPLAY: '1' } },
      event => events.push(event), { onAgentInputConsumed: ids => consumed.push([...ids]) });
    const start = Date.now();
    while (!events.some(e => e.type === 'turn-end')) { if (Date.now() - start > 10_000) throw new Error('no turn-end'); await new Promise(r => setTimeout(r, 10)); }
    await session.sendAgentMessage([{ type: 'text', text: 'mock:auth-error guidance' }], ['in-failed']);
    while (!events.some(e => e.type === 'error') && events.filter(e => e.type === 'turn-end').length < 2) { if (Date.now() - start > 10_000) throw new Error('no second turn'); await new Promise(r => setTimeout(r, 10)); }
    // bound: observe the real mock-claude result boundary for late replay acknowledgements or duplicate turn announcements (200 ms).
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
      const result = await new ClaudeCliRunner({ bin, timeoutMs: 10_000 }).run({ toolGrant: UNSET_TOOL_GRANT, userPrompt: 'hello', cwd: dir });
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
      { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'inspect the working tree', cwd: process.cwd(), sessionId: '0e5f1a7c-1c3e-4d2a-9b64-2f7a5c8d1e90', env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } },
      event => { if (event.type === 'turn-end' && ++ends === 1) session.sendMessage([{ type: 'text', text: 'mock:agent-echo nudge' }]); },
      { onUiEvent: event => ui.push(event) });
    const start = Date.now();
    while (ends < 2) { if (Date.now() - start > 10_000) throw new Error('no second turn-end'); await new Promise(r => setTimeout(r, 10)); }
    // bound: observe the real mock-claude result boundary for late replay acknowledgements or duplicate turn announcements (200 ms).
    await new Promise(r => setTimeout(r, 200));
    expect(ui.filter(e => e.type === 'turn.started')).toHaveLength(ui.filter(e => e.type === 'turn.completed').length);
    session.end(); await session.result;
  });
});

/**
 * hearsay-tools/cezarion#1954 — the output loop's side effects, in order. Each case scripts
 * one fake child's stdout, stderr and exit, and records the v1 events, the UI event types and
 * the session callbacks as one ordered log. These pin the order the loop refactor must keep.
 */
describe('Claude output loop side-effect order (hearsay-tools/cezarion#1954)', () => {
  afterEach(() => { spawnHook.override = null; });

  type Entry = AgentEvent | { ui: string } | { callback: 'activity' } | { callback: 'consumed'; ids: string[] } | { callback: 'ready' };

  function scripted(): {
    child: ChildProcessWithoutNullStreams;
    stdinUuids: () => string[];
    finish: (lines: readonly unknown[], exit: { code?: number | null; signal?: NodeJS.Signals | null; stderr?: string }) => void;
  } {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const written: string[] = [];
    stdin.on('data', (chunk: Buffer) => written.push(...chunk.toString('utf8').split('\n').filter(Boolean)));
    const child = Object.assign(emitter, {
      stdin, stdout, stderr,
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      killed: false, pid: undefined, kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    const finish: ReturnType<typeof scripted>['finish'] = (lines, exit) => {
      if (exit.stderr) stderr.write(exit.stderr);
      for (const line of lines) stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
      Object.assign(child, { exitCode: exit.code ?? null, signalCode: exit.signal ?? null });
      emitter.emit('exit', exit.code ?? null, exit.signal ?? null);
      stdout.end();
      stderr.end();
    };
    const stdinUuids = (): string[] => {
      const frames = written.map(line => JSON.parse(line) as { uuid: string });
      return frames.map(frame => frame.uuid);
    };
    return { child, finish, stdinUuids };
  }

  function start(fake: ReturnType<typeof scripted>) {
    spawnHook.override = () => fake.child;
    const log: Entry[] = [];
    const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession(
      { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'do it', cwd: process.cwd(), sessionId: 'order-session' },
      event => log.push(event),
      {
        onUiEvent: event => log.push({ ui: event.type }),
        onActivity: () => log.push({ callback: 'activity' }),
        onAgentInputConsumed: ids => log.push({ callback: 'consumed', ids: [...ids] }),
        onAgentInputReady: () => log.push({ callback: 'ready' }),
      },
    );
    return { session, log };
  }

  it('keeps the order of notes, frame events, usage, cost and turn end on a clean exit', async () => {
    const fake = scripted();
    const { session, log } = start(fake);
    fake.finish([
      'not json',
      { type: 'system', subtype: 'init', model: 'claude-test', session_id: 'order-session' },
      { type: 'assistant', message: { content: 5 } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } },
      ], usage: { input_tokens: 3, output_tokens: 2 } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'hello', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 },
    ], { code: 0 });
    const result = await session.result;
    expect(result).toEqual({
      text: 'hello', toolCalls: [{ id: 't1', name: 'Read', input: { path: 'a' } }], tokensUsed: 15, sessionId: 'order-session',
    });
    expect(log).toEqual([
      { type: 'note', message: 'claude: skipped unparseable stream line: not json' },
      { callback: 'activity' }, { ui: 'session.started' }, { ui: 'turn.started' },
      { callback: 'activity' },
      { type: 'note', message: 'claude: skipped malformed event (assistant): msg.message.content is not iterable' },
      { callback: 'activity' }, { ui: 'item.started' }, { ui: 'item.completed' }, { ui: 'item.started' },
      { type: 'text', text: 'hello' },
      { type: 'tool-call', id: 't1', tool: 'Read', input: { path: 'a' } },
      { callback: 'activity' }, { ui: 'item.completed' },
      { type: 'tool-result', toolCallId: 't1', result: 'ok', isError: false },
      { callback: 'activity' }, { ui: 'turn.completed' }, { ui: 'usage.updated' },
      { type: 'token-usage', tokensUsed: 15 },
      { type: 'cost', usd: 0.01 },
      { type: 'turn-end' },
      { type: 'done' },
    ]);
  });

  it('consumes a replay echo without activity and notes missing usage', async () => {
    const fake = scripted();
    const { session, log } = start(fake);
    await session.sendAgentMessage([{ type: 'text', text: 'wake' }], ['wake-1']);
    const [seed, wake] = fake.stdinUuids();
    fake.finish([
      { type: 'user', isReplay: true, uuid: wake, message: { content: [{ type: 'text', text: 'wake' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'done', user_message_uuids: [seed, wake] },
    ], { code: 0 });
    await session.result;
    expect(log).toEqual([
      { callback: 'consumed', ids: ['wake-1'] },
      { callback: 'activity' }, { ui: 'item.started' }, { ui: 'item.completed' }, { ui: 'turn.completed' },
      { type: 'text', text: 'done' },
      { type: 'turn-end' },
      { type: 'note', message: 'token usage not reported by claude CLI' },
      { type: 'done' },
    ]);
  });

  it('reports stderr before the exit error on a non-zero exit', async () => {
    const fake = scripted();
    const { session, log } = start(fake);
    fake.finish([], { code: 1, stderr: 'Error: bad credentials\n' });
    await expect(session.result).rejects.toThrow('claude CLI exited with code 1');
    expect(log).toEqual([
      { type: 'note', message: 'claude CLI stderr:\nError: bad credentials\n' },
      { type: 'error', message: 'claude CLI exited with code 1 — Error: bad credentials' },
    ]);
  });

  it('fails an outside signal with its own error', async () => {
    const fake = scripted();
    const { session, log } = start(fake);
    fake.finish([], { signal: 'SIGKILL' });
    await expect(session.result).rejects.toThrow('claude CLI was killed by signal SIGKILL');
    expect(log).toEqual([{ type: 'error', message: 'claude CLI was killed by signal SIGKILL' }]);
  });

  it('rejects with the wrapped spawn error and emits nothing after it', async () => {
    const fake = scripted();
    const { session, log } = start(fake);
    fake.child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    fake.finish([], { code: -2 });
    await expect(session.result).rejects.toThrow('`claude` not found on PATH');
    expect(log).toEqual([]);
  });
});
