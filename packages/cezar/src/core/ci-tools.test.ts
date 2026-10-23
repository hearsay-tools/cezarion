import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { driveSeam, seedOpencodeMockSession } from './harness-parity.testkit.ts';
import { buildChildEnv } from './agent-env.ts';
import { buildClaudeArgs } from './claude-cli-runner.ts';
import { buildPiArgs } from './pi-runner.ts';
import { ciOpenCodeEnv } from '../ci-wait/injection.ts';
import { allowedToolsForStep } from '../workflows/types.ts';
import { askAnswerHint, askToolDefinition, cancelWaitToolDefinition, cezarServerInstructions, cezarTools, waitToolDefinition } from '../ci-wait/tools.ts';

const descriptor = { name: 'cezar_ci_test', command: process.execPath, args: ['/installed/dist/ci-wait/mcp.js'] };
const spec = { cwd: '/tmp', userPrompt: 'task', cezarTools: descriptor };

// hearsay-tools/cezarion#1233: one wait tool and one cancel tool reach every runner through
// the shared list; the deprecated `cezar_wait_for_ci` alias was removed in phase 4b (hearsay-tools/cezarion#1236).
describe('wait tool definitions', () => {
  it('advertises cezar_wait as one flat object schema', () => {
    const schema = waitToolDefinition.inputSchema;
    expect(schema.type).toBe('object');
    // The Anthropic tool API refuses a top-level union; the kinds validate on the server.
    for (const key of ['oneOf', 'anyOf', 'allOf']) expect(schema).not.toHaveProperty(key);
    expect(schema.properties).toMatchObject({ kind: { enum: ['ci', 'worker', 'timer', 'process'] } });
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['exit_file', 'kind', 'mode', 'note', 'pid', 'pr', 'request_ids', 'seconds', 'timeout_seconds', 'worker_ids']);
    // hearsay-tools/cezarion#1234: the user is asked with cezar_ask, so no field here is one kind's card.
    expect(JSON.stringify(schema)).not.toContain('human');
    expect(waitToolDefinition.description).toContain('To wait for the user, call cezar_ask.');
    expect(schema).toMatchObject({ required: ['kind'], additionalProperties: false });
    expect(schema.properties).toMatchObject({ seconds: { minimum: 60, maximum: 7200 }, timeout_seconds: { minimum: 1, maximum: 7200, default: 1800 }, note: { maxLength: 512 } });
    expect(JSON.stringify(schema)).not.toMatch(/"(?:oneOf|anyOf|allOf)"/);
    expect(cancelWaitToolDefinition.inputSchema).toMatchObject({ type: 'object', required: ['wait_id'], additionalProperties: false });
    expect(Object.keys(cancelWaitToolDefinition.inputSchema.properties ?? {})).toEqual(['wait_id']);
  });

  // hearsay-tools/cezarion#1234: the user's answer has its own tool, and its card is required.
  it('advertises cezar_ask with a required card, whose questions take options only when they offer choices', () => {
    const schema = askToolDefinition.inputSchema;
    expect(schema).toMatchObject({ type: 'object', required: ['context', 'questions'], additionalProperties: false });
    expect(Object.keys(schema.properties ?? {})).toEqual(['context', 'questions']);
    expect(schema.properties).toMatchObject({ context: { type: 'string', minLength: 1, maxLength: 20000 } });
    expect(schema.properties).toMatchObject({ questions: { type: 'array', minItems: 1, maxItems: 4, items: { required: ['header', 'question'], properties: { header: { maxLength: 12 }, options: { minItems: 2, maxItems: 4 } } } } });
    expect(JSON.stringify(schema)).not.toMatch(/"(?:oneOf|anyOf|allOf)"/);
    expect(askToolDefinition.description).toContain('leave the options out to let the user type the answer');
    // hearsay-tools/cezarion#1458: the content goes in context, the tested text (research 77dfb5c4).
    expect(askToolDefinition.description).toMatch(/^Ask the user for a decision or missing input\. Put the full draft, findings, evidence and option meanings needed for the decision in context\. Cezar renders context as Markdown above the question card\. The user cannot see your reasoning or rejected tool calls\. The question is a short choice, not the place for supporting detail\. /);
    expect(askToolDefinition.description).toMatch(/Then end your turn; the user's answer wakes you\.$/);
    expect(askToolDefinition.description).not.toContain('assistant text');
    expect(askToolDefinition.description).toContain('a header of at most 12 characters, a short question of at most 400 characters');
    expect(cezarServerInstructions()).toContain('- cezar_ask: load for a user decision or missing input; provide the full draft or findings in its rendered context field.');
  });

  // hearsay-tools/cezarion#1428: a rejected card's arguments never reach the user, so the retry
  // hint says where the detail that no longer fits goes.
  it('tells a rejected cezar_ask to put the detail it cuts in context before it retries', () => {
    expect(askAnswerHint({ ok: false, code: 'invalid_request', message: 'too long' })).toBe('Not asked. The user never sees a rejected call. Fix the call from the message: put the detail in context and keep each question short.');
    expect(askAnswerHint({ ok: false, code: 'autonomous_run', message: 'continue', open_waits: [] })).toBe('Not asked. Fix the call from the message, or continue without asking.');
    expect(askAnswerHint({ ok: true, wait_id: 'w', open_waits: [] })).toBe('Asked. Cezar shows the context and question card to the user. End your turn; the user\'s answer wakes you.');
  });

  it('lists no cezar_wait_for_ci: no tool, no trigger line, no admission (hearsay-tools/cezarion#1236)', () => {
    for (const env of [{}, { CEZ_PREVIEW: '1' }]) {
      expect(cezarTools(env).map(tool => tool.definition.name).slice(0, 4)).toEqual(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done']);
      expect(cezarTools(env).map(tool => tool.definition.name)).not.toContain('cezar_wait_for_ci');
      const instructions = cezarServerInstructions(env);
      expect(instructions).not.toContain('- cezar_wait_for_ci:');
      expect(instructions).toContain('- cezar_wait: load when you are waiting on CI for a PR or on a background job you started, or want to re-check something later; end your turn after it answers.');
      expect(instructions).toContain('- cezar_ask: load for a user decision or missing input; provide the full draft or findings in its rendered context field.');
      expect(instructions).toContain('- cezar_cancel_wait: load when a wait you registered is no longer needed.');
    }
    const claude = buildClaudeArgs({ ...spec, allowedTools: ['Read'] });
    expect(claude[claude.indexOf('--allowedTools') + 1]!.split(',')).not.toContain('mcp__cezar_ci_test__cezar_wait_for_ci');
    const pi = buildPiArgs({ ...spec, allowedTools: ['Read'] });
    expect(pi[pi.indexOf('--tools') + 1]!.split(',')).not.toContain('cezar_wait_for_ci');
    // hearsay-tools/cezarion#1305: the default list sends no allowlist, so the CI extension's tools stay active.
    const piDefault = buildPiArgs({ ...spec, allowedTools: allowedToolsForStep(undefined, 'pi') });
    expect(piDefault).not.toContain('--tools');
    expect(piDefault.some(arg => arg.endsWith('/pi-ci-wait.mjs'))).toBe(true);
  });
});

describe('CI tool injection', () => {
  it('never inherits another session authority, including full-env mode', () => {
    for (const backend of RUNNER_IDS) for (const full of ['0', '1']) {
      const source = { CEZ_TOOL_TOKEN: 'parent', CEZ_TOOL_SOCKET: 'parent.sock', CEZ_AGENT_ENV_FULL: full };
      const clean = buildChildEnv({ backend, source });
      expect(clean.CEZ_TOOL_TOKEN).toBeUndefined();
      expect(clean.CEZ_TOOL_SOCKET).toBeUndefined();
      expect(buildChildEnv({ backend, source, extraEnv: { CEZ_TOOL_TOKEN: 'child' } }).CEZ_TOOL_TOKEN).toBe('child');
    }
  });
  it('Claude admits only the generated tool and preserves user settings', () => {
    const args = buildClaudeArgs({ ...spec, allowedTools: ['Read'] });
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: { [descriptor.name]: { command: descriptor.command, args: descriptor.args, env: { CEZ_TOOL_TOKEN: '${CEZ_TOOL_TOKEN}', CEZ_TOOL_SOCKET: '${CEZ_TOOL_SOCKET}' } } } });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,mcp__cezar_ci_test__cezar_wait,mcp__cezar_ci_test__cezar_ask,mcp__cezar_ci_test__cezar_cancel_wait,mcp__cezar_ci_test__cezar_done');
    expect(args).not.toContain('--strict-mcp-config');
  });
  it('Pi preserves discovered extensions, retry and project-skills extensions and selected tools', () => {
    const args = buildPiArgs({ ...spec, allowedTools: ['Read'] });
    expect(args.filter(value => value === '--extension')).toHaveLength(3);
    expect(args).not.toContain('--no-extensions');
    expect(args[args.indexOf('--tools') + 1]).toBe('read,cezar_wait,cezar_ask,cezar_cancel_wait,cezar_done');
  });
  it('Pi keeps the CI extension tools active on the default list by sending no allowlist (hearsay-tools/cezarion#1305)', () => {
    const args = buildPiArgs({ ...spec, allowedTools: allowedToolsForStep(undefined, 'pi') });
    expect(args.filter(value => value === '--extension')).toHaveLength(4);
    expect(args).not.toContain('--no-extensions');
    expect(args).not.toContain('--tools');
    expect(args).toContain('--no-builtin-tools');
    // pi activates an extension's tools on registration; naming them again is not needed.
    expect(args[args.indexOf('--cezar-builtin-tools') + 1]!.split(',').filter(name => name.startsWith('cezar_'))).toEqual([]);
  });
  it('Pi admits only the cezar tools when an empty list carries them (hearsay-tools/cezarion#1305)', () => {
    const args = buildPiArgs({ ...spec, allowedTools: [] });
    expect(args).not.toContain('--no-tools');
    expect(args[args.indexOf('--tools') + 1]).toBe('cezar_wait,cezar_ask,cezar_cancel_wait,cezar_done');
  });
  it('OpenCode merges runtime config without overwriting servers or permissions', () => {
    const supplied = { mcp: { existing: { type: 'remote', url: 'https://example.org/mcp' } }, permission: { '*': 'deny' } };
    const env = ciOpenCodeEnv({ ...spec, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(supplied) } });
    const merged = JSON.parse(env!.OPENCODE_CONFIG_CONTENT!);
    expect(merged.permission).toEqual(supplied.permission);
    expect(merged.mcp.existing).toEqual(supplied.mcp.existing);
    expect(merged.mcp[descriptor.name]).toEqual({ type: 'local', command: [descriptor.command, ...descriptor.args], enabled: true });
    expect(() => ciOpenCodeEnv({ ...spec, env: { OPENCODE_CONFIG_CONTENT: '{broken' } })).toThrow(/configuration/i);
  });
  it('preserves valid OpenCode JSONC runtime settings with comments and trailing commas', () => {
    const env = ciOpenCodeEnv({ ...spec, env: { OPENCODE_CONFIG_CONTENT: `{
      // Existing team policy
      "permission": {"*": "deny",},
      "mcp": {"existing": {"type": "remote", "url": "https://example.org/mcp",},},
    }` } });
    const merged = JSON.parse(env!.OPENCODE_CONFIG_CONTENT!);
    expect(merged.permission).toEqual({ '*': 'deny' });
    expect(merged.mcp.existing).toEqual({ type: 'remote', url: 'https://example.org/mcp' });
    expect(merged.mcp[descriptor.name].command).toEqual([descriptor.command, ...descriptor.args]);
  });
  for (const backend of RUNNER_IDS) for (const resume of [false, true]) {
    it(`${backend} exposes CI on ${resume ? 'resume' : 'fresh'} wire with delegation controls preserved`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cez-ci-wire-'));
      try {
        const file = join(dir, 'wire');
        if (backend === 'opencode' && resume) seedOpencodeMockSession(file);
        const obs = await driveSeam(backend, 'baseline', { spec: { cezarTools: descriptor, resume, restrictNativeDelegation: true, env: { CEZ_MOCK_ARGS_FILE: file, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
        expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
        const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        if (backend === 'claude') expect(rows[0]).toContain('--mcp-config');
        if (backend === 'pi') expect(rows[0].filter((item: string) => item === '--extension')).toHaveLength(3);
        if (backend === 'omp') expect(rows[0].filter((item: string) => item === '--extension')).toHaveLength(1);
        if (backend === 'codex') {
          const config = rows.find(row => row.method === (resume ? 'thread/resume' : 'thread/start')).params.config;
          expect(config['features.multi_agent']).toBe(false);
          // hearsay-tools/cezarion#1294: Codex asks before every MCP tool call unless the
          // server's mode is `approve`; approval_policy stays the user's (#381).
          expect(config[`mcp_servers.${descriptor.name}`]).toEqual({ command: descriptor.command, args: descriptor.args, env_vars: ['CEZ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET'], default_tools_approval_mode: 'approve' });
          expect(config).not.toHaveProperty('approval_policy');
        }
        if (backend === 'cursor') {
          const args: string[] = rows[0];
          expect(args).toContain('--plugin-dir');
          expect(args.includes('--resume')).toBe(resume);
          expect(args).toContain('--allowed-tools');
          const plugin = rows.find(row => row.type === 'cursor-print-plugin');
          expect(plugin.mcpServers[descriptor.name]).toEqual({ type: 'stdio', command: descriptor.command,
            args: descriptor.args, env: {} });
        }
        if (backend === 'opencode') expect(rows.find(row => row.type === 'runtime-config').config.mcp[descriptor.name].command).toEqual([descriptor.command, ...descriptor.args]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 20_000);
  }
});

// H1: every offline wire must actually discover AND call the shipped adapter,
// including resumed sessions. A recorded descriptor alone is insufficient.
describe('CI H1 executable harness parity', () => {
  for (const backend of RUNNER_IDS) for (const resume of [false, true]) for (const valid of [true, false]) {
    it(`${backend} ${valid ? 'registers valid' : 'rejects invalid'} CI calls on ${resume ? 'resume' : 'fresh'}`, async () => {
      const { CiToolController } = await import('../ci-wait/controller.ts');
      const controller = await CiToolController.start();
      const dir = mkdtempSync(join(tmpdir(), 'cez-ci-call-'));
      let registrations = 0;
      const wait = { id: '11111111-1111-4111-8111-111111111111', generation: 'gen', turnId: 'turn', timeoutSeconds: 1800, prUrl: 'https://github.com/owner/repo/pull/1', repository: 'owner/repo', prNumber: 1, headSha: 'a'.repeat(40), registeredAt: '2026-09-22T00:00:00.000Z', deadline: '2026-09-22T00:30:00.000Z', phase: 'registered' as const };
      const session = controller.provision({
        registerWait: async () => { registrations++; return { answer: { ok: true, wait_id: wait.id, kind: 'ci', deadline: wait.deadline, open_waits: [] }, wait: { ...wait, kind: 'ci', source: 'agent', via: 'cezar_wait', phase: 'open' } }; },
        cancelWait: async () => ({ cancelled: false, code: 'not_found', message: 'none' }),
        ask: async () => { throw new Error('not an ask test'); },
        finishTurn: async () => ({ ok: true, finishes: 'at_turn_end', open_waits: [] }),
      });
      try {
        const resultFile = join(dir, 'result');
        const file = join(dir, 'wire');
        if (backend === 'opencode' && resume) seedOpencodeMockSession(file);
        const obs = await driveSeam(backend, 'baseline', { spec: { cezarTools: session.descriptor, resume, userPrompt: `mock:ci-wait ${valid ? wait.prUrl : 'https://github.com/owner/repo/issues/1'}`, env: { ...session.env, CEZ_MOCK_ARGS_FILE: file, CEZ_MOCK_CI_RESULT: resultFile, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
        expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
        expect(registrations).toBe(valid ? 1 : 0);
        const result = JSON.parse(readFileSync(resultFile, 'utf8'));
        expect(result.names).toEqual(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done']);
        if (valid) {
          expect(result.response.isError).not.toBe(true);
          expect(JSON.stringify(result.response)).toContain(wait.id);
        } else {
          expect(result.response.isError).toBe(true);
          expect(JSON.stringify(result.response)).toContain('invalid_request');
        }
        expect(JSON.stringify(result)).not.toContain(session.env.CEZ_TOOL_TOKEN);
        expect(readFileSync(join(dir, 'wire'), 'utf8')).not.toContain(session.env.CEZ_TOOL_TOKEN);
        expect(readFileSync(join(dir, 'wire'), 'utf8')).not.toContain(session.env.CEZ_TOOL_SOCKET);
      } finally { await controller.close(); rmSync(dir, { recursive: true, force: true }); }
    }, 20000);
  }
});

// U0 (hearsay-tools/cezarion#1233): `cezar_wait` and `cezar_cancel_wait` are admitted on each
// runner's own tool list and reach this session's handlers through its native wire, fresh and
// resumed, through the real bundled adapter (or the Pi/OMP extension).
describe('U0 wait tools on every native wire', () => {
  const wait = { id: '11111111-1111-4111-8111-111111111111', kind: 'ci' as const, source: 'agent' as const, via: 'cezar_wait' as const, generation: 'gen', turnId: 'turn', timeoutSeconds: 1800, prUrl: 'https://github.com/owner/repo/pull/1', repository: 'owner/repo', prNumber: 1, headSha: 'a'.repeat(40), registeredAt: '2026-09-22T00:00:00.000Z', deadline: '2026-09-22T00:30:00.000Z', phase: 'open' as const };
  const openWaits = [{ wait_id: wait.id, kind: 'ci' as const, deadline: wait.deadline, summary: 'CI for owner/repo#1' }];
  const call = (name: string, args: unknown) => `mock:cezar-tool ${name} ${Buffer.from(JSON.stringify(args)).toString('base64url')}`;
  const context = '## Findings\n\n- the parser drops comments';
  const questions = [{ header: 'Area', question: 'Which area should I start with?', multiSelect: false, options: [{ label: 'Parser' }, { label: 'Lexer' }] }];
  const humanId = '22222222-2222-4222-8222-222222222222';
  const humanOpen = [{ wait_id: humanId, kind: 'human' as const, summary: 'human: Which area should I start with?' }];
  const cases = [
    { tool: 'cezar_wait', args: { kind: 'ci', pr: wait.prUrl }, resume: false },
    { tool: 'cezar_wait', args: { kind: 'ci', pr: wait.prUrl }, resume: true },
    { tool: 'cezar_cancel_wait', args: { wait_id: wait.id }, resume: false },
    // hearsay-tools/cezarion#1234: the user is asked through cezar_ask, with its card.
    { tool: 'cezar_ask', args: { context, questions }, resume: false },
    { tool: 'cezar_ask', args: { context, questions }, resume: true },
    // hearsay-tools/cezarion#1234: cezar_done reaches the session's finishTurn.
    { tool: 'cezar_done', args: {}, resume: false },
    { tool: 'cezar_done', args: {}, resume: true },
  ];
  // hearsay-tools/cezarion#1305: pi admits the cezar tools by name on a narrowed list, through no
  // allowlist on the default list, and as the only names on an empty one.
  const piLists = [
    { label: 'the default tool list', allowedTools: allowedToolsForStep(undefined, 'pi') },
    { label: 'an empty tool list', allowedTools: [] as string[] },
  ];
  const drives = [
    ...RUNNER_IDS.flatMap(backend => cases.map(entry => ({ backend, ...entry, label: '', allowedTools: ['Read'] }))),
    ...piLists.flatMap(list => [false, true].map(resume => ({ backend: 'pi' as const, ...cases[0]!, resume, ...list, label: ` with ${list.label}` }))),
  ];
  for (const { backend, tool, args, resume, label, allowedTools } of drives) {
    it(`${backend} U0 calls ${tool} through its native wire on ${resume ? 'resume' : 'fresh'}${label}`, async () => {
      const { CiToolController } = await import('../ci-wait/controller.ts');
      const controller = await CiToolController.start();
      const dir = mkdtempSync(join(tmpdir(), 'cez-wait-call-'));
      const calls: unknown[][] = [];
      const session = controller.provision({
        registerWait: async (request, via) => {
          calls.push(['wait', request, via]);
          return { answer: { ok: true, wait_id: wait.id, kind: 'ci', deadline: wait.deadline, open_waits: openWaits }, wait };
        },
        ask: async request => { calls.push(['ask', request]); return { ok: true, wait_id: humanId, open_waits: humanOpen }; },
        cancelWait: async request => { calls.push(['cancel', request]); return { cancelled: true, wait_id: wait.id, open_waits: [] }; },
        finishTurn: async request => { calls.push(['done', request]); return { ok: true, finishes: 'at_turn_end', open_waits: openWaits }; },
      });
      try {
        const resultFile = join(dir, 'result');
        const file = join(dir, 'wire');
        if (backend === 'opencode' && resume) seedOpencodeMockSession(file);
        const obs = await driveSeam(backend, 'baseline', { spec: { cezarTools: session.descriptor, resume, allowedTools, restrictNativeDelegation: true, userPrompt: call(tool, args), env: { ...session.env, CEZ_MOCK_ARGS_FILE: file, CEZ_MOCK_CI_RESULT: resultFile, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
        expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
        const result = JSON.parse(readFileSync(resultFile, 'utf8'));
        expect(result.names).toEqual(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done']);
        expect(result.response.isError).not.toBe(true);
        const [json, hint] = result.response.content[0].text.split('\n');
        if (tool === 'cezar_ask') {
          expect(calls).toEqual([['ask', { context, questions }]]);
          expect(JSON.parse(json)).toEqual({ ok: true, wait_id: humanId, open_waits: humanOpen });
          expect(hint).toBe('Asked. Cezar shows the context and question card to the user. End your turn; the user\'s answer wakes you.');
        } else if (tool === 'cezar_wait') {
          expect(calls).toEqual([['wait', { ...args, timeout_seconds: 1800 }, 'cezar_wait']]);
          expect(JSON.parse(json)).toEqual({ ok: true, wait_id: wait.id, kind: 'ci', deadline: wait.deadline, open_waits: openWaits });
          expect(hint).toBe('Registered. End your turn to wait; any open wait wakes you when it resolves.');
        } else if (tool === 'cezar_done') {
          expect(calls).toEqual([['done', {}]]);
          expect(JSON.parse(json)).toEqual({ ok: true, finishes: 'at_turn_end', open_waits: openWaits });
          expect(hint).toBe('Accepted. End your turn; Cezar finishes the task at its end.');
        } else {
          expect(calls).toEqual([['cancel', args]]);
          expect(JSON.parse(json)).toEqual({ cancelled: true, wait_id: wait.id, open_waits: [] });
        }
        // Each allow-listing wire names both tools; the others admit the whole server.
        const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const argv: string[] | undefined = Array.isArray(rows[0]) ? rows[0] : undefined;
        if (backend === 'claude') expect(argv![argv!.indexOf('--allowedTools') + 1]!.split(',')).toEqual(expect.arrayContaining(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done'].map(name => `mcp__${session.descriptor.name}__${name}`)));
        if (backend === 'pi' && !argv!.includes('--tools')) expect(argv).toContain('--no-builtin-tools');
        else if (backend === 'pi' || backend === 'omp') expect(argv![argv!.indexOf('--tools') + 1]!.split(',')).toEqual(expect.arrayContaining(['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done']));
        if (backend === 'cursor') expect(argv![argv!.indexOf('--allowed-tools') + 1]!.split(',')).toContain('mcp_tool_call');
        expect(readFileSync(file, 'utf8')).not.toContain(session.env.CEZ_TOOL_TOKEN);
      } finally { await controller.close(); rmSync(dir, { recursive: true, force: true }); }
    }, 20000);
  }
});
