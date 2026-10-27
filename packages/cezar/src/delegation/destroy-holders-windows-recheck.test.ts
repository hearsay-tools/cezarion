import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => ({ scan: vi.fn(), stop: vi.fn() }));
vi.mock('./windows-workspace-identity.ts', () => ({
  windowsDestroyHolders: probes.scan,
  windowsStopDestroyHolder: probes.stop,
}));
import { reapDestroyHolders } from './destroy-holders.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it('stops a newly verified incarnation found only by the targeted holder scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-targeted-holder-'));
  try {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    let fullScans = 0; let targetedScans = 0;
    probes.scan.mockImplementation((_paths, pid) => {
      if (pid === undefined) return ++fullScans === 1 ? [{ pid: 42, token: 'old' }] : [];
      return ++targetedScans === 1 ? [{ pid: 42, token: 'new' }] : [];
    });
    await reapDestroyHolders([root], () => {});
    expect(probes.stop.mock.calls.map(([, pid, token]) => [pid, token])).toEqual([[42, 'old'], [42, 'new']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
