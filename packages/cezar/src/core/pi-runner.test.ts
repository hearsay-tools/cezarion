import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent, AgentSession } from './agent-runner.js';
import type { UiEvent } from './ui-events.js';
import { buildChildEnv } from './agent-env.js';
import { parseAskMarker } from './ask.js';
import { detectEnvironment } from './backend-detect.js';
import { createRunner } from './runner-factory.js';
import { buildPiArgs, PiRunner } from './pi-runner.js';
import { appendTurnText } from '../workflows/run.js';

/**
 * The `pi` runner (#387): a new AgentBackend slotted into the runner seam as
 * ONE class. These lock the three seam-level guarantees the issue asks for —
 * the factory hands back a pi runner, detection degrades gracefully when the
 * pi CLI is absent, and the documented RPC protocol emits the normalized
 * streams every backend shares.
 */

describe('createRunner returns the pi runner', () => {
  it('maps the "pi" id to a PiRunner with backend "pi"', () => {
    const runner = createRunner('pi');
    expect(runner).toBeInstanceOf(PiRunner);
    expect(runner.backend).toBe('pi');
  });
});

describe('backend-detect handles an absent pi CLI', () => {
  const saved = { bin: process.env.CEZ_PI_BIN, dry: process.env.CEZ_DRY_RUN };

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN; // real probe, not the mock short-circuit
    process.env.CEZ_PI_BIN = join(tmpdir(), 'cez-pi-does-not-exist-xyz');
  });
  afterEach(() => {
    if (saved.bin === undefined) delete process.env.CEZ_PI_BIN;
    else process.env.CEZ_PI_BIN = saved.bin;
    if (saved.dry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved.dry;
  });

  it('reports pi as unavailable with a hint, and never rejects (no boot failure)', async () => {
    const checks = await detectEnvironment();
    const pi = checks.find((c) => c.name === 'pi');
    expect(pi).toBeDefined();
    expect(pi!.available).toBe(false);
    expect(pi!.hint).toContain('pi');
  });
});

