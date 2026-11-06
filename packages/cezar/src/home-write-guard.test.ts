import { afterEach, describe, expect, it, vi } from 'vitest';
import { userInfo } from 'node:os';
import { join } from 'node:path';

// Fail closed: even a broken guard cannot write or remove a real file.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn(), chmodSync: vi.fn(), rmSync: vi.fn() };
});
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), rm: vi.fn() }));

import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { assertCezarHomeWriteIsSandboxed } from './paths.ts';
import { atomicWriteJsonSync } from './workspace/config.ts';
import { mergeWriteAgentAccounts } from './workspace/agent-accounts.ts';
import { enableRemoteSettings } from './remote-settings.ts';
import { saveServerState } from './server-install/state.ts';
import { freshServerState } from './server-install/types.ts';

const realHome = join(userInfo().homedir, '.cezar');
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('home write guard with HOME pinned to a sandbox', () => {
  it.each(['atomic JSON', 'agent accounts', 'remote settings', 'server state'])('blocks %s before any filesystem mutation', async (writer) => {
    vi.stubEnv('HOME', '/tmp/cez-guard-sandbox');
    vi.stubEnv('CEZ_HOME', realHome);
    const write = () => {
      if (writer === 'atomic JSON') return atomicWriteJsonSync(join(realHome, 'config.json'), {});
      if (writer === 'agent accounts') return mergeWriteAgentAccounts(() => {});
      if (writer === 'remote settings') return enableRemoteSettings(4321);
      return saveServerState(freshServerState());
    };
    await expect(async () => write()).rejects.toThrow('refusing to write');
    for (const mutation of [mkdirSync, writeFileSync, renameSync, mkdir, writeFile, rename]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it('does not let a custom env without VITEST bypass the process guard', async () => {
    await expect(enableRemoteSettings(4321, { CEZ_HOME: realHome })).rejects.toThrow('refusing to write');
    expect(mkdir).not.toHaveBeenCalled();
    expect(() => assertCezarHomeWriteIsSandboxed(join(realHome, 'file'), {})).toThrow('refusing to write');
  });

  it.each(['NODE_TEST_CONTEXT', 'JEST_WORKER_ID', 'STRYKER_MUTATOR'])('recognizes %s in the process', (key) => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv(key, '1');
    expect(() => assertCezarHomeWriteIsSandboxed(realHome, {})).toThrow('refusing to write');
  });

  it('allows a sandbox and a sibling path during a test', () => {
    expect(() => assertCezarHomeWriteIsSandboxed('/tmp/cez-guard-sandbox/file')).not.toThrow();
    expect(() => assertCezarHomeWriteIsSandboxed(`${realHome}-other/file`)).not.toThrow();
  });

  it('is a no-op outside test runners', () => {
    for (const key of Object.keys(process.env)) {
      if (['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID'].includes(key) || key.startsWith('STRYKER_')) vi.stubEnv(key, undefined);
    }
    expect(() => assertCezarHomeWriteIsSandboxed(realHome, { VITEST: 'true' })).not.toThrow();
  });
});
