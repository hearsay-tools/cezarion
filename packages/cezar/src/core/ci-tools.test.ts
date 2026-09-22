import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { driveSeam } from './harness-parity.testkit.ts';
import { buildChildEnv } from './agent-env.ts';
import { buildClaudeArgs } from './claude-cli-runner.ts';
import { buildPiArgs } from './pi-runner.ts';
import { ciOpenCodeEnv } from '../ci-wait/injection.ts';

const descriptor = { name: 'cezar_ci_test', command: process.execPath, args: ['/installed/dist/ci-wait/mcp.js'] };
const spec = { cwd: '/tmp', userPrompt: 'task', cezarTools: descriptor };

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
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,mcp__cezar_ci_test__cezar_wait_for_ci');
    expect(args).not.toContain('--strict-mcp-config');
  });
  it('Pi preserves discovered extensions, retry extension and selected tools', () => {
    const args = buildPiArgs({ ...spec, allowedTools: ['Read'] });
    expect(args.filter(value => value === '--extension')).toHaveLength(2);
    expect(args).not.toContain('--no-extensions');
    expect(args[args.indexOf('--tools') + 1]).toBe('read,cezar_wait_for_ci');
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
        const obs = await driveSeam(backend, 'baseline', { spec: { cezarTools: descriptor, resume, restrictNativeDelegation: true, env: { CEZ_MOCK_ARGS_FILE: file, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
        expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
        const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        if (backend === 'claude') expect(rows[0]).toContain('--mcp-config');
        if (backend === 'pi') expect(rows[0].filter((item: string) => item === '--extension')).toHaveLength(2);
        if (backend === 'codex') {
          const config = rows.find(row => row.method === (resume ? 'thread/resume' : 'thread/start')).params.config;
          expect(config['features.multi_agent']).toBe(false);
          expect(config[`mcp_servers.${descriptor.name}`]).toEqual({ command: descriptor.command, args: descriptor.args, env_vars: ['CEZ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET'] });
        }
        if (backend === 'cursor') expect(rows.find(row => row.method === (resume ? 'session/load' : 'session/new')).params.mcpServers).toEqual([{ ...descriptor, env: [] }]);
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
      const session = controller.provision(async () => { registrations++; return wait; });
      try {
        const resultFile = join(dir, 'result');
        const obs = await driveSeam(backend, 'baseline', { spec: { cezarTools: session.descriptor, resume, userPrompt: `mock:ci-wait ${valid ? wait.prUrl : 'https://github.com/owner/repo/issues/1'}`, env: { ...session.env, CEZ_MOCK_ARGS_FILE: join(dir, 'wire'), CEZ_MOCK_CI_RESULT: resultFile, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
        expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
        expect(registrations).toBe(valid ? 1 : 0);
        const result = JSON.parse(readFileSync(resultFile, 'utf8'));
        expect(result.names).toEqual(['cezar_wait_for_ci']);
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
