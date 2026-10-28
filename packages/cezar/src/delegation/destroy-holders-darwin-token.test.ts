import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../detached-process.ts', () => ({ processStartToken: () => undefined }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: () => ({ status: 0, stdout: `p424242\0n${state.root}/file\0`, stderr: '' }) };
});
import { reapDestroyHolders } from './destroy-holders.ts';
it('refuses a still-scoped Darwin holder with no verifiable start token', async () => {
  state.root = await mkdtemp(join(tmpdir(), 'cez-darwin-token-'));
  try {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
    await expect(reapDestroyHolders([state.root], () => {})).rejects.toThrow('Cannot verify destroy holder 424242');
  } finally { vi.unstubAllGlobals(); await rm(state.root, { recursive: true, force: true }); }
});
