import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PreviewServerMessage } from '@open-mercato/cezar-contract';
import { vi } from 'vitest';
import type { Cdp, CdpConnection, CdpMessage } from './cdp.ts';
import type { AgentClient } from './cdp-proxy.ts';
import type { Viewer } from './session.ts';

/** Fakes shared by the preview session and host tests (#781). */

export function fakeCdp(reply?: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const cdp: Cdp = {
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const answer = reply?.(method, params);
      if (answer !== undefined) return answer;
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

/**
 * A browser connection for the agent's CDP proxy (hearsay-tools/cezarion#784): it grants each
 * browser session at once and answers every other command with an empty result, recording all.
 * `Target.createTarget` makes target `NEW`; `Target.attachToTarget` opens a page session `S<n>` (a `fakeCdp`, in `pages`);
 * `Target.getTargetInfo` calls a target a page unless its id starts with `W` (a worker).
 * A target in `gone` refuses `Target.attachToTarget`, as a closed tab does.
 * `emit` sends a browser event to every `onEvent` listener.
 */
export function fakeConnection() {
  const requests: Array<{ method: string; params: unknown; sessionId: string | undefined }> = [];
  const pages = new Map<string, ReturnType<typeof fakeCdp>>();
  const listeners = new Set<(msg: CdpMessage) => void>();
  const gone = new Set<string>();
  let sessions = 0;
  let attached = 0;
  let markClosed!: () => void;
  const closed = new Promise<void>(resolve => (markClosed = resolve));
  const answer = (method: string, params: unknown): CdpMessage => {
    const targetId = (params as { targetId?: unknown } | undefined)?.targetId;
    if (method === 'Target.attachToBrowserTarget') return { result: { sessionId: `B${++sessions}` } };
    if (method === 'Target.createTarget') return { result: { targetId: 'NEW' } };
    if (method === 'Target.attachToTarget' && typeof targetId === 'string' && gone.has(targetId)) return { error: { code: -32602, message: 'No target with given id found' } };
    if (method === 'Target.attachToTarget') return { result: { sessionId: `S${++attached}` } };
    if (method === 'Target.getTargetInfo' && typeof targetId === 'string') {
      return { result: { targetInfo: { targetId, type: targetId.startsWith('W') ? 'service_worker' : 'page', url: `http://localhost/${targetId}` } } };
    }
    return { result: {} };
  };
  const request: CdpConnection['request'] = (method, params, sessionId, onReply) => {
    requests.push({ method, params, sessionId });
    onReply(answer(method, params));
  };
  const connection: CdpConnection = {
    request,
    call: (method, params, sessionId) => new Promise<CdpMessage>(resolve => request(method, params, sessionId, resolve)),
    onEvent: fn => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    session: id => {
      const key = id ?? 'root';
      const page = pages.get(key) ?? fakeCdp();
      pages.set(key, page);
      return page.cdp;
    },
    close: () => markClosed(),
    closed,
  };
  const emit = (msg: CdpMessage) => {
    for (const fn of [...listeners]) fn(msg);
  };
  return { connection, requests, pages, emit, gone };
}

/** An agent's proxy socket, as the route hands it to the host. */
export function fakeAgentClient() {
  const client = {
    sent: [] as unknown[],
    closed: [] as Array<{ code: number; reason: string }>,
    send(text: string) { client.sent.push(JSON.parse(text)); },
    close(code: number, reason: string) { client.closed.push({ code, reason }); },
  };
  return client satisfies AgentClient;
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
