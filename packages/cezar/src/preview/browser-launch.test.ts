import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromiumError, launchChromium, resolveChromium } from './chromium.ts';
import { ChromiumMissingError, launchBrowser, readOsRelease, waitForExit, type BrowserHandle } from './browser-launch.ts';
import { fakeConnection } from './preview.testkit.ts';

vi.mock('./chromium.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./chromium.ts')>(),
  resolveChromium: vi.fn(),
  launchChromium: vi.fn(),
}));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: vi.fn(),
}));

function browserFixture(targetInfos: unknown = [{ type: 'worker', targetId: 'worker' }, { type: 'page', targetId: 'page' }]) {
  const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
  const { connection } = fakeConnection();
  const root = connection.session(undefined);
  vi.mocked(root.send).mockImplementation(async method => method === 'Target.getTargets' ? { targetInfos } : { sessionId: 'attached' });
  vi.spyOn(connection, 'session');
  vi.spyOn(connection, 'close');
  vi.mocked(resolveChromium).mockReturnValue('/fake/chrome');
  vi.mocked(launchChromium).mockResolvedValue({ proc, browser: connection } as unknown as Awaited<ReturnType<typeof launchChromium>>);
  return { proc, connection, root };
}

describe('preview browser launch', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.useRealTimers());

  it('resolves with the supplied environment and returns the attached page and a working close callback', async () => {
    const { proc, connection, root } = browserFixture();
    const env = { PATH: '/fake/bin' };
    const handle = await launchBrowser('/fake/profile', env);
    expect(resolveChromium).toHaveBeenCalledExactlyOnceWith(undefined, env);
    expect(launchChromium).toHaveBeenCalledExactlyOnceWith('/fake/chrome', '/fake/profile', env);
    expect(root.send).toHaveBeenNthCalledWith(1, 'Target.getTargets');
    expect(root.send).toHaveBeenNthCalledWith(2, 'Target.attachToTarget', { targetId: 'page', flatten: true });
    expect(connection.session).toHaveBeenNthCalledWith(1, undefined);
    expect(connection.session).toHaveBeenNthCalledWith(2, 'attached');
    expect(handle).toMatchObject({ connection, cdp: connection.session('attached'), pageTargetId: 'page' });
    handle.close();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith();
    expect(vi.mocked(connection.close).mock.invocationCallOrder[0]).toBeLessThan(proc.kill.mock.invocationCallOrder[0]!);
  });

  it('throws the missing-browser error before launching', async () => {
    browserFixture();
    vi.mocked(resolveChromium).mockReturnValue(undefined);
    const result = launchBrowser('/profile', {});
    await expect(result).rejects.toBeInstanceOf(ChromiumMissingError);
    await expect(result).rejects.toMatchObject({ message: 'No Chromium found' });
    expect(launchChromium).not.toHaveBeenCalled();
  });

  it('preserves a launch failure', async () => {
    browserFixture();
    const error = new ChromiumError('sandbox', 'sandbox stderr', 'sandbox refused');
    vi.mocked(launchChromium).mockRejectedValue(error);
    await expect(launchBrowser('/profile', {})).rejects.toBe(error);
  });

  it('closes and kills a browser without a page and includes its stderr in the error', async () => {
    const { proc, root, connection } = browserFixture([]);
    vi.mocked(root.send).mockImplementation(async () => {
      proc.stderr.emit('data', Buffer.from('no page stderr'));
      return { targetInfos: [] };
    });
    const result = launchBrowser('/profile', {});
    await expect(result).rejects.toBeInstanceOf(ChromiumError);
    await expect(result).rejects.toMatchObject({ kind: 'exited', message: 'Chromium opened no page', stderrTail: 'no page stderr' });
    expect(connection.close).toHaveBeenCalledOnce();
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it.each(['targets', 'attachment', 'transport'])('cleans up after an invalid %s reply', async kind => {
    const { root, proc, connection } = browserFixture();
    const error = new Error('transport closed');
    vi.mocked(root.send).mockImplementation(async method => {
      if (kind === 'transport') throw error;
      if (method === 'Target.getTargets') return kind === 'targets' ? {} : { targetInfos: [{ type: 'page', targetId: 'page' }] };
      return { sessionId: 42 };
    });
    const result = launchBrowser('/profile', {});
    if (kind === 'transport') await expect(result).rejects.toBe(error);
    else await expect(result).rejects.toMatchObject({ name: 'ZodError' });
    expect(connection.close).toHaveBeenCalledOnce();
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it.each([
    { code: 0, signal: null, exit: { exitCode: 0 } },
    { code: 7, signal: null, exit: { exitCode: 7 } },
    { code: null, signal: 'SIGTERM', exit: { signal: 'SIGTERM' } },
    { code: 3, signal: 'SIGKILL', exit: { signal: 'SIGKILL' } },
    { code: null, signal: null, exit: {} },
  ])('reports process exit $code/$signal and the newest 4096 stderr characters', async ({ code, signal, exit }) => {
    const { proc } = browserFixture();
    const handle = await launchBrowser('/profile', {});
    proc.stderr.emit('data', Buffer.from('old'.repeat(2000)));
    proc.stderr.emit('data', Buffer.from('é'.repeat(4090) + 'newest'));
    proc.emit('exit', code, signal);
    await expect(handle.exited).resolves.toEqual({ ...exit, stderrTail: 'é'.repeat(4090) + 'newest' });
  });

  it('accepts a process without stderr', async () => {
    const { proc, connection } = browserFixture();
    vi.mocked(launchChromium).mockResolvedValue({ proc: Object.assign(proc, { stderr: null }), browser: connection } as unknown as Awaited<ReturnType<typeof launchChromium>>);
    const handle = await launchBrowser('/profile', {});
    proc.emit('exit', 0, null);
    await expect(handle.exited).resolves.toEqual({ exitCode: 0, stderrTail: '' });
  });

  it('waits for exit and clears the release timeout', async () => {
    vi.useFakeTimers();
    const { proc } = browserFixture();
    const browser = await launchBrowser('/profile', {});
    const done = vi.fn();
    const waiting = waitForExit(browser).then(done);
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).not.toHaveBeenCalled();
    proc.emit('exit', 0, null);
    await waiting;
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds profile release at exactly five seconds when the browser never exits', async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const waiting = waitForExit({ exited: new Promise(() => {}) } as BrowserHandle).then(done);
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads the OS release as UTF-8 and degrades to empty when unavailable', () => {
    vi.mocked(readFileSync).mockReturnValue('NAME=Example Linux\n');
    expect(readOsRelease()).toBe('NAME=Example Linux\n');
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith('/etc/os-release', 'utf8');
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('unreadable'); });
    expect(readOsRelease()).toBe('');
  });
});