describe('a dry-run pi session emits normalized AgentEvents', () => {
  const saved = process.env.CEZ_DRY_RUN;
  let cwd: string;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1'; // swap in the shared mock CLI
    cwd = mkdtempSync(join(tmpdir(), 'cez-pi-run-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('streams text, a tool call/result and a terminal done over the mock', async () => {
    const runner = new PiRunner();
    expect(runner.backend).toBe('pi');

    const events: AgentEvent[] = [];
    const result = await runner.run(
      { userPrompt: 'investigate the login redirect bug', cwd, timeoutMs: 20_000 },
      (event) => events.push(event),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('text');
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    // Every backend's stream is terminated by exactly one `done`.
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('coalesces token-split text_delta into one v1 text so a CEZ:ASK marker still parses (#2)', async () => {
    // Repro of open-mercato/cezar#902: Pi streams one text_delta per token.
    // Emitting each as its own v1 `text` event made appendTurnText insert
    // newlines between tokens, so CEZ:ASK\n{…} failed ASK_MARKER_RE.
    const askJson = JSON.stringify({
      questions: [
        {
          header: 'Design gate',
          question: 'Ship the coalescer as shared V1TextCoalescer?',
          multiSelect: false,
          options: [
            { label: 'Reuse coalescer', description: 'Match codex/opencode' },
            { label: 'Local buffer', description: 'pendingText only in pi-runner' },
          ],
        },
      ],
    });
    const fullText = `Pick one.\n\nCEZ:ASK ${askJson}`;
    // Split so CEZ:ASK and the JSON body land in separate deltas — the exact
    // boundary that used to break marker assembly when joined with `\n`.
    const deltas = ['Pick one.\n\n', 'CEZ:ASK', ' ', askJson];
    const mockPath = join(cwd, 'mock-pi-token-split.mjs');
    writeFileSync(
      mockPath,
      `#!/usr/bin/env node
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const deltas = ${JSON.stringify(deltas)};
const full = ${JSON.stringify(fullText)};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'tok-split' } });
  } else if (command.type === 'prompt') {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } });
    for (const delta of deltas) {
      send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: {} } });
    }
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: full, partial: {} } });
    send({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
    send({ type: 'turn_end', message: {}, toolResults: [] });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
`,
      { mode: 0o755 },
    );

    const runner = new PiRunner({ bin: mockPath });
    const events: AgentEvent[] = [];
    await runner.run({ userPrompt: 'ask me', cwd, timeoutMs: 10_000 }, (event) => events.push(event));

    const textEvents = events.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text');
    // One complete block — not one event per token delta.
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]!.text).toBe(fullText);

    // Same assembly path RunManager uses at turn-end — marker must survive.
    let turnText = '';
    for (const event of textEvents) turnText = appendTurnText(turnText, event.text);
    const ask = parseAskMarker(turnText);
    expect(ask).not.toBeNull();
    expect(ask!.questions[0]!.header).toBe('Design gate');
    expect(ask!.questions[0]!.options.map((o) => o.label)).toEqual(['Reuse coalescer', 'Local buffer']);
  });

  it('emits a second assistant text block after a tool when both use contentIndex 0', async () => {
    // contentIndex restarts per Pi assistant message. V1TextCoalescer latches
    // completed keys forever, so keying only on contentIndex drops every later
    // index-0 block (post-tool prose, follow-up turns).
    const mockPath = join(cwd, 'mock-pi-reuse-content-index.mjs');
    writeFileSync(
      mockPath,
      `#!/usr/bin/env node
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const streamText = (content) => {
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } });
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: content, partial: {} } });
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content, partial: {} } });
  send({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'reuse-idx' } });
  } else if (command.type === 'prompt') {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    streamText('before tool');
    send({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } });
    send({ type: 'tool_execution_end', toolCallId: 't1', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
    streamText('after tool');
    send({ type: 'turn_end', message: {}, toolResults: [] });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
`,
      { mode: 0o755 },
    );

    const runner = new PiRunner({ bin: mockPath });
    const events: AgentEvent[] = [];
    await runner.run({ userPrompt: 'use a tool', cwd, timeoutMs: 10_000 }, (event) => events.push(event));

    const textEvents = events.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text');
    expect(textEvents.map((e) => e.text)).toEqual(['before tool', 'after tool']);
  });

  it('emits follow-up text after an interrupted contentIndex 0 block (flush without text_end)', async () => {
    // flush() latches the generated key as done. If openTextBlockKeys still
    // maps contentIndex 0 → that key, the next message reuses the dead key and
    // every delta is dropped.
    const mockPath = join(cwd, 'mock-pi-interrupted-text-block.mjs');
    writeFileSync(
      mockPath,
      `#!/usr/bin/env node
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'interrupted' } });
  } else if (command.type === 'prompt') {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial only', partial: {} } });
    // No text_end — tool boundary forces flush of the open block.
    send({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'true' } });
    send({ type: 'tool_execution_end', toolCallId: 't1', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'after interrupt', partial: {} } });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'after interrupt', partial: {} } });
    send({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
    send({ type: 'turn_end', message: {}, toolResults: [] });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
`,
      { mode: 0o755 },
    );

    const runner = new PiRunner({ bin: mockPath });
    const events: AgentEvent[] = [];
    await runner.run({ userPrompt: 'interrupt me', cwd, timeoutMs: 10_000 }, (event) => events.push(event));

    const textEvents = events.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text');
    expect(textEvents.map((e) => e.text)).toEqual(['partial only', 'after interrupt']);
  });

  it('keeps one text block when a mid-stream prompt ack arrives between text_delta events', async () => {
    // sendMessage uses streamingBehavior: 'steer' while a turn is open. A
    // prompt `response` ack must not flush/clear the in-flight block, or the
    // partial + full snapshot emit twice and appendTurnText inserts a newline.
    const full = 'hello world';
    const mockPath = join(cwd, 'mock-pi-steer-ack-mid-text.mjs');
    writeFileSync(
      mockPath,
      `#!/usr/bin/env node
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'steer-ack' } });
  } else if (command.type === 'prompt') {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello ', partial: {} } });
    // Mid-stream steer/prompt acknowledgement — must not split the block.
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'world', partial: {} } });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: ${JSON.stringify(full)}, partial: {} } });
    send({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
    send({ type: 'turn_end', message: {}, toolResults: [] });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
`,
      { mode: 0o755 },
    );

    const runner = new PiRunner({ bin: mockPath });
    const events: AgentEvent[] = [];
    await runner.run({ userPrompt: 'steer me', cwd, timeoutMs: 10_000 }, (event) => events.push(event));

    const textEvents = events.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text');
    expect(textEvents.map((e) => e.text)).toEqual([full]);
    let turnText = '';
    for (const event of textEvents) turnText = appendTurnText(turnText, event.text);
    expect(turnText).toBe(full);
  });

  it('steers an active turn, starts one fresh turn after settlement, and auto-ends', async () => {
    const mockPath = join(cwd, 'mock-pi-active-and-fresh-follow-ups.mjs');
    writeFileSync(
      mockPath,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'follow-up-states' } });
  } else if (command.type === 'prompt' && command.message === 'start') {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'working', partial: {} } });
  } else if (command.type === 'prompt' && command.message === 'during active turn') {
    writeFileSync('active-follow-up.json', JSON.stringify(command));
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_settled' });
  } else if (command.type === 'prompt') {
    writeFileSync('fresh-follow-up.json', JSON.stringify(command));
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
`,
      { mode: 0o755 },
    );

    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    let session: AgentSession | undefined;
    let activeFollowUpSent = false;
    let freshFollowUpScheduled = false;
    session = new PiRunner({ bin: mockPath }).startSession(
      { userPrompt: 'start', cwd, timeoutMs: 2_000 },
      (event) => events.push(event),
      {
        autoEndAfterFirstTurn: true,
        onUiEvent: (event) => {
          uiEvents.push(event);
          if (event.type === 'item.delta' && event.delta === 'working' && !activeFollowUpSent) {
            activeFollowUpSent = session?.sendMessage([{ type: 'text', text: 'during active turn' }]) ?? false;
          } else if (event.type === 'turn.completed' && event.turnId === 'turn_1' && !freshFollowUpScheduled) {
            freshFollowUpScheduled = true;
            setTimeout(() => session?.sendMessage([{ type: 'text', text: 'after settled turn' }]), 0);
          }
        },
      },
    );
    await session.result;

    const activeFollowUp = JSON.parse(readFileSync(join(cwd, 'active-follow-up.json'), 'utf8')) as Record<string, unknown>;
    const freshFollowUp = JSON.parse(readFileSync(join(cwd, 'fresh-follow-up.json'), 'utf8')) as Record<string, unknown>;
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(activeFollowUp).toMatchObject({ streamingBehavior: 'steer' });
    expect(freshFollowUp).not.toHaveProperty('streamingBehavior');
    expect(uiEvents.filter((event) => event.type === 'turn.started').map((event) => event.turnId)).toEqual([
      'turn_1',
      'turn_2',
    ]);
  });

  it('steers a follow-up into an autonomously resumed turn without opening another normalized turn', async () => {
    const mockPath = join(cwd, 'mock-pi-autonomous-follow-up.mjs');
    writeFileSync(
      mockPath,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
let prompts = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'autonomous-follow-up' } });
  } else if (command.type === 'prompt' && ++prompts === 1) {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_settled' });
    setTimeout(() => {
      send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } });
      send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'autonomous work', partial: {} } });
      send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'autonomous work', partial: {} } });
    }, 20);
  } else if (command.type === 'prompt') {
    writeFileSync('follow-up.json', JSON.stringify(command));
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
`,
      { mode: 0o755 },
    );

    const uiEvents: UiEvent[] = [];
    let session: AgentSession | undefined;
    let followUpSent = false;
    session = new PiRunner({ bin: mockPath }).startSession(
      { userPrompt: 'start', cwd, timeoutMs: 10_000 },
      undefined,
      {
        autoEndAfterFirstTurn: true,
        onUiEvent: (event) => {
          uiEvents.push(event);
          if (event.type !== 'item.delta' || event.delta !== 'autonomous work' || followUpSent) return;
          expect(session?.sendAgentMessage([{ type: 'text', text: 'non-human follow-up' }])).toBe(false);
          followUpSent = session?.sendMessage([{ type: 'text', text: 'user follow-up' }]) ?? false;
        },
      },
    );
    await session.result;

    const followUp = JSON.parse(readFileSync(join(cwd, 'follow-up.json'), 'utf8')) as Record<string, unknown>;
    expect(followUpSent).toBe(true);
    expect(followUp).toMatchObject({ type: 'prompt', message: 'user follow-up', streamingBehavior: 'steer' });
    expect(uiEvents.filter((event) => event.type === 'turn.started').map((event) => event.turnId)).toEqual([
      'turn_1',
      'turn_2',
    ]);
  });

  it('steers a follow-up during a late update from a tool started before settlement', async () => {
    const mockPath = join(cwd, 'mock-pi-late-tool-update.mjs');
    writeFileSync(
      mockPath,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
let prompts = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'late-tool-update' } });
  } else if (command.type === 'prompt' && ++prompts === 1) {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'tool_execution_start', toolCallId: 'late-tool', toolName: 'edit', args: { path: 'a.ts' } });
    send({ type: 'agent_settled' });
    setTimeout(() => send({
      type: 'tool_execution_update',
      toolCallId: 'late-tool',
      partialResult: { content: [{ type: 'text', text: 'still working' }] },
    }), 20);
  } else if (command.type === 'prompt') {
    writeFileSync('late-tool-follow-up.json', JSON.stringify(command));
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
`,
      { mode: 0o755 },
    );

    const uiEvents: UiEvent[] = [];
    let session: AgentSession | undefined;
    let followUpSent = false;
    session = new PiRunner({ bin: mockPath }).startSession(
      { userPrompt: 'start', cwd, timeoutMs: 10_000 },
      undefined,
      {
        autoEndAfterFirstTurn: true,
        onUiEvent: (event) => {
          uiEvents.push(event);
          if (event.type !== 'item.updated' || event.item.id !== 'late-tool' || followUpSent) return;
          followUpSent = session?.sendMessage([{ type: 'text', text: 'user follow-up' }]) ?? false;
        },
      },
    );
    await session.result;

    const followUp = JSON.parse(readFileSync(join(cwd, 'late-tool-follow-up.json'), 'utf8')) as Record<string, unknown>;
    expect(followUpSent).toBe(true);
    expect(followUp).toMatchObject({ streamingBehavior: 'steer' });
    expect(uiEvents.filter((event) => event.type === 'turn.started').map((event) => event.turnId)).toEqual([
      'turn_1',
      'turn_2',
    ]);
  });

  it.each([
    { settles: false, expectsNote: true },
    { settles: true, expectsNote: false },
  ])('reports early process exit according to mapper settlement state: $settles', async ({ settles, expectsNote }) => {
    const mockPath = join(cwd, `mock-pi-exit-${settles ? 'settled' : 'active'}.mjs`);
    writeFileSync(
      mockPath,
      `#!/usr/bin/env node
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const exitAfter = (v) => process.stdout.write(JSON.stringify(v) + '\\n', () => process.exit(0));
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'exit-state' } });
  } else if (command.type === 'prompt') {
    ${settles
      ? "send({ type: 'response', command: 'prompt', success: true });\n    exitAfter({ type: 'agent_settled' });"
      : "exitAfter({ type: 'response', command: 'prompt', success: true });"}
  }
}
`,
      { mode: 0o755 },
    );

    const events: AgentEvent[] = [];
    await new PiRunner({ bin: mockPath }).startSession(
      { userPrompt: 'start', cwd, timeoutMs: 10_000 },
      (event) => events.push(event),
    ).result;

    expect(events.some((event) => event.type === 'note' && event.message === 'pi RPC session ended before agent_settled')).toBe(expectsNote);
  });
});

function writePiRpcMock(cwd: string, name: string, afterPrompt: string): string {
  const mockPath = join(cwd, name);
  writeFileSync(
    mockPath,
    `#!/usr/bin/env node
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-err', model: { id: 'gpt-5.6-sol' } } });
  } else if (command.type === 'prompt') {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
${afterPrompt}
    send({ type: 'turn_end', message: {}, toolResults: [] });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
`,
    { mode: 0o755 },
  );
  return mockPath;
}

async function runPiMock(
  cwd: string,
  mockPath: string,
): Promise<{ events: AgentEvent[]; uiEvents: UiEvent[] }> {
  const events: AgentEvent[] = [];
  const uiEvents: UiEvent[] = [];
  await new PiRunner({ bin: mockPath }).startSession(
    { userPrompt: 'go', cwd, timeoutMs: 10_000 },
    (event) => events.push(event),
    { onUiEvent: (event) => uiEvents.push(event), autoEndAfterFirstTurn: true },
  ).result;
  return { events, uiEvents };
}

describe('pi provider failures on assistant message_end (#54)', () => {
  const saved = process.env.CEZ_DRY_RUN;
  let cwd: string;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    cwd = mkdtempSync(join(tmpdir(), 'cez-pi-err-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('emits a v1 error before turn-end for a transport diagnostic', async () => {
    const mockPath = writePiRpcMock(
      cwd,
      'mock-pi-transport-error.mjs',
      `    send({ type: 'message_end', message: {
      role: 'assistant', content: [], provider: 'openai-codex', model: 'gpt-5.6-sol',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
      stopReason: 'error', errorMessage: 'Not Found',
      diagnostics: [{ type: 'provider_transport_failure', error: { name: 'Error', message: 'WebSocket error', stack: 'Error: WebSocket error\\n    at extractWebSocketError' }, details: { requestBytes: 82921 } }],
    } });`,
    );
    const { events, uiEvents } = await runPiMock(cwd, mockPath);
    const types = events.map((e) => e.type);
    expect(types.indexOf('error')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('error')).toBeLessThan(types.indexOf('turn-end'));
    expect(events.find((e) => e.type === 'error')!.message).toBe(
      'pi: openai-codex/gpt-5.6-sol request failed: WebSocket error',
    );
    expect(events.find((e) => e.type === 'error')!.message).not.toMatch(/not found on PATH/i);
    expect(uiEvents).toContainEqual({
      type: 'session.error',
      message: 'pi: openai-codex/gpt-5.6-sol request failed: WebSocket error',
      fatal: false,
    });
    expect(uiEvents.some((e) => e.type === 'turn.completed' && e.stopReason === 'error')).toBe(true);
  });

  it('falls back to errorMessage when diagnostics are absent', async () => {
    const mockPath = writePiRpcMock(
      cwd,
      'mock-pi-error-message.mjs',
      `    send({ type: 'message_end', message: {
      role: 'assistant', content: [], provider: 'openai-codex', model: 'gpt-5.6-sol',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
      stopReason: 'error', errorMessage: 'Not Found',
    } });`,
    );
    const { events } = await runPiMock(cwd, mockPath);
    expect(events.find((e) => e.type === 'error')!.message).toBe(
      'pi: openai-codex/gpt-5.6-sol request failed: Not Found',
    );
  });

  it('does not fail a successful empty assistant turn', async () => {
    const mockPath = writePiRpcMock(
      cwd,
      'mock-pi-empty-success.mjs',
      `    send({ type: 'message_end', message: {
      role: 'assistant', content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    } });`,
    );
    const { events, uiEvents } = await runPiMock(cwd, mockPath);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
    expect(uiEvents.some((e) => e.type === 'session.error')).toBe(false);
    expect(uiEvents.filter((e) => e.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' },
    ]);
  });
});

describe('pi RPC argv', () => {
  it('uses pi RPC mode, exact session selection, provider/model, and pi tool names', () => {
    expect(
      buildPiArgs({
        cwd: '/repo',
        userPrompt: 'task',
        sessionId: 'session-1',
        resume: true,
        model: 'openai/gpt-5.1',
        systemPrompt: 'Keep changes focused.',
        allowedTools: ['Read', 'Bash', 'Edit', 'Write', 'Grep', 'Glob'],
      }),
    ).toEqual([
      '--mode',
      'rpc',
      '--session',
      'session-1',
      '--append-system-prompt',
      'Keep changes focused.',
      '--model',
      'openai/gpt-5.1',
      '--tools',
      'read,bash,edit,write,grep,find',
    ]);
  });

  it('creates a new exact session id instead of invoking the interactive resume picker', () => {
    expect(buildPiArgs({ cwd: '/repo', userPrompt: 'task', sessionId: 'session-1' })).toEqual([
      '--mode',
      'rpc',
      '--session-id',
      'session-1',
    ]);
  });

  it('fails closed by disabling bash when a command-prefix allowlist cannot be represented', () => {
    expect(
      buildPiArgs({
        cwd: '/repo',
        userPrompt: 'task',
        allowedTools: ['Read', 'Bash'],
        bashAllowlist: ['npm test'],
      }),
    ).toEqual(['--mode', 'rpc', '--tools', 'read']);
  });

  it('maps the complete subagent trio onto pi --tools so the default extras list is representable', () => {
    expect(
      buildPiArgs({
        cwd: '/repo',
        userPrompt: 'task',
        allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'Subagent', 'SubagentSupervisor', 'SubagentWait'],
      }),
    ).toEqual(['--mode', 'rpc', '--tools', 'read,edit,write,grep,find,bash,subagent,subagent_supervisor,subagent_wait']);
  });

  it('does not inject Subagent when allowedTools is an explicit subset', () => {
    expect(
      buildPiArgs({
        cwd: '/repo',
        userPrompt: 'task',
        allowedTools: ['Read', 'Bash'],
      }),
    ).toEqual(['--mode', 'rpc', '--tools', 'read,bash']);
  });

  it('maps a canonical effort pin onto --thinking and omits it when unset', () => {
    expect(
      buildPiArgs({ cwd: '/repo', userPrompt: 'task', effort: 'high' }),
    ).toEqual(['--mode', 'rpc', '--thinking', 'high']);
    expect(buildPiArgs({ cwd: '/repo', userPrompt: 'task' })).not.toContain('--thinking');
    expect(
      buildPiArgs({ cwd: '/repo', userPrompt: 'task', effort: 'auto' }),
    ).not.toContain('--thinking');
  });
});

describe('pi spawns under pi credentials, not another runner', () => {
  const source: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'ant',
    OPENAI_API_KEY: 'oai',
    OPENROUTER_API_KEY: 'orr',
    SOME_UNRELATED_SECRET: 'nope',
  };

  it('gives pi the multi-provider set a provider/model id can name', () => {
    const env = buildChildEnv({ backend: 'pi', source });
    expect(env.ANTHROPIC_API_KEY).toBe('ant');
    expect(env.OPENAI_API_KEY).toBe('oai');
    expect(env.OPENROUTER_API_KEY).toBe('orr');
  });

  it('still withholds everything outside the allowlist — pi is not a full-env escape hatch', () => {
    expect(buildChildEnv({ backend: 'pi', source }).SOME_UNRELATED_SECRET).toBeUndefined();
  });

  it('leaves claude Anthropic-only — widening pi must not widen claude', () => {
    const env = buildChildEnv({ backend: 'claude', source });
    expect(env.ANTHROPIC_API_KEY).toBe('ant');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('never inherits Claude Code’s cloud credentials — pi does not read its toggles', () => {
    // `CLAUDE_CODE_USE_BEDROCK` / `_USE_VERTEX` unlock the AWS/GCP credential families for the
    // backend that is given the `CLAUDE_` prefix to read them. pi is not Claude Code and reads
    // neither toggle, so a host that configured Claude Code for Bedrock must not thereby hand a
    // pi process its cloud keys. OpenCode — the same `provider/model` shape — is the control.
    const cloudSource: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CONFIG_DIR: '/home/u/.claude',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'asak',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/u/gcp.json',
      GOOGLE_CLOUD_PROJECT: 'proj',
    };
    for (const backend of ['pi', 'opencode'] as const) {
      const env = buildChildEnv({ backend, source: cloudSource });
      expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
      expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    }
    // …and claude still gets exactly what the toggles exist to deliver.
    expect(buildChildEnv({ backend: 'claude', source: cloudSource }).AWS_ACCESS_KEY_ID).toBe('akid');
  });

  it('keeps the seam identity pi-specific', () => {
    expect(new PiRunner().backend).toBe('pi');
  });
});


describe('Pi signal teardown (#73)', () => {
  const bin = new URL('./__fixtures__/pi/stub-sigterm.mjs', import.meta.url).pathname;
  it.each(['interrupt', 'end'] as const)('%s settles exit 143 with a note and no startup stderr', async (action) => {
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    let session: AgentSession;
    session = new PiRunner({ bin }).startSession(
      { userPrompt: 'ready', cwd: tmpdir(), timeoutMs: 20_000 },
      (event) => {
        events.push(event);
        if (event.type === 'turn-end') session[action]();
      },
      { onUiEvent: (event) => ui.push(event) },
    );
    await expect(session.result).resolves.toBeDefined();
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'note', message: expect.stringMatching(/terminated by cezar.*143/) });
    expect(JSON.stringify(events)).not.toContain('no selector found');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(ui.filter((e) => e.type === 'session.ended')).toHaveLength(1);
  }, 25_000);

  it('still rejects exit 143 when Cezar did not send the signal', async () => {
    await expect(new PiRunner({ bin }).startSession(
      { userPrompt: 'self-exit', cwd: tmpdir(), timeoutMs: 5000 },
    ).result).rejects.toThrow('pi CLI exited with code 143');
  });
});
