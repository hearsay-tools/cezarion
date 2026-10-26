import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openUrl } from './open-url.ts';

// `spawn` is replaced file-wide, so no case here opens a real browser (hearsay-tools/cezarion#1815).
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

const url = 'http://127.0.0.1:4545/';
const opener: Partial<Record<NodeJS.Platform, [string, string[]]>> = {
  darwin: ['open', [url]],
  win32: ['cmd', ['/c', 'start', '', url]],
};

/** A child that never starts or exits, with the `once` and `unref` the start uses. */
function fakeChild(): EventEmitter & { unref: () => void } {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

describe('openUrl', () => {
  afterEach(() => { spawnMock.mockReset(); });

  it('starts the platform opener detached and returns without waiting for it', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    expect(openUrl(url)).toBeUndefined();
    const [file, args] = opener[process.platform] ?? ['xdg-open', [url]];
    expect(spawnMock).toHaveBeenCalledWith(file, args, { stdio: 'ignore', detached: true });
    expect(child.unref).toHaveBeenCalled();
  });

  it('survives an opener that cannot start, whether spawn throws or the child reports an error', () => {
    spawnMock.mockImplementation(() => { throw new Error('spawn EINVAL'); });
    expect(() => openUrl(url)).not.toThrow();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    openUrl(url);
    // With no listener, an 'error' event would throw here and crash the serving process.
    expect(() => child.emit('error', new Error('spawn xdg-open ENOENT'))).not.toThrow();
  });
});
