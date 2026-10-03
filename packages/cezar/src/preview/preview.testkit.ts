import type { PreviewServerMessage } from '@open-mercato/cezar-contract';
import { vi } from 'vitest';
import type { Cdp } from './cdp.ts';
import type { Viewer } from './session.ts';

/** Fakes shared by the preview session and host tests (#781). */

export function fakeCdp() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const cdp: Cdp = {
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] };
      return {};
    }) as Cdp['send'],
    on: ((event: string, fn: (params: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(fn);
      return () => void set.delete(fn);
    }) as Cdp['on'],
    close: vi.fn(),
    closed: new Promise<void>(() => {}),
  };
  const emit = (event: string, params: unknown) => {
    for (const fn of listeners.get(event) ?? []) fn(params);
  };
  return { cdp, calls, emit, sent: (method: string) => calls.filter(call => call.method === method) };
}

export function fakeViewer(userAgent = 'Firefox') {
  const viewer = {
    userAgent,
    frames: [] as string[],
    messages: [] as PreviewServerMessage[],
    closed: [] as Array<{ code: number; reason: string }>,
    sendFrame(buf: Buffer) { viewer.frames.push(buf.toString()); },
    send(msg: PreviewServerMessage) { viewer.messages.push(msg); },
    close(code: number, reason: string) { viewer.closed.push({ code, reason }); },
  };
  return viewer satisfies Viewer;
}
