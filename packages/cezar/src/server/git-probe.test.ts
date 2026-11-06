import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => {
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: exec });
  return { execFile };
});
const { getRepoInfo } = await import('./git.ts');

describe('Git probe commands', () => {
  beforeEach(() => exec.mockReset());

  it('combines root and branch and retains remote get-url', async () => {
    exec.mockResolvedValueOnce({ stdout: '/repo\nmain\n' }).mockResolvedValueOnce({ stdout: 'https://github.com/acme/demo.git\n' });
    expect(await getRepoInfo('/repo')).toEqual({ root: '/repo', branch: 'main', remote: 'https://github.com/acme/demo.git' });
    expect(exec.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['git', ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD']],
      ['git', ['remote', 'get-url', 'origin']],
    ]);
  });

  it('keeps both fallback commands when origin is absent', async () => {
    exec.mockResolvedValueOnce({ stdout: '/repo\nmain\n' }).mockRejectedValueOnce(new Error('no origin'))
      .mockResolvedValueOnce({ stdout: 'upstream\n' }).mockResolvedValueOnce({ stdout: 'remote\n' });
    expect((await getRepoInfo('/repo'))?.remote).toBe('remote');
    expect(exec.mock.calls.map((call) => call[1])).toEqual([
      ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], ['remote', 'get-url', 'origin'],
      ['remote'], ['remote', 'get-url', 'upstream'],
    ]);
  });

  it('stops after the first failed spawn when Git is missing', async () => {
    exec.mockRejectedValueOnce(Object.assign(new Error('missing git'), { code: 'ENOENT' }));
    expect(await getRepoInfo('/repo')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
