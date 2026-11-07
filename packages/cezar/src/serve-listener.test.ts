import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireServeListener, ignoreHangupOffTerminal, onTerminal, waitForHealth } from './serve-listener.ts';

const { createServerMock } = vi.hoisted(() => ({ createServerMock: vi.fn() }));
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return { ...actual, createServer: createServerMock };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const servers: Server[] = [];

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  createServerMock.mockImplementation(actual.createServer);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(process, 'platform', platformDescriptor);
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  })));
  createServerMock.mockReset();
});

function terminal(platform: NodeJS.Platform, stdin: boolean | undefined, stdout: boolean | undefined): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  vi.spyOn(process, 'stdin', 'get').mockReturnValue({ isTTY: stdin } as NodeJS.ReadStream);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue({ isTTY: stdout } as NodeJS.WriteStream);
}

describe('acquireServeListener', () => {
  it.each([undefined, '127.0.0.1'])('holds a real ephemeral loopback listener with host %s', async (bindHost) => {
    const server = await acquireServeListener(0, bindHost);
    servers.push(server);
    const address = server.address() as AddressInfo;
    expect(server.listening).toBe(true);
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/health`);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('connection')).toBe('close');
    expect(await response.text()).toBe('Cockpit is starting; retry shortly.\n');
  });

  it('reports an occupied port without closing the existing listener', async () => {
    const server = await acquireServeListener(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    await expect(acquireServeListener(port, '127.0.0.1')).rejects.toThrow(
      `Cockpit port ${port} on 127.0.0.1 is already in use. ` +
      'Open the existing cockpit if it is serving there, stop the process using this port, ' +
      'or pass --port <free-port> to deliberately start another cockpit.',
    );
    expect(server.listening).toBe(true);
  });

  it.each(['throw', 'emit'])('closes its listener and preserves an arbitrary bind error (%s)', async (mode) => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const listener = Object.assign(new EventEmitter(), { listen: vi.fn(), close: vi.fn() });
    listener.listen.mockImplementation(() => {
      if (mode === 'throw') throw error;
      queueMicrotask(() => { listener.emit('error', error); });
      return listener;
    });
    createServerMock.mockReturnValue(listener);
    await expect(acquireServeListener(4321, '127.0.0.2')).rejects.toBe(error);
    expect(listener.listen).toHaveBeenCalledExactlyOnceWith(4321, '127.0.0.2');
    expect(listener.close).toHaveBeenCalledOnce();
  });
});

describe('onTerminal', () => {
  it.each([
    ['linux', true, false, true],
    ['linux', false, true, true],
    ['darwin', undefined, true, true],
    ['linux', false, false, false],
    ['linux', undefined, undefined, false],
    ['win32', true, true, false],
  ] as const)('detects terminal for %s stdin=%s stdout=%s', (platform, stdin, stdout, expected) => {
    terminal(platform, stdin, stdout);
    expect(onTerminal()).toBe(expected);
  });
});

describe('ignoreHangupOffTerminal', () => {
  it('installs a no-op SIGHUP listener on Unix without a terminal', () => {
    terminal('linux', false, false);
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    ignoreHangupOffTerminal();
    expect(on).toHaveBeenCalledExactlyOnceWith('SIGHUP', expect.any(Function));
    const handler = on.mock.calls[0]![1] as () => void;
    expect(handler()).toBeUndefined();
  });

  it.each([
    ['linux', true, false],
    ['linux', false, true],
    ['win32', false, false],
  ] as const)('does not install a handler for %s stdin=%s stdout=%s', (platform, stdin, stdout) => {
    terminal(platform, stdin, stdout);
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    ignoreHangupOffTerminal();
    expect(on).not.toHaveBeenCalled();
  });
});

describe('waitForHealth', () => {
  const healthUrl = 'http://127.0.0.1:4321/api/v1/health';

  it('returns immediately when the exact health URL answers successfully', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForHealth(healthUrl, 5_000)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(healthUrl);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['unhealthy', 'throw'])('retries a %s response after 150 milliseconds', async (failure) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    if (failure === 'throw') fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    else fetchMock.mockResolvedValueOnce({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    const healthy = waitForHealth(healthUrl, 5_000);
    await vi.advanceTimersByTimeAsync(149);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(healthy).resolves.toBe(true);
    expect(fetchMock.mock.calls).toEqual([[healthUrl], [healthUrl]]);
  });

  it.each(['unhealthy', 'throw'])('returns false when repeated %s results reach the deadline', async (failure) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    if (failure === 'throw') fetchMock.mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);
    const healthy = waitForHealth(healthUrl, 300);
    await vi.advanceTimersByTimeAsync(300);
    await expect(healthy).resolves.toBe(false);
    expect(fetchMock.mock.calls).toEqual([[healthUrl], [healthUrl]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fetch when the deadline has already elapsed', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(waitForHealth(healthUrl, 0)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
