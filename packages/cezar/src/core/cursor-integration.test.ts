import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { buildChildEnv } from './agent-env.ts';
import { detectEnvironment } from './backend-detect.ts';
import { profileEnv, supportsProfiles } from './agent-profiles.ts';
import { ProviderAuthService } from './provider-auth.ts';
import { defaultAgentProfile } from '../workspace/agent-profiles.ts';
import { agentHomePaths } from '../paths.ts';
import { findConfigFile } from '../agent-config/catalog.ts';

vi.mock('node:child_process', () => {
  const execFile = vi.fn((bin, _args, _opts, callback) => {
    if (bin === '/missing/cursor-agent') callback(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', '');
    else callback(null, bin === '/custom/agent' ? '2026.09.15-test' : '', '');
  });
  Object.assign(execFile, {
    [Symbol.for('nodejs.util.promisify.custom')]: (bin: string, args: string[], opts: object) =>
      new Promise((resolve, reject) => execFile(bin, args, opts, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error); else resolve({ stdout, stderr });
      })),
  });
  return { execFile };
});

beforeEach(() => {
  vi.stubEnv('CURSOR_API_KEY', '');
  vi.stubEnv('CURSOR_AUTH_TOKEN', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('Cursor product integration', () => {
  it('forwards Cursor credentials only to Cursor, without unrelated provider secrets', () => {
    const source = { CURSOR_API_KEY: 'cursor-test', ANTHROPIC_API_KEY: 'anthropic-test', OPENAI_API_KEY: 'openai-test' };
    expect(buildChildEnv({ backend: 'cursor', source })).toEqual({ CURSOR_API_KEY: 'cursor-test' });
    expect(buildChildEnv({ backend: 'claude', source })).not.toHaveProperty('CURSOR_API_KEY');
  });
  it('uses the configured executable for detection', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('CEZ_CURSOR_BIN', '/custom/agent');
    expect((await detectEnvironment()).find((row) => row.name === 'cursor')).toMatchObject({ available: true, version: '2026.09.15-test' });
    expect(execFile).toHaveBeenCalledWith('/custom/agent', ['--version'], { timeout: 10_000 }, expect.any(Function));
  });
  it('does not invent a home variable for alternate Cursor accounts', () => {
    expect(supportsProfiles('cursor')).toBe(false);
    expect(profileEnv('cursor', '/alternate')).toEqual({});
    expect(defaultAgentProfile('cursor', { HOME: '/home/test' }).path).toBe('/home/test/.cursor');
  });
  it('reports Cursor in dry-run without an installed executable', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_CURSOR_BIN', '/missing/cursor-agent');
    expect((await detectEnvironment()).find((row) => row.name === 'cursor')).toMatchObject({ available: true, version: 'mock (CEZ_DRY_RUN=1)' });
  });
  it('degrades gracefully when Cursor is absent', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('CEZ_CURSOR_BIN', '/missing/cursor-agent');
    expect((await detectEnvironment()).find((row) => row.name === 'cursor')).toMatchObject({ available: false, hint: expect.stringContaining('Cursor') });
  });
  it('uses the override for Cursor login', () => {
    vi.stubEnv('CEZ_CURSOR_BIN', '/custom/agent');
    expect(new ProviderAuthService().loginCommand('cursor')).toBe("'/custom/agent' login");
  });
  it.each([
    ['{"status":"authenticated","isAuthenticated":true}', 0, 'connected'],
    ['{"status":"unauthenticated","isAuthenticated":false}', 0, 'disconnected'],
    ['{"status":"partially-authenticated","isAuthenticated":false}', 0, 'disconnected'],
    ['{"status":"error"}', 1, 'unknown'],
    ['unexpected', 0, 'unknown'],
  ] as const)('parses Cursor status without exposing account details: %s', async (stdout, exitCode, status) => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '0');
    const service = new ProviderAuthService({ runCommand: async () => ({ stdout, exitCode, stderr: '' }) });
    expect((await service.status()).providers.find((row) => row.provider === 'cursor')).toMatchObject({ status });
  });
  it('keeps API-key-only Cursor authentication usable before a browser login', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '0');
    vi.stubEnv('CURSOR_API_KEY', 'test-only-key');
    const service = new ProviderAuthService({ runCommand: async () => ({ stdout: '{"status":"unauthenticated","isAuthenticated":false}', exitCode: 0, stderr: '' }) });
    expect((await service.status()).providers.find((row) => row.provider === 'cursor')).toMatchObject({ status: 'connected' });
    service.reportRuntimeAuthFailure('cursor');
    expect((await service.status()).providers.find((row) => row.provider === 'cursor')).toMatchObject({ status: 'disconnected' });
  });
  it('resolves documented config directories and project permissions', () => {
    const paths = agentHomePaths({ HOME: '/home/test', CURSOR_CONFIG_DIR: '/config/cursor' });
    expect(findConfigFile('cursor.user.settings')?.resolve('/repo', paths)).toBe('/config/cursor/cli-config.json');
    expect(findConfigFile('cursor.project.settings')?.resolve('/repo', paths)).toBe('/repo/.cursor/cli.json');
    expect(findConfigFile('project.agents')?.runners).toContain('cursor');
  });
});
