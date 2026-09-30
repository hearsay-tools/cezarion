import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveSeam, waitFor } from './harness-parity.testkit.ts';

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Native JSON-RPC fixtures: Codex ConfigRequirementsReadResponse, generated locally
// with `codex app-server generate-ts --experimental` (2026-09-30), and
// https://learn.chatgpt.com/docs/app-server#read-admin-requirements-configrequirementsread.
const managedCases = [
  { name: 'empty non-null requirements', requirements: {} },
  { name: 'Baseline sandbox allow-list', requirements: { allowedSandboxModes: ['read-only', 'workspace-write'] } },
  { name: 'read-only only', requirements: { allowedSandboxModes: ['read-only'] } },
  { name: 'managed profile default', requirements: { allowedPermissionProfiles: { locked: true }, defaultPermissions: 'locked' } },
  { name: 'managed network', requirements: { network: { enabled: true, allowedDomains: ['example.com'] } } },
];

async function observe(requirements: unknown, resume: boolean, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-permissions-')); directories.push(dir);
  const record = join(dir, 'wire.ndjson');
  const obs = await driveSeam('codex', 'baseline', {
    spec: { resume, sessionId: 'th_mock_1', env: { CEZ_MOCK_ARGS_FILE: record, MOCK_CODEX_REQUIREMENTS: JSON.stringify(requirements), ...extraEnv } },
    whileOpen: async (session, { v1 }) => {
      for (let completed = 1; completed <= 3; completed++) {
        await waitFor(() => v1.filter(e => e.type === 'turn-end').length >= completed);
        if (completed < 3) expect(session.sendMessage([{ type: 'text', text: `follow-up ${completed}` }])).toBe(true);
      }
    },
  });
  const wire = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { obs, wire, thread: wire.find(m => m.method === (resume ? 'thread/resume' : 'thread/start')).params };
}

describe('Codex managed permissions (#708)', () => {
  for (const { name, requirements } of managedCases) {
    for (const resume of [false, true]) {
      it(`${name}: ${resume ? 'resume' : 'start'} and subsequent messages preserve managed permissions`, async () => {
        const { obs, wire, thread } = await observe(requirements, resume);
        expect(obs.v1.filter(e => e.type === 'turn-end')).toHaveLength(3);
        expect(obs.v1.filter(e => e.type === 'note' && e.message.includes('disallowed'))).toEqual([]);
        expect(thread).not.toHaveProperty('sandbox');
        expect(thread).not.toHaveProperty('approvalPolicy');
        expect(thread).not.toHaveProperty('permissions');
        for (const turn of wire.filter(m => m.method === 'turn/start')) {
          expect(turn.params).not.toHaveProperty('sandboxPolicy');
          expect(turn.params).not.toHaveProperty('approvalPolicy');
        }
        expect(wire.findIndex(m => m.method === 'configRequirements/read')).toBeLessThan(wire.findIndex(m => m.method.startsWith('thread/')));
      });
    }
  }
  it('retains an allowed saved read-only profile when the managed default allows writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-permissions-')); directories.push(dir);
    const record = join(dir, 'wire.ndjson');
    await driveSeam('codex', 'baseline', {
      spec: { resume: true, sessionId: 'th_mock_1', env: {
        CEZ_MOCK_ARGS_FILE: record, MOCK_CODEX_PERSISTED_PROFILE: ':read-only',
        MOCK_CODEX_REQUIREMENTS: JSON.stringify({ allowedPermissionProfiles: { ':read-only': true, ':workspace': true }, defaultPermissions: ':workspace' }),
      } },
      sessionOptions: { autoEndAfterFirstTurn: true },
      whileOpen: async session => { await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' }); },
    });
    const wire = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(wire.find(m => m.method === 'thread/resume').params).not.toHaveProperty('permissions');
    expect(wire.some(m => m.method === 'turn/start')).toBe(true);
  });
  it.each([false, true])('preserves unmanaged full access, including UID-map constrained containers (resume=%s)', async resume => {
    const { thread } = await observe(null, resume);
    expect(thread.sandbox).toBe('danger-full-access');
    expect(thread).not.toHaveProperty('approvalPolicy');
  });
  it.each([false, true])('retains explicit network restriction (resume=%s)', async resume => {
    vi.stubEnv('CEZ_CODEX_NETWORK', '0');
    const { thread } = await observe(null, resume);
    expect(thread.sandbox).toBe('workspace-write');
    expect(thread.config['sandbox_workspace_write.network_access']).toBe(false);
  });
  it('does not turn a managed read-only policy into workspace-write for network=0', async () => {
    vi.stubEnv('CEZ_CODEX_NETWORK', '0');
    const { thread } = await observe({ allowedSandboxModes: ['read-only'] }, true);
    expect(thread).not.toHaveProperty('sandbox');
  });
  it('refuses an unconfirmed explicit network restriction before starting a model turn', async () => {
    vi.stubEnv('CEZ_CODEX_NETWORK', '0');
    const dir = mkdtempSync(join(tmpdir(), 'cez-permissions-')); directories.push(dir);
    const record = join(dir, 'wire.ndjson');
    await driveSeam('codex', 'baseline', { spec: { env: {
      CEZ_MOCK_ARGS_FILE: record, MOCK_CODEX_REQUIREMENTS: JSON.stringify({ defaultPermissions: 'locked' }), MOCK_CODEX_MANAGED_NETWORK: '1',
    } }, whileOpen: async session => {
      await expect(session.result).rejects.toThrow('CEZ_CODEX_NETWORK=0');
    } });
    expect(readFileSync(record, 'utf8')).not.toContain('"method":"turn/start"');
  });
  it('preserves managed permissions when steering a running turn', async () => {
    const obs = await driveSeam('codex', 'steer-tool', {
      spec: { env: { MOCK_CODEX_REQUIREMENTS: JSON.stringify({ allowedSandboxModes: ['read-only'] }) } },
      whileOpen: async (session, { v1 }) => {
        await waitFor(() => v1.some(e => e.type === 'tool-call'));
        expect(session.sendMessage([{ type: 'text', text: 'managed steering' }])).toBe(true);
        await waitFor(() => v1.some(e => e.type === 'turn-end'));
      },
    });
    expect(obs.result.text).toContain('managed steering');
    expect(obs.v1.filter(e => e.type === 'note' && e.message.includes('disallowed'))).toEqual([]);
  });
  it.each(['MOCK_CODEX_REQUIREMENTS_ERROR', 'MOCK_CODEX_REQUIREMENTS_MALFORMED'])('does not assume full access when discovery is unavailable: %s', async flag => {
    const { thread } = await observe(null, false, { [flag]: '1' });
    expect(thread).not.toHaveProperty('sandbox');
  });
});
