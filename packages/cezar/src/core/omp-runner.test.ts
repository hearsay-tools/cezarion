import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import type { AgentEvent, AgentRunSpec, AgentSession } from './agent-runner.js';
import type { UiEvent } from './ui-events.js';
import { buildOmpArgs, OMP_BUILTIN_TOOL_NAMES, OMP_SPEC_SUPPORT, OmpRunner, ompTools } from './omp-runner.js';
import { createRunner } from './runner-factory.js';
import { allowedToolsForStep, DEFAULT_ALLOWED_TOOLS } from '../workflows/types.js';

/** The OMP (Oh My Pi) runner (#595): argv, tool mapping, and the persistent RPC session. */

const base: AgentRunSpec = { cwd: '/repo', userPrompt: 'task', allowedTools: DEFAULT_ALLOWED_TOOLS };
const ciServer = { name: 'cezar', command: process.execPath, args: ['ci-wait.mjs'] };

describe('ompTools', () => {
  it('zero-config step tools map to code tools', () => {
    expect(ompTools(allowedToolsForStep(undefined, 'omp'), {}).tools).toEqual([
      'read', 'edit', 'write', 'grep', 'glob', 'bash', 'todo', 'lsp', 'ast_edit', 'task', 'wait',
    ]);
  });

  it('maps cezar names, keeps OMP built-ins and mcp__ names, drops the rest', () => {
    expect(ompTools(['Subagent', 'TodoWrite', 'WebFetch', 'lsp', 'mcp__srv_tool', 'NotebookEdit'], {})).toEqual({
      flag: 'tools',
      tools: ['task', 'todo', 'read', 'lsp', 'mcp__srv_tool'],
      dropped: ['NotebookEdit'],
    });
    expect(ompTools(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Task', 'WebSearch'], {}).tools).toEqual([
      'read', 'edit', 'write', 'bash', 'grep', 'glob', 'task', 'web_search',
    ]);
  });

  it('dedupes and never passes a name OMP would reject at startup', () => {
    const selection = ompTools(['Read', 'read', 'WebFetch', 'Lsp', 'fetch', 'goal', 'SubagentWait'], {});
    expect(selection).toEqual({ flag: 'tools', tools: ['read'], dropped: ['Lsp', 'fetch', 'goal', 'SubagentWait'] });
    for (const tool of ompTools([...OMP_BUILTIN_TOOL_NAMES, 'Glob', 'TodoWrite'], {}).tools) {
      expect(OMP_BUILTIN_TOOL_NAMES).toContain(tool);
    }
  });

  it('undefined passes no flag, [] passes --no-tools, all-dropped passes --no-tools', () => {
    expect(ompTools(undefined, {}).flag).toBeNull();
    expect(ompTools([], {}).flag).toBe('no-tools');
    expect(ompTools(['NotebookEdit'], {})).toMatchObject({ flag: 'no-tools', dropped: ['NotebookEdit'] });
  });

  it('bashAllowlist drops bash; D1 drops task, wait and eval; cezarTools appends cezar_wait_for_ci', () => {
    expect(ompTools(['Read', 'Bash'], { bashAllowlist: ['npm test'] }).tools).toEqual(['read']);
    expect(ompTools(['Read', 'Bash'], { bashAllowlist: [] }).tools).toEqual(['read', 'bash']);
    expect(ompTools(['Read', 'Subagent', 'wait', 'eval'], { restrictNativeDelegation: true }).tools).toEqual(['read']);
    expect(ompTools(['Read'], { cezarTools: true }).tools).toEqual(['read', 'cezar_wait_for_ci']);
  });

  it('fails closed when every granted tool is narrowed away, and adds no cezar tool to --no-tools', () => {
    expect(ompTools(['Bash'], { bashAllowlist: ['npm test'], cezarTools: true })).toEqual({ flag: 'no-tools', tools: [], dropped: [] });
    expect(ompTools(['Subagent'], { restrictNativeDelegation: true }).flag).toBe('no-tools');
  });

  it('D1 without allowedTools names OMP’s default set minus the delegation tools', () => {
    expect(ompTools(undefined, { restrictNativeDelegation: true })).toEqual({
      flag: 'tools',
      tools: ['read', 'bash', 'edit', 'glob', 'grep', 'todo', 'web_search', 'write'],
      dropped: [],
    });
  });
});

