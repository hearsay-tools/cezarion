import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { win32 } from 'node:path';
import { publishArtifact } from './store.ts';

// Exercise the actual storage traversal with Windows path semantics on any CI host.
// Stop before the first child directory opens; no simulated path reaches the host filesystem.
vi.mock('node:path', async importOriginal => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, ...actual.win32 };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(), mkdir: vi.fn() };
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(['C:\\', '\\\\server\\share\\'])('starts the storage walk at the complete Windows root %s', async root => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.open)
    .mockResolvedValueOnce({ close } as unknown as Awaited<ReturnType<typeof fs.open>>)
    .mockRejectedValueOnce(new Error('stop before opening the child'));
  const runId = '8f87f627-0856-493f-a2f4-83c3e6759473';
  const directory = win32.join(root, 'repo', 'runs', `${runId}-artifacts`);
  await expect(publishArtifact(directory, runId, win32.join(root, 'source.txt'))).rejects.toThrow('stop before opening the child');
  expect(vi.mocked(fs.open).mock.calls.map(([path]) => path)).toEqual([root, win32.join(root, 'repo')]);
  expect(close).toHaveBeenCalledOnce();
});
