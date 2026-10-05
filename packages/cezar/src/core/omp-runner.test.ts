import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

// Pass-through: every test spawns the real child; a test that needs the child's own streams
// (to fail one) reads it from here.
const spawned = vi.hoisted(() => [] as ChildProcess[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawned.push(child);
      return child;
    }) as typeof actual.spawn,
  };
});

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

  // Ruling 20: OMP names an MCP tool `mcp__<server>_<tool>` (one underscore, lowercased and
  // sanitized, v18.4.11 `qjn`) and validates `--tools` by exact name, so Claude's
  // `mcp__<server>__<tool>` spelling is translated before it reaches the flag.
  it.each([
    ['mcp__github__create_issue', 'mcp__github_create_issue'],
    ['mcp__My-Server__Do Thing', 'mcp__my_server_do_thing'],
    ['mcp__github__github_search', 'mcp__github_search'],
    ['mcp__a.b__c__d', 'mcp__a_b_c_d'],
    ['mcp__srv_tool', 'mcp__srv_tool'],
    ['mcp__srv__', 'mcp__srv__'],
  ])('translates the Claude MCP spelling %s to %s', (name, expected) => {
    expect(ompTools([name], {}).tools).toEqual([expected]);
  });

  it('collapses a Claude and an OMP spelling of one MCP tool into one name', () => {
    expect(ompTools(['mcp__github__create_issue', 'mcp__github_create_issue'], {}).tools).toEqual(['mcp__github_create_issue']);
  });

  it('maps cezar names, keeps OMP built-ins and mcp__ names, drops the rest', () => {
    expect(ompTools(['Subagent', 'TodoWrite', 'WebFetch', 'lsp', 'mcp__srv_tool', 'NotebookEdit'], {})).toEqual({
      flag: 'tools',
      tools: ['task', 'todo', 'lsp', 'mcp__srv_tool'],
      dropped: ['WebFetch', 'NotebookEdit'],
    });
    expect(ompTools(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Task', 'WebSearch'], {}).tools).toEqual([
      'read', 'edit', 'write', 'bash', 'grep', 'glob', 'task', 'web_search',
    ]);
  });

  it('WebFetch alone fails closed: OMP read would widen a web grant to local files', () => {
    expect(ompTools(['WebFetch'], {})).toEqual({ flag: 'no-tools', tools: [], dropped: ['WebFetch'] });
  });

  it('a bashAllowlist with no allowedTools names the default set without bash', () => {
    const selection = ompTools(undefined, { bashAllowlist: ['git status'] });
    expect(selection.flag).toBe('tools');
    expect(selection.tools).not.toContain('bash');
    expect(selection.tools).toEqual(expect.arrayContaining(['read', 'edit', 'write', 'grep', 'glob']));
  });

  it('dedupes and never passes a name OMP would reject at startup', () => {
    const selection = ompTools(['Read', 'read', 'WebFetch', 'Lsp', 'fetch', 'goal', 'SubagentWait'], {});
    expect(selection).toEqual({ flag: 'tools', tools: ['read'], dropped: ['WebFetch', 'Lsp', 'fetch', 'goal', 'SubagentWait'] });
    for (const tool of ompTools([...OMP_BUILTIN_TOOL_NAMES, 'Glob', 'TodoWrite'], {}).tools) {
      expect(OMP_BUILTIN_TOOL_NAMES).toContain(tool);
    }
  });

  it('never maps an inherited Object.prototype name', () => {
    expect(ompTools(['constructor', 'toString', 'valueOf', 'Read'], {})).toEqual({
      flag: 'tools',
      tools: ['read'],
      dropped: ['constructor', 'toString', 'valueOf'],
    });
    expect(ompTools(['constructor'], {})).toEqual({ flag: 'no-tools', tools: [], dropped: ['constructor'] });
  });

  it('exclude only removes names, and an empty remainder is --no-tools (Ruling 13)', () => {
    expect(ompTools(['Read', 'TodoWrite', 'lsp'], { exclude: ['todo', 'lsp'] })).toMatchObject({ flag: 'tools', tools: ['read'] });
    expect(ompTools(['TodoWrite'], { exclude: ['todo'] })).toMatchObject({ flag: 'no-tools', tools: [] });
    expect(ompTools(['Read'], { exclude: ['todo'] })).toMatchObject({ flag: 'tools', tools: ['read'] });
    expect(ompTools(undefined, { exclude: ['todo'] })).toEqual({ flag: null, tools: [], dropped: [] });
  });

  it('exclude narrows before cezar_wait_for_ci is appended, so it never turns --no-tools into a CI-only list', () => {
    expect(ompTools(['TodoWrite'], { cezarTools: true, exclude: ['todo'] })).toEqual({ flag: 'no-tools', tools: [], dropped: [] });
    expect(ompTools(['Read', 'TodoWrite'], { cezarTools: true, exclude: ['todo'] }).tools).toEqual(['read', 'cezar_wait_for_ci']);
  });

  it('undefined passes no flag, [] passes --no-tools, all-dropped passes --no-tools', () => {
    expect(ompTools(undefined, {}).flag).toBeNull();
    expect(ompTools([], {}).flag).toBe('no-tools');
    expect(ompTools(['NotebookEdit'], {})).toMatchObject({ flag: 'no-tools', dropped: ['NotebookEdit'] });
  });

  it('cezarTools admits the preview tools exactly when the extension registers it (CEZ_PREVIEW=1)', () => {
    expect(ompTools(['Read'], { cezarTools: true, env: { CEZ_PREVIEW: '1' } }).tools).toEqual(['read', 'cezar_wait_for_ci', 'cezar_preview_serve', 'cezar_preview_stop']);
    expect(ompTools(['Read'], { cezarTools: true, env: { CEZ_PREVIEW: '0' } }).tools).toEqual(['read', 'cezar_wait_for_ci']);
    expect(ompTools(['Read'], { env: { CEZ_PREVIEW: '1' } }).tools).toEqual(['read']);
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
    // Ruling 14: D1 with no allowedTools names a list, so it never widens to OMP's defaults.
    expect(OMP_SPEC_SUPPORT.restrictNativeDelegation).toMatchObject({ via: expect.stringContaining('allowedTools undefined') });
    expect(OMP_SPEC_SUPPORT.restrictNativeDelegation).toMatchObject({ via: expect.stringContaining('failing closed') });
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
// Real OMP speaks first: the runner writes nothing until this frame arrives.
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] });
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

  it('a tool denied by a no-UI approval prompt fails on its card and the turn still settles', async () => {
    const { events, ui } = await runSession(spec('mock:approval-denied'));
    const denial = 'Tool "bash" requires approval but no interactive UI available.';
    const result = events.find(event => event.type === 'tool-result');
    expect(result).toMatchObject({ type: 'tool-result', toolCallId: 'tool-denied', isError: true });
    expect(result?.type === 'tool-result' && result.result).toContain(denial);
    const failed = ui.find(event => event.type === 'item.completed' && event.item.kind === 'tool' && event.item.id === 'tool-denied');
    expect(failed).toMatchObject({ item: { status: 'failed', error: expect.stringContaining(denial) } });
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(turnEnds(events)).toBe(1);
    expect(events.findIndex(event => event.type === 'turn-end')).toBeGreaterThan(events.indexOf(result!));
    expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(1);
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

  it('a prompt_result error with no turn open is still a v1 note, as in v2', async () => {
    const bin = join(cwd, 'mock-omp-idle-error.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
import readline from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
send({ type: 'ready', protocolVersion: 1 });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'idle' } });
  if (command.type !== 'prompt') return;
  send({ id: command.id, type: 'response', command: 'prompt', success: true });
  send({ type: 'agent_start' });
  send({ type: 'prompt_result', id: command.id, agentInvoked: true, status: 'completed', sessionSettled: true });
  send({ type: 'session_settled' });
  send({ type: 'prompt_result', id: 'cezar-prompt-late', agentInvoked: false, status: 'error', error: { message: 'steer lost the race' } });
});
`, { mode: 0o755 });
    const { events, ui } = await runSession(spec('idle error'), undefined, bin);
    expect(turnEnds(events)).toBe(1);
    expect(events).toContainEqual({ type: 'note', message: expect.stringContaining('steer lost the race') });
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(ui).toContainEqual(expect.objectContaining({ type: 'session.error', message: expect.stringContaining('steer lost the race') }));
  });

  it('the turn-opening prompt rejected before admission is a v1 error and the turn-end (Ruling 10)', async () => {
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

  /** A bin that exits 2 printing `text` on stderr and records each invocation's argv. */
  const refusingBin = (text: string): string => {
    const bin = join(cwd, 'refusing-omp.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(cwd, 'invocations.ndjson'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stderr.write(${JSON.stringify(text)});
process.exit(2);
`, { mode: 0o755 });
    return bin;
  };

  it('an unknown non-MCP --tools name stays fatal and surfaces OMP stderr in the thrown error', async () => {
    const events: AgentEvent[] = [];
    const bin = refusingBin('Error: Unknown tool in --tools: cezar_wait_for_ci.\nBuilt-in tools: read.\n');
    const failed = new OmpRunner({ bin }).run(spec('x', { allowedTools: ['Read'], cezarTools: { name: 'cezar', command: process.execPath, args: [] } }), event => events.push(event));
    await expect(failed).rejects.toThrow('omp CLI exited with code 2 — Error: Unknown tool in --tools: cezar_wait_for_ci.');
    expect(events).toContainEqual({ type: 'note', message: expect.stringContaining('omp CLI stderr:\nError: Unknown tool in --tools: cezar_wait_for_ci.') });
    expect(invocations()).toHaveLength(1);
  });

  // Final review #13: a stream that throws before the first frame, with the child alive, used
  // to leave the session open (a retry was still possible) while `result` rejected, so later
  // input reported acceptance into an outbox nobody drained.
  it('closes the session when stdout fails before the first frame', async () => {
    const bin = join(cwd, 'silent-omp.mjs');
    writeFileSync(bin, '#!/usr/bin/env node\nsetTimeout(() => undefined, 20_000);\n', { mode: 0o755 });
    spawned.length = 0;
    const session = new OmpRunner({ bin }).startSession(spec('x', { allowedTools: ['Read'] }), undefined, { autoEndAfterFirstTurn: false });
    const child = spawned.at(-1)!;
    child.stdout!.destroy(new Error('stdout broke'));
    await expect(session.result).rejects.toThrow('stdout broke');
    expect(session.open).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'late' }])).toBe(false);
    child.kill('SIGKILL');
  });

  it('tears the live child down when stdout fails, escalating to SIGKILL', async () => {
    const bin = join(cwd, 'stubborn-omp.mjs');
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => undefined, 20_000);\n", { mode: 0o755 });
    spawned.length = 0;
    const session = new OmpRunner({ bin, killGraceMs: 100 }).startSession(spec('x', { allowedTools: ['Read'] }), undefined, { autoEndAfterFirstTurn: false });
    const child = spawned.at(-1)!;
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    // Let the stub install its SIGTERM handler before the stream breaks.
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdout!.destroy(new Error('stdout broke'));
    await expect(session.result).rejects.toThrow('stdout broke');
    // The run is reported failed; the CLI must not keep running tools in the worktree.
    expect(await exited).toBe('SIGKILL');
  });

  describe('MCP tools OMP has not registered (Ruling 20)', () => {
    it('respawns once without the passed MCP names OMP did not know, with one v1 note', async () => {
      const { events, ui, result } = await runSession(spec('inspect the working tree', {
        allowedTools: ['Read', 'mcp__github__create_issue', 'mcp__slow_server__query'],
        env: { CEZ_MOCK_OMP_MCP_TOOLS: 'mcp__github_create_issue' },
      }));
      const argvs = lines('args.ndjson') as unknown as string[][];
      expect(argvs).toHaveLength(2);
      expect(argvs[0]?.slice(-2)).toEqual(['--tools', 'read,mcp__github_create_issue,mcp__slow_server_query']);
      expect(argvs[1]?.slice(-2)).toEqual(['--tools', 'read,mcp__github_create_issue']);
      expect(events.filter(event => event.type === 'note' && event.message.startsWith('omp: '))).toEqual([
        { type: 'note', message: 'omp: MCP tools OMP has not registered were dropped: mcp__slow_server_query' },
      ]);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(result.text).toBe('Investigating: inspect the working tree');
      expect(ui.filter(event => event.type === 'turn.started')).toHaveLength(1);
    });

    it('drops settings-disabled built-ins and unregistered MCP names reported in one exit with one respawn', async () => {
      const { events } = await runSession(spec('inspect the working tree', {
        allowedTools: ['Read', 'TodoWrite', 'mcp__slow__query'],
        env: { CEZ_MOCK_OMP_DISABLED_TOOLS: 'todo' },
      }));
      const argvs = lines('args.ndjson') as unknown as string[][];
      expect(argvs).toHaveLength(2);
      expect(argvs[1]?.slice(-2)).toEqual(['--tools', 'read']);
      expect(events.filter(event => event.type === 'note' && event.message.startsWith('omp: '))).toEqual([
        { type: 'note', message: 'omp: tools disabled by your OMP settings were dropped: todo; MCP tools OMP has not registered were dropped: mcp__slow_query' },
      ]);
      expect(events.at(-1)).toEqual({ type: 'done' });
    });

    it('never retries when an unknown name is not an MCP name it passed', async () => {
      await expect(new OmpRunner({ bin: refusingBin('Error: Unknown tools in --tools: mcp__x_y, goal.\n') })
        .run(spec('x', { allowedTools: ['Read', 'mcp__x_y'] })))
        .rejects.toThrow('Error: Unknown tools in --tools: mcp__x_y, goal.');
      expect(invocations()).toHaveLength(1);
      rmSync(join(cwd, 'invocations.ndjson'));
      await expect(new OmpRunner({ bin: refusingBin('Error: Unknown tool in --tools: mcp__other_tool.\n') })
        .run(spec('x', { allowedTools: ['Read', 'mcp__x_y'] })))
        .rejects.toThrow('Error: Unknown tool in --tools: mcp__other_tool.');
      expect(invocations()).toHaveLength(1);
    });

    it('a second refusal of a remaining MCP name is surfaced, never a third spawn', async () => {
      const events: AgentEvent[] = [];
      const failed = new OmpRunner({ bin: refusingBin('Error: Unknown tool in --tools: mcp__x_y.\n') })
        .run(spec('x', { allowedTools: ['Read', 'mcp__x_y'] }), event => events.push(event));
      // The respawn drops mcp__x_y; the fake refuses again with a name it no longer passed.
      await expect(failed).rejects.toThrow('omp CLI exited with code 2 — Error: Unknown tool in --tools: mcp__x_y.');
      expect(invocations()).toHaveLength(2);
      expect(invocations()[1]?.slice(-2)).toEqual(['--tools', 'read']);
    });
  });

  /** A bin that exits 2 with OMP's gated-tool text; `names` is one entry per invocation. */
  const gatedBin = (names: string[]): string => {
    const bin = join(cwd, 'gated-omp.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const countFile = ${JSON.stringify(join(cwd, 'invocations.ndjson'))};
appendFileSync(countFile, JSON.stringify(process.argv.slice(2)) + '\\n');
const n = readFileSync(countFile, 'utf8').split('\\n').filter(Boolean).length;
const names = ${JSON.stringify(names)};
const name = names[Math.min(n, names.length) - 1];
process.stderr.write('Error: Built-in tool unavailable in this session: ' + name + '.\\n');
process.exit(2);
`, { mode: 0o755 });
    return bin;
  };
  const invocations = (): string[][] => lines('invocations.ndjson') as unknown as string[][];

  describe('tools disabled by the user\'s OMP settings (Ruling 13)', () => {
    it.each([
      ['one tool', ['Read', 'TodoWrite'], 'todo', ['--tools', 'read,todo'], ['--tools', 'read'], 'todo'],
      ['two tools', ['Read', 'TodoWrite', 'lsp'], 'todo,lsp', ['--tools', 'read,todo,lsp'], ['--tools', 'read'], 'todo, lsp'],
      ['every tool', ['TodoWrite'], 'todo', ['--tools', 'todo'], ['--no-tools'], 'todo'],
    ])('respawns once without the names OMP refused: %s', async (_label, allowedTools, disabled, first, second, named) => {
      const { events, ui, result } = await runSession(spec('inspect the working tree', {
        allowedTools,
        env: { CEZ_MOCK_OMP_DISABLED_TOOLS: disabled },
      }));
      const argvs = lines('args.ndjson') as unknown as string[][];
      expect(argvs).toHaveLength(2);
      expect(argvs[0]?.slice(-2)).toEqual(first);
      expect(argvs[1]?.slice(-second.length)).toEqual(second);
      expect(events.filter(event => event.type === 'note' && event.message.includes('tools disabled by your OMP settings'))).toEqual([
        { type: 'note', message: `omp: tools disabled by your OMP settings were dropped: ${named}` },
      ]);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.some(event => event.type === 'note' && event.message.includes('omp CLI stderr'))).toBe(false);
      expect(turnEnds(events)).toBe(1);
      expect(events.at(-1)).toEqual({ type: 'done' });
      expect(result.text).toBe('Investigating: inspect the working tree');
      // The refused spawn leaves nothing in v2: one turn, as if the first spawn never happened.
      expect(ui.filter(event => event.type === 'turn.started')).toHaveLength(1);
      expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(1);
      expect(lines('commands.ndjson').filter(command => command.type === 'prompt')).toHaveLength(1);
    });

    it('the respawn gets only the time left on the original deadline', async () => {
      const bin = join(cwd, 'slow-refusal-omp.mjs');
      writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const countFile = ${JSON.stringify(join(cwd, 'invocations.ndjson'))};
appendFileSync(countFile, JSON.stringify(process.argv.slice(2)) + '\\n');
if (readFileSync(countFile, 'utf8').split('\\n').filter(Boolean).length === 1) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  process.stderr.write('Error: Built-in tool unavailable in this session: todo.\\n');
  process.exit(2);
}
await import(${JSON.stringify(MOCK)});
`, { mode: 0o755 });
      const started = Date.now();
      const events: AgentEvent[] = [];
      await new OmpRunner({ bin }).run(spec('mock:hold', { allowedTools: ['Read', 'TodoWrite'], timeoutMs: 700 }), event => events.push(event));
      expect(invocations()).toHaveLength(2);
      expect(events.some(event => event.type === 'error' && event.message.startsWith('omp CLI timed out'))).toBe(true);
      // One wall-clock limit for the whole run: well under the ~1100 ms a re-armed full timeout gives.
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('a second refusal is surfaced as today, never a third spawn', async () => {
      const events: AgentEvent[] = [];
      const failed = new OmpRunner({ bin: gatedBin(['todo', 'read']) })
        .run(spec('x', { allowedTools: ['Read', 'TodoWrite'] }), event => events.push(event));
      await expect(failed).rejects.toThrow('omp CLI exited with code 2 — Error: Built-in tool unavailable in this session: read.');
      expect(invocations()).toHaveLength(2);
      expect(invocations()[1]?.slice(-2)).toEqual(['--tools', 'read']);
      expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    });

    it('never retries for a name it did not pass, or when no tool list was passed', async () => {
      await expect(new OmpRunner({ bin: gatedBin(['find']) }).run(spec('x', { allowedTools: ['Read'] })))
        .rejects.toThrow('Error: Built-in tool unavailable in this session: find.');
      expect(invocations()).toHaveLength(1);
      rmSync(join(cwd, 'invocations.ndjson'));
      await expect(new OmpRunner({ bin: gatedBin(['todo']) }).run(spec('x', { allowedTools: undefined })))
        .rejects.toThrow('Error: Built-in tool unavailable in this session: todo.');
      expect(invocations()).toHaveLength(1);
    });
  });

  describe('input accepted before the first frame, across a Ruling 13 respawn', () => {
    /** The mock behind a wrapper that records each child's pid, so a test knows which child it talks to. */
    const pidBin = (): string => {
      const bin = join(cwd, 'pid-omp.mjs');
      writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(cwd, 'pids.txt'))}, process.pid + '\\n');
