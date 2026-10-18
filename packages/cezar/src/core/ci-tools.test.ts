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
import { cancelWaitToolDefinition, ciToolDefinition, cezarServerInstructions, cezarTools, waitToolDefinition } from '../ci-wait/tools.ts';

const descriptor = { name: 'cezar_ci_test', command: process.execPath, args: ['/installed/dist/ci-wait/mcp.js'] };
const spec = { cwd: '/tmp', userPrompt: 'task', cezarTools: descriptor };

// hearsay-tools/cezarion#1233: one wait tool and one cancel tool reach every runner through
// the shared list; `cezar_wait_for_ci` stays listed and admitted as a deprecated alias.
describe('wait tool definitions', () => {
  it('advertises cezar_wait as one flat object schema', () => {
    const schema = waitToolDefinition.inputSchema;
    expect(schema.type).toBe('object');
    // The Anthropic tool API refuses a top-level union; the kinds validate on the server.
    for (const key of ['oneOf', 'anyOf', 'allOf']) expect(schema).not.toHaveProperty(key);
    expect(schema.properties).toMatchObject({ kind: { enum: ['ci', 'timer'] } });
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['kind', 'note', 'pr', 'seconds', 'timeout_seconds']);
    expect(schema).toMatchObject({ required: ['kind'], additionalProperties: false });
    expect(schema.properties).toMatchObject({ seconds: { minimum: 60, maximum: 7200 }, timeout_seconds: { minimum: 1, maximum: 7200, default: 1800 }, note: { maxLength: 512 } });
    expect(JSON.stringify(schema)).not.toMatch(/"(?:oneOf|anyOf|allOf)"/);
    expect(cancelWaitToolDefinition.inputSchema).toMatchObject({ type: 'object', required: ['wait_id'], additionalProperties: false });
    expect(Object.keys(cancelWaitToolDefinition.inputSchema.properties ?? {})).toEqual(['wait_id']);
  });

  it('marks cezar_wait_for_ci deprecated: still listed and admitted, description points to cezar_wait, no trigger line in the server instructions', () => {
    for (const env of [{}, { CEZ_PREVIEW: '1' }]) {
      expect(cezarTools(env).map(tool => tool.definition.name).slice(0, 3)).toEqual(['cezar_wait_for_ci', 'cezar_wait', 'cezar_cancel_wait']);
      const instructions = cezarServerInstructions(env);
      expect(instructions).not.toContain('- cezar_wait_for_ci:');
      expect(instructions).toContain('- cezar_wait: load when you are waiting on CI for a PR or want to re-check something later; end your turn after it answers.');
      expect(instructions).toContain('- cezar_cancel_wait: load when a wait you registered is no longer needed.');
    }
    expect(ciToolDefinition.description.startsWith('Deprecated: use cezar_wait with kind "ci".')).toBe(true);
    expect(ciToolDefinition.inputSchema.properties).toEqual(expect.objectContaining({ pr: expect.any(Object), timeout_seconds: expect.any(Object) }));
    const claude = buildClaudeArgs({ ...spec, allowedTools: ['Read'] });
    expect(claude[claude.indexOf('--allowedTools') + 1]!.split(',')).toContain('mcp__cezar_ci_test__cezar_wait_for_ci');
    const pi = buildPiArgs({ ...spec, allowedTools: ['Read'] });
    expect(pi[pi.indexOf('--tools') + 1]!.split(',')).toContain('cezar_wait_for_ci');
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
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,mcp__cezar_ci_test__cezar_wait_for_ci,mcp__cezar_ci_test__cezar_wait,mcp__cezar_ci_test__cezar_cancel_wait');
    expect(args).not.toContain('--strict-mcp-config');
  });
  it('Pi preserves discovered extensions, retry extension and selected tools', () => {
    const args = buildPiArgs({ ...spec, allowedTools: ['Read'] });
    expect(args.filter(value => value === '--extension')).toHaveLength(2);
    expect(args).not.toContain('--no-extensions');
    expect(args[args.indexOf('--tools') + 1]).toBe('read,cezar_wait_for_ci,cezar_wait,cezar_cancel_wait');
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
        if (backend === 'pi') expect(rows[0].filter((item: string) => item === '--extension')).toHaveLength(2);
        if (backend === 'omp') expect(rows[0].filter((item: string) => item === '--extension')).toHaveLength(1);
        if (backend === 'codex') {
          const config = rows.find(row => row.method === (resume ? 'thread/resume' : 'thread/start')).params.config;
          expect(config['features.multi_agent']).toBe(false);
          expect(config[`mcp_servers.${descriptor.name}`]).toEqual({ command: descriptor.command, args: descriptor.args, env_vars: ['CEZ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET'] });
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
        registerWait: async () => { registrations++; return { answer: { ok: true, wait_id: wait.id, kind: 'ci', deadline: wait.deadline, open_waits: [] }, wait: { ...wait, kind: 'ci', source: 'agent', via: 'cezar_wait_for_ci', phase: 'open' } }; },
        cancelWait: async () => ({ cancelled: false, code: 'not_found', message: 'none' }),
      });
      try {
        const resultFile = join(dir, 'result');
        const file = join(dir, 'wire');
        if (backend === 'opencode' && resume) seedOpencodeMockSession(file);
        const obs = await driveSeam(backend, 'baseline', { spec: { cezarTools: session.descriptor, resume, userPrompt: `mock:ci-wait ${valid ? wait.prUrl : 'https://github.com/owner/repo/issues/1'}`, env: { ...session.env, CEZ_MOCK_ARGS_FILE: file, CEZ_MOCK_CI_RESULT: resultFile, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
        expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
        expect(registrations).toBe(valid ? 1 : 0);
        const result = JSON.parse(readFileSync(resultFile, 'utf8'));
        expect(result.names).toEqual(['cezar_wait_for_ci', 'cezar_wait', 'cezar_cancel_wait']);
        if (valid) {
          expect(result.response.isError).not.toBe(true);
          expect(JSON.stringify(result.response)).toContain(wait.id);
        } else {
          expect(result.response.isError).toBe(true);
          expect(JSON.stringify(result.response)).toContain('Invalid CI wait arguments');
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
  const cases = [
    { tool: 'cezar_wait', args: { kind: 'ci', pr: wait.prUrl }, resume: false },
    { tool: 'cezar_wait', args: { kind: 'ci', pr: wait.prUrl }, resume: true },
    { tool: 'cezar_cancel_wait', args: { wait_id: wait.id }, resume: false },
  ];
  for (const backend of RUNNER_IDS) for (const { tool, args, resume } of cases) {
    it(`${backend} U0 calls ${tool} through its native wire on ${resume ? 'resume' : 'fresh'}`, async () => {
      const { CiToolController } = await import('../ci-wait/controller.ts');
      const controller = await CiToolController.start();
      const dir = mkdtempSync(join(tmpdir(), 'cez-wait-call-'));
      const calls: unknown[][] = [];
      const session = controller.provision({
        registerWait: async (request, via) => { calls.push(['wait', request, via]); return { answer: { ok: true, wait_id: wait.id, kind: 'ci', deadline: wait.deadline, open_waits: openWaits }, wait }; },
        cancelWait: async request => { calls.push(['cancel', request]); return { cancelled: true, wait_id: wait.id, open_waits: [] }; },
      });
      try {
        const resultFile = join(dir, 'result');
        const file = join(dir, 'wire');
        if (backend === 'opencode' && resume) seedOpencodeMockSession(file);
        const obs = await driveSeam(backend, 'baseline', { spec: { cezarTools: session.descriptor, resume, allowedTools: ['Read'], restrictNativeDelegation: true, userPrompt: call(tool, args), env: { ...session.env, CEZ_MOCK_ARGS_FILE: file, CEZ_MOCK_CI_RESULT: resultFile, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
        expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
        const result = JSON.parse(readFileSync(resultFile, 'utf8'));
        expect(result.names).toEqual(['cezar_wait_for_ci', 'cezar_wait', 'cezar_cancel_wait']);
        expect(result.response.isError).not.toBe(true);
        const [json, hint] = result.response.content[0].text.split('\n');
        if (tool === 'cezar_wait') {
          expect(calls).toEqual([['wait', { ...args, timeout_seconds: 1800 }, 'cezar_wait']]);
          expect(JSON.parse(json)).toEqual({ ok: true, wait_id: wait.id, kind: 'ci', deadline: wait.deadline, open_waits: openWaits });
          expect(hint).toBe('Registered. End your turn to wait; any open wait wakes you when it resolves.');
        } else {
          expect(calls).toEqual([['cancel', args]]);
          expect(JSON.parse(json)).toEqual({ cancelled: true, wait_id: wait.id, open_waits: [] });
        }
        // Each allow-listing wire names both tools; the others admit the whole server.
        const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const argv: string[] | undefined = Array.isArray(rows[0]) ? rows[0] : undefined;
        if (backend === 'claude') expect(argv![argv!.indexOf('--allowedTools') + 1]!.split(',')).toEqual(expect.arrayContaining(['cezar_wait', 'cezar_cancel_wait'].map(name => `mcp__${session.descriptor.name}__${name}`)));
        if (backend === 'pi' || backend === 'omp') expect(argv![argv!.indexOf('--tools') + 1]!.split(',')).toEqual(expect.arrayContaining(['cezar_wait', 'cezar_cancel_wait']));
        if (backend === 'cursor') expect(argv![argv!.indexOf('--allowed-tools') + 1]!.split(',')).toContain('mcp_tool_call');
        expect(readFileSync(file, 'utf8')).not.toContain(session.env.CEZ_TOOL_TOKEN);
      } finally { await controller.close(); rmSync(dir, { recursive: true, force: true }); }
    }, 20000);
  }
});