describe('buildOmpArgs', () => {
  it('fresh session', () => {
    expect(
      buildOmpArgs({ ...base, systemPrompt: 'S', model: 'anthropic/claude-x', effort: 'high', additionalDirectories: ['/a', '/b'] }),
    ).toEqual([
      '--mode', 'rpc',
      '--append-system-prompt', 'S',
      '--model', 'anthropic/claude-x',
      '--thinking', 'high',
      '--add-dir', '/a', '--add-dir', '/b',
      '--tools', 'read,edit,write,grep,glob,bash',
    ]);
  });

  it('resume uses --resume and never --session-id or --exclude-tools', () => {
    const resumed = buildOmpArgs({ ...base, sessionId: '0199-abc', resume: true, restrictNativeDelegation: true });
    expect(resumed.slice(0, 4)).toEqual(['--mode', 'rpc', '--resume', '0199-abc']);
    const fresh = buildOmpArgs({ ...base, sessionId: '0199-abc' });
    expect(fresh).not.toContain('--resume');
    expect(fresh).not.toContain('0199-abc');
    for (const args of [resumed, fresh]) {
      expect(args).not.toContain('--session-id');
      expect(args).not.toContain('--session');
      expect(args).not.toContain('--exclude-tools');
    }
  });

  it('D1 adds --config omp-restrict-delegation.yml', () => {
    const args = buildOmpArgs({ ...base, allowedTools: ['Read', 'Subagent'], restrictNativeDelegation: true });
    expect(args).toEqual(['--mode', 'rpc', '--config', expect.stringMatching(/scripts\/omp-restrict-delegation\.yml$/), '--tools', 'read']);
    const overlay = parseYaml(readFileSync(args[3]!, 'utf8')) as unknown;
    expect(overlay).toEqual({ tools: { approval: { task: 'deny' } } });
  });

  it('cezarTools adds --extension omp-ci-wait.mjs before other flags', () => {
    expect(buildOmpArgs({ ...base, cezarTools: ciServer, systemPrompt: 'S' })).toEqual([
      '--mode', 'rpc',
      '--extension', expect.stringMatching(/scripts\/omp-ci-wait\.mjs$/),
      '--append-system-prompt', 'S',
      '--tools', 'read,edit,write,grep,glob,bash,cezar_wait_for_ci',
    ]);
  });

  it('passes no tools flag without allowedTools, --no-tools for an empty grant, and no auto effort', () => {
    expect(buildOmpArgs({ cwd: '/repo', userPrompt: 'task', effort: 'auto' })).toEqual(['--mode', 'rpc']);
    expect(buildOmpArgs({ ...base, allowedTools: [] })).toEqual(['--mode', 'rpc', '--no-tools']);
  });
});

describe('OMP_SPEC_SUPPORT', () => {
  it('honors every field, including the extra roots Pi drops', () => {
    for (const support of Object.values(OMP_SPEC_SUPPORT)) expect(support.honored).toBe(true);
    expect(OMP_SPEC_SUPPORT.additionalDirectories).toEqual({ honored: true, via: '--add-dir per directory' });
    expect(OMP_SPEC_SUPPORT.restrictNativeDelegation).toMatchObject({ via: expect.stringContaining('eval') });
  });
});

const MOCK = fileURLToPath(new URL('../../scripts/mock-omp-rpc.mjs', import.meta.url));

