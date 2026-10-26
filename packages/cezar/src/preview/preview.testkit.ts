import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

export interface FixtureProcessGuard {
  /** Appended to every `fake-dev-server.mjs` launch: the fixture ignores it, and `ps` shows it. */
  args: string[];
  /** Waits for every tagged process to go, then kills any survivor and throws naming it. */
  assertNoneLeft(): Promise<void>;
}

/**
 * A leak check for tests that launch `__fixtures__/fake-dev-server.mjs` (hearsay-tools/cezarion#1880).
 * The fixture never exits on its own before its lifetime ends, so a test that forgets one of its
 * processes strands it on the host. Tag each launch with `args` and call `assertNoneLeft()` at the
 * end of the test's teardown, so the leak fails the test that made it. The scan reads `ps`, so it
 * also sees the shell and the port holder below a launch, which a pid list would miss. It does
 * nothing on Windows, which has no `ps` and runs none of these fixtures.
 */
export function fixtureProcessGuard(): FixtureProcessGuard {
  const token = `cez-fixture-${randomUUID()}`;
  const tagged = (): Array<{ pid: number; command: string }> => {
    if (process.platform === 'win32') return [];
    // bound: `ps` lists a few thousand processes in milliseconds; this only stops a wedged `ps` from wedging the hook
    const listing = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
    return listing.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match && match[2]!.includes(token) ? [{ pid: Number(match[1]), command: match[2]! }] : [];
    });
  };
  return {
    args: ['--owner', token],
    async assertNoneLeft() {
      // bound: a SIGKILLed process leaves `ps` once the kernel reaps it; one still listed after this is a leak, which the throw below reports
      await vi.waitFor(() => { if (tagged().length) throw new Error('fixture process still listed'); }, { timeout: 5_000, interval: 25 }).catch(() => undefined);
      const left = tagged();
      if (!left.length) return;
      for (const { pid } of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      throw new Error(`${left.length} fixture process(es) outlived the test and were killed:\n${left.map(({ pid, command }) => `  ${pid} ${command}`).join('\n')}`);
    },
  };
}