await import(${JSON.stringify(MOCK)});
`, { mode: 0o755 });
      return bin;
    };
    const pids = (): number[] => readFileSync(join(cwd, 'pids.txt'), 'utf8').split('\n').filter(Boolean).map(Number);
    const refused = (prompt: string, extra: Partial<AgentRunSpec> = {}): AgentRunSpec =>
      spec(prompt, { allowedTools: ['Read', 'TodoWrite'], ...extra, env: { CEZ_MOCK_OMP_DISABLED_TOOLS: 'todo', ...extra.env } });
    const prompts = () => lines('commands.ndjson').filter(command => command.type === 'prompt');

    it('a human message sent right after start survives the respawn and reaches the second child once, in order', async () => {
      const events: AgentEvent[] = [];
      const session = new OmpRunner({ bin: pidBin() }).startSession(
        refused('mock:hold'), event => events.push(event), { autoEndAfterFirstTurn: false },
      );
      // run.ts flushDeferred does exactly this, synchronously after startSession returns.
      expect(session.sendMessage([{ type: 'text', text: 'while starting' }])).toBe(true);
      expect(session.sendMessage([{ type: 'text', text: 'second one' }])).toBe(true);
      await vi.waitFor(() => expect(prompts()).toHaveLength(3));
      expect(pids()).toHaveLength(2);
      expect(prompts().map(command => [command.id, command.message, command.streamingBehavior])).toEqual([
        ['cezar-prompt-1', 'mock:hold', undefined],
        ['cezar-prompt-2', 'while starting', 'steer'],
        ['cezar-prompt-3', 'second one', 'steer'],
      ]);
      // The startup commands precede the first prompt, as for an unrefused child.
      expect(lines('commands.ndjson').slice(0, 4).map(command => command.type)).toEqual([
        'get_state', 'set_steering_mode', 'set_subagent_subscription', 'set_event_filter',
      ]);
      session.interrupt();
      await session.result.catch(() => undefined);
      expect(prompts()).toHaveLength(3);
    });

    it('keeps the opener ack pending, so an agent message offered before the first frame is refused', async () => {
      const session = new OmpRunner({ bin: pidBin() }).startSession(refused('mock:hold'), undefined, { autoEndAfterFirstTurn: false });
      expect(session.sendAgentMessage([{ type: 'text', text: 'carried' }], ['in-1'])).toBe(false);
      await vi.waitFor(() => expect(prompts()).toHaveLength(1));
      session.interrupt();
      await session.result.catch(() => undefined);
    });

    it('a human message accepted before the first frame is written only once the child speaks', async () => {
      const session = new OmpRunner({ bin: pidBin() }).startSession(
        spec('mock:hold', { allowedTools: ['Read'] }), undefined, { autoEndAfterFirstTurn: false },
      );
      expect(session.sendMessage([{ type: 'text', text: 'early' }])).toBe(true);
      await vi.waitFor(() => expect(prompts().map(command => command.message)).toEqual(['mock:hold', 'early']));
      session.interrupt();
      await session.result.catch(() => undefined);
    });

    it('pid is the live child after a respawn, and onPidChange reports it', async () => {
      const changes: number[] = [];
      const ui: UiEvent[] = [];
      const session = new OmpRunner({ bin: pidBin() }).startSession(
        refused('mock:hold'), undefined,
        { autoEndAfterFirstTurn: false, onUiEvent: event => ui.push(event), onPidChange: pid => changes.push(pid) },
      );
      const first = session.pid;
      await vi.waitFor(() => expect(ui.length).toBeGreaterThan(0));
      const [firstChild, secondChild] = pids();
      expect(pids()).toHaveLength(2);
      expect(first).toBe(firstChild);
      expect(session.pid).toBe(secondChild);
      expect(session.pid).not.toBe(first);
      expect(changes).toEqual([secondChild]);
      session.interrupt();
      await session.result.catch(() => undefined);
    });

    it('interrupt after a respawn aborts and kills the second child', async () => {
      const ui: UiEvent[] = [];
      const session = new OmpRunner({ bin: pidBin() }).startSession(
        refused('mock:hold'), undefined, { autoEndAfterFirstTurn: false, onUiEvent: event => ui.push(event) },
      );
      await vi.waitFor(() => expect(ui.length).toBeGreaterThan(0));
      const second = pids()[1]!;
      session.interrupt();
      await session.result.catch(() => undefined);
      expect(lines('commands.ndjson').at(-1)).toEqual({ type: 'abort' });
      expect(() => process.kill(second, 0)).toThrow();
      expect(session.open).toBe(false);
    });

    it('end after a respawn closes the second child and finishes the run', async () => {
      const ui: UiEvent[] = [];
      const events: AgentEvent[] = [];
      const session = new OmpRunner({ bin: pidBin() }).startSession(
        refused('mock:hold'), event => events.push(event), { autoEndAfterFirstTurn: false, onUiEvent: event => ui.push(event) },
      );
      await vi.waitFor(() => expect(ui.length).toBeGreaterThan(0));
      const second = pids()[1]!;
      session.end();
      await session.result.catch(() => undefined);
      expect(() => process.kill(second, 0)).toThrow();
      expect(session.open).toBe(false);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
    });
  });

  it('an unauthenticated omp surfaces its no-models reason, not the setup hints after it', async () => {
    const events: AgentEvent[] = [];
    const failed = new OmpRunner({ bin: MOCK }).run(spec('x', { env: { CEZ_MOCK_OMP_NO_AUTH: '1' } }), event => events.push(event));
    await expect(failed).rejects.toThrow(
      'omp CLI exited with code 1 — No models available. Use /login or set an API key environment variable. Then use /model to select a model.',
    );
    expect(events).toContainEqual({ type: 'note', message: expect.stringContaining('ANTHROPIC_API_KEY, OPENAI_API_KEY') });
  });

  it('a child killed by a signal cezar did not send fails the run', async () => {
    await expect(new OmpRunner({ bin: MOCK }).run(spec('mock:self-kill'))).rejects.toThrow(/omp CLI was killed by signal SIGKILL/);
  });

  it('end escalates to SIGKILL when omp ignores SIGTERM after stdin closes', async () => {
    const started = Date.now();
    const events: AgentEvent[] = [];
    const session = new OmpRunner({ bin: MOCK, killGraceMs: 100 }).startSession(
      spec('mock:linger'), event => events.push(event), { autoEndAfterFirstTurn: true },
    );
    await session.result;
    expect(turnEnds(events)).toBe(1);
    expect(events.some(event => event.type === 'note' && /terminated by cezar \(SIGKILL\)/.test(event.message))).toBe(true);
    // Two short grace periods plus the auto-end delay: nowhere near the mock's own 12 s backstop.
    expect(Date.now() - started).toBeLessThan(8_000);
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