describe('OmpRunner session over the mock', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cez-omp-run-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const spec = (userPrompt: string, extra: Partial<AgentRunSpec> = {}): AgentRunSpec => ({
    cwd,
    userPrompt,
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    timeoutMs: 20_000,
    ...extra,
    env: {
      CEZ_MOCK_OMP_COMMANDS_FILE: join(cwd, 'commands.ndjson'),
      CEZ_MOCK_STDIN_FILE: join(cwd, 'stdin.ndjson'),
      CEZ_MOCK_ARGS_FILE: join(cwd, 'args.ndjson'),
      ...extra.env,
    },
  });
  const lines = (name: string): Array<Record<string, unknown>> =>
    existsSync(join(cwd, name))
      ? readFileSync(join(cwd, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      : [];
  /** One session to completion, with both streams recorded. */
  async function runSession(
    runSpec: AgentRunSpec,
    drive: (event: AgentEvent, session: AgentSession) => void = () => undefined,
    bin = MOCK,
  ) {
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    let session: AgentSession;
    session = new OmpRunner({ bin }).startSession(
      runSpec,
      (event) => { events.push(event); drive(event, session); },
      { autoEndAfterFirstTurn: true, onUiEvent: (event) => ui.push(event) },
    );
    const result = await session.result;
    return { events, ui, result };
  }
  const turnEnds = (events: AgentEvent[]) => events.filter(event => event.type === 'turn-end').length;

  it('maps the "omp" id to an OmpRunner', () => {
    const runner = createRunner('omp');
    expect(runner).toBeInstanceOf(OmpRunner);
    expect(runner.backend).toBe('omp');
    expect(runner.specSupport).toBe(OMP_SPEC_SUPPORT);
    expect(runner.inputDelivery).toMatchObject({ mode: 'steer', consumption: 'observable' });
  });

  it('startup writes get_state, set_steering_mode all, set_subagent_subscription events, set_event_filter delta, then prompt', async () => {
    await runSession(spec('inspect the working tree'));
    expect(lines('commands.ndjson').slice(0, 5)).toEqual([
      { id: 'cezar-state', type: 'get_state' },
      { id: 'cezar-steering', type: 'set_steering_mode', mode: 'all' },
      { id: 'cezar-subagents', type: 'set_subagent_subscription', level: 'events' },
      { id: 'cezar-event-filter', type: 'set_event_filter', events: null, messageUpdates: 'delta' },
      { type: 'prompt', id: 'cezar-prompt-1', message: 'inspect the working tree' },
    ]);
  });

  it('streams text, tools and one turn-end for the baseline turn', async () => {
    const { events, ui, result } = await runSession(spec('inspect the working tree'));
    expect(events.filter(event => event.type !== 'token-usage' && event.type !== 'cost')).toEqual([
      { type: 'session', sessionId: '019a0000-0000-7000-8000-0000000000aa' },
      { type: 'text', text: 'Investigating: inspect the working tree' },
      { type: 'tool-call', id: 'tool-1', tool: 'read', input: { path: 'README.md' } },
      { type: 'tool-result', toolCallId: 'tool-1', result: 'mock file', isError: false },
      { type: 'turn-end' },
      { type: 'done' },
    ]);
    expect(events).toContainEqual({ type: 'token-usage', tokensUsed: 15 });
    expect(events).toContainEqual({ type: 'cost', usd: 0.001 });
    expect(result).toMatchObject({ text: 'Investigating: inspect the working tree', tokensUsed: 15, sessionId: '019a0000-0000-7000-8000-0000000000aa' });
    expect(ui[0]).toEqual({ type: 'turn.started', turnId: 'turn_1' });
    expect(ui).toContainEqual({ type: 'session.started', sessionId: '019a0000-0000-7000-8000-0000000000aa', backend: 'omp', model: 'claude-mock' });
    expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(1);
    expect(ui.at(-1)).toEqual({ type: 'session.ended', reason: 'end_turn' });
  });

  it('session_settled ends the turn; agent_end alone does not, nor an idle settle', async () => {
    const bin = join(cwd, 'mock-omp-retry.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => {
  send({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: t } });
  send({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: t } });
};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'retry' } });
  else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    text('before the retry');
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'overloaded', usage: { input: 1, output: 1 } } });
    send({ type: 'agent_end', messages: [], isTerminal: false, yielded: false });
    send({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
    await sleep(150);
    send({ type: 'auto_retry_start' });
    send({ type: 'agent_start' });
    text('after the retry');
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 1, output: 1 } } });
    send({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
    send({ type: 'prompt_result', agentInvoked: true, status: 'completed', sessionSettled: true });
    send({ type: 'session_settled' });
    // A settle with no turn open ends nothing (and never the next turn).
    send({ type: 'session_settled' });
  } else if (command.type.startsWith('set_')) send({ id: command.id, type: 'response', command: command.type, success: true });
}
`, { mode: 0o755 });
    const { events } = await runSession(spec('retry'), undefined, bin);
    const kinds = events.map(event => event.type === 'text' ? `text:${event.text}` : event.type);
    expect(turnEnds(events)).toBe(1);
    expect(kinds.indexOf('text:after the retry')).toBeLessThan(kinds.indexOf('turn-end'));
    // The failed attempt was recovered before the settle: no error surfaces (#256).
    expect(events.filter(event => event.type === 'error')).toEqual([]);
  });

  it.each(['mock:local-command', 'mock:local-result'])('agentInvoked false ends the turn without session_settled (%s)', async (prompt) => {
    const { events, ui } = await runSession(spec(prompt));
    expect(turnEnds(events)).toBe(1);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({ message: 'omp RPC session ended before session_settled' }));
  });

  it('activity after session_settled opens a new turn and ends it at the next settle', async () => {
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    let session: AgentSession;
    session = new OmpRunner({ bin: MOCK }).startSession(
      spec('mock:wake-after-settle'),
      (event) => {
        events.push(event);
        if (event.type === 'turn-end' && turnEnds(events) === 2) session.end();
      },
      { onUiEvent: (event) => ui.push(event) },
    );
    await session.result;
    expect(turnEnds(events)).toBe(2);
    expect(events).toContainEqual({ type: 'text', text: 'woke after settle' });
    expect(ui.filter(event => event.type === 'turn.started').map(event => event.type === 'turn.started' && event.turnId)).toEqual(['turn_1', 'turn_2']);
    expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(2);
  });

  it('stream end without session_settled still ends the session and releases the latched error', async () => {
    const { events, ui } = await runSession(spec('mock:no-settle'));
    expect(events).toContainEqual({ type: 'error', message: 'omp: anthropic/claude-mock request failed: Overloaded' });
    expect(events).toContainEqual({ type: 'note', message: 'omp RPC session ended before session_settled' });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(turnEnds(events)).toBe(0);
    expect(ui).toContainEqual({ type: 'session.error', message: 'omp: anthropic/claude-mock request failed: Overloaded', fatal: false });
  });

  it('a provider failure that settles is a v1 error before the turn-end', async () => {
    const { events } = await runSession(spec('mock:provider-error'));
    const error = events.findIndex(event => event.type === 'error');
    expect(events[error]).toEqual({ type: 'error', message: 'omp: anthropic/claude-mock request failed: Not Found' });
    expect(error).toBeLessThan(events.findIndex(event => event.type === 'turn-end'));
    expect(turnEnds(events)).toBe(1);
  });

  it('a prompt that fails before the agent ran is one v1 error, then the turn-end', async () => {
    const { events, ui } = await runSession(spec('mock:prompt-error'));
    expect(events.filter(event => event.type === 'error')).toEqual([
      { type: 'error', message: 'omp: anthropic/claude-missing request failed: Model not found: anthropic/claude-missing' },
    ]);
    expect(events).toContainEqual({ type: 'note', message: 'omp: prompt failed: Model not found: anthropic/claude-missing' });
    expect(turnEnds(events)).toBe(1);
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
  });

  it('the turn-opening prompt rejected before admission is a v1 error and the turn-end (R10)', async () => {
    const { events, ui } = await runSession(spec('mock:prompt-rejected'));
    expect(events.filter(event => event.type === 'error')).toEqual([
      { type: 'error', message: 'omp: prompt failed: input hook rejected the prompt' },
    ]);
    const kinds = events.map(event => event.type);
    expect(kinds.indexOf('error')).toBeLessThan(kinds.indexOf('turn-end'));
    expect(turnEnds(events)).toBe(1);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(events).not.toContainEqual(expect.objectContaining({ message: 'omp RPC session ended before session_settled' }));
    expect(ui.filter(event => event.type === 'turn.completed' || event.type === 'session.error')).toEqual([
      { type: 'session.error', message: 'omp: prompt failed: input hook rejected the prompt', fatal: false },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' },
    ]);
  });

  it.each(['mock:steer-local', 'mock:steer-local-result', 'mock:steer-failed'])(
    'a human steer OMP finishes without the agent keeps the running turn open (%s)',
    async (steer) => {
      const { events, ui } = await runSession(spec('mock:steer-tool'), (event, session) => {
        if (event.type === 'tool-call' && event.id === 'tool-steer') session.sendMessage([{ type: 'text', text: steer }]);
      });
      expect(lines('commands.ndjson').filter(command => command.type === 'prompt').at(-1)).toEqual({
        type: 'prompt', id: 'cezar-prompt-2', message: steer, streamingBehavior: 'steer',
      });
      const kinds = events.map(event => event.type === 'text' ? `text:${event.text}` : event.type);
      expect(turnEnds(events)).toBe(1);
      expect(kinds.indexOf('text:steer tool done')).toBeLessThan(kinds.indexOf('turn-end'));
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      const completed = ui.filter(event => event.type === 'turn.completed');
      expect(completed).toEqual([expect.objectContaining({ turnId: 'turn_1', stopReason: 'end_turn' })]);
      const toolDone = ui.findIndex(event => event.type === 'item.completed' && event.item.id === 'tool-steer');
      expect(toolDone).toBeGreaterThanOrEqual(0);
      expect(toolDone).toBeLessThan(ui.indexOf(completed[0]!));
    },
  );

  it('a mid-turn agent steer rejected before admission rejects only its submission', async () => {
    let acknowledged: Promise<void> | boolean | undefined;
    const consumed: string[][] = [];
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    let session: AgentSession;
    session = new OmpRunner({ bin: MOCK }).startSession(
      spec('mock:steer-tool'),
      (event) => {
        events.push(event);
        if (event.type === 'tool-call' && acknowledged === undefined) {
          acknowledged = session.sendAgentMessage([{ type: 'text', text: 'mock:steer-rejected' }], ['input-1']);
          if (acknowledged instanceof Promise) acknowledged.catch(() => undefined);
        }
      },
      { autoEndAfterFirstTurn: true, onAgentInputConsumed: (ids) => consumed.push([...ids]), onUiEvent: (event) => ui.push(event) },
    );
    await session.result;
    expect(acknowledged).toBeInstanceOf(Promise);
    await expect(acknowledged).rejects.toThrow('input hook rejected the steer');
    expect(consumed).toEqual([]);
    const kinds = events.map(event => event.type === 'text' ? `text:${event.text}` : event.type);
    expect(turnEnds(events)).toBe(1);
    expect(kinds.indexOf('text:steer tool done')).toBeLessThan(kinds.indexOf('turn-end'));
    expect(events).toContainEqual({ type: 'note', message: 'omp: prompt failed: input hook rejected the steer' });
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(ui.filter(event => event.type === 'turn.completed')).toEqual([
      expect.objectContaining({ turnId: 'turn_1', stopReason: 'end_turn' }),
    ]);
  });

  it('a mid-turn sendAgentMessage goes out as a steer and resolves on its prompt ack', async () => {
    let acknowledged: Promise<void> | boolean | undefined;
    const consumed: string[][] = [];
    const events: AgentEvent[] = [];
    let session: AgentSession;
    session = new OmpRunner({ bin: MOCK }).startSession(
      spec('mock:steer-tool'),
      (event) => {
        events.push(event);
        if (event.type === 'tool-call' && acknowledged === undefined) {
          acknowledged = session.sendAgentMessage([{ type: 'text', text: 'worker reply' }], ['input-1']);
        }
      },
      { autoEndAfterFirstTurn: true, onAgentInputConsumed: (ids) => consumed.push([...ids]) },
    );
    await session.result;
    expect(acknowledged).toBeInstanceOf(Promise);
    await expect(acknowledged).resolves.toBeUndefined();
    expect(lines('commands.ndjson').filter(command => command.type === 'prompt').at(-1)).toEqual({
      type: 'prompt', id: 'cezar-agent-1', message: 'worker reply', streamingBehavior: 'steer',
    });
    expect(consumed).toEqual([['input-1']]);
    expect(turnEnds(events)).toBe(1);
    expect(events).toContainEqual({ type: 'text', text: 'worker reply' });
  });

  it('interrupt sends abort then SIGTERM', async () => {
    const { events } = await runSession(spec('mock:steer-tool'), (event, session) => {
      if (event.type === 'tool-call') session.interrupt();
    });
    expect(lines('commands.ndjson').at(-1)).toEqual({ type: 'abort' });
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'note', message: expect.stringMatching(/terminated by cezar \(code 143\)/) });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('end closes stdin and OMP exits on its own', async () => {
    const { events } = await runSession(spec('inspect the working tree'), (event, session) => {
      if (event.type === 'turn-end') session.end();
    });
    expect(events.filter(event => event.type === 'error' || (event.type === 'note' && /terminated/.test(event.message)))).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('timeoutMs kills the session as a timeout, not a crash', async () => {
    const { events } = await runSession(spec('mock:hold', { timeoutMs: 150 }));
    expect(events.filter(event => event.type === 'error')).toEqual([{ type: 'error', message: expect.stringMatching(/^omp CLI timed out after .* and was killed$/) }]);
    expect(lines('commands.ndjson').at(-1)).toEqual({ type: 'abort' });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('unknown --tools name surfaces OMP stderr in the thrown error', async () => {
    const events: AgentEvent[] = [];
    const failed = new OmpRunner({ bin: MOCK }).run(spec('x', { allowedTools: ['Read', 'mcp__not_a_tool'] }), event => events.push(event));
    await expect(failed).rejects.toThrow('omp CLI exited with code 2 — Error: Unknown tool in --tools: mcp__not_a_tool.');
    expect(events).toContainEqual({ type: 'note', message: expect.stringContaining('omp CLI stderr:\nError: Unknown tool in --tools: mcp__not_a_tool.') });
    // A gated built-in is the same startup failure (R1).
    await expect(new OmpRunner({ bin: MOCK }).run(spec('x', { allowedTools: ['find'] })))
      .rejects.toThrow('Error: Built-in tools unavailable in this session: find.');
  });

  it('an unauthenticated omp surfaces its no-models reason, not the setup hints after it', async () => {
    const events: AgentEvent[] = [];
    const failed = new OmpRunner({ bin: MOCK }).run(spec('x', { env: { CEZ_MOCK_OMP_NO_AUTH: '1' } }), event => events.push(event));
    await expect(failed).rejects.toThrow(
      'omp CLI exited with code 1 — No models available. Use /login or set an API key environment variable. Then use /model to select a model.',
    );
    expect(events).toContainEqual({ type: 'note', message: expect.stringContaining('ANTHROPIC_API_KEY, OPENAI_API_KEY') });
  });

  it('ENOENT names omp and omp login', async () => {
    await expect(new OmpRunner({ bin: join(cwd, 'omp-does-not-exist') }).run(spec('x')))
      .rejects.toThrow(/omp-does-not-exist` not found on PATH: install OMP .* and run `omp login`/);
  });

  it('discovered session id is emitted once and reused with --resume on the next session', async () => {
    const first = await runSession(spec('inspect the working tree'));
    expect(first.events.filter(event => event.type === 'session')).toEqual([{ type: 'session', sessionId: '019a0000-0000-7000-8000-0000000000aa' }]);
    const second = await runSession(spec('continue', { sessionId: first.result.sessionId, resume: true }));
    expect(second.events.filter(event => event.type === 'session')).toEqual([]);
    expect(second.result.sessionId).toBe('019a0000-0000-7000-8000-0000000000aa');
    const [firstArgs, secondArgs] = lines('args.ndjson') as unknown as string[][];
    expect(firstArgs).not.toContain('--resume');
    expect(secondArgs).toEqual(expect.arrayContaining(['--resume', '019a0000-0000-7000-8000-0000000000aa']));
  });

  it('notes the tools with no OMP equivalent once, at start', async () => {
    const { events } = await runSession(spec('inspect the working tree', { allowedTools: ['Read', 'NotebookEdit', 'SubagentWait'] }));
    expect(events[0]).toEqual({ type: 'note', message: 'omp: dropped tools with no OMP equivalent: NotebookEdit, SubagentWait' });
    expect(events.filter(event => event.type === 'note' && event.message.startsWith('omp: dropped'))).toHaveLength(1);
    expect(lines('args.ndjson')[0]).toEqual(expect.arrayContaining(['--tools', 'read']));
  });

  it('dry-run selects the bundled mock and ends with done', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_OMP_BIN', undefined);
    const events: AgentEvent[] = [];
    await new OmpRunner().run({ cwd, userPrompt: 'investigate the login redirect bug', timeoutMs: 20_000 }, event => events.push(event));
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining(['text', 'tool-call', 'tool-result', 'turn-end']));
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});
