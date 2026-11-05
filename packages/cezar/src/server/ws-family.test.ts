import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { attachUpgradeRouter } from './upgrade-router.ts';
import { createSocketHub, socketHubRoute, WS_PATH, type SocketHub, type TopicFamilyResolver, type TopicPublisher, type WsUpgradeVerdict } from './ws.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

const servers: Server[] = [];
const hubs: SocketHub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** One publisher per concrete name, with its own start and stop counts. */
function makeFamily(known: readonly string[]) {
  const started = new Map<string, number>();
  const stopped = new Map<string, number>();
  const publish = new Map<string, (data: unknown) => void>();
  const resolved: string[] = [];
  const resolve: TopicFamilyResolver = async (suffix) => {
    resolved.push(suffix);
    if (!known.includes(suffix)) return undefined;
    const publisher: TopicPublisher = {
      snapshot: async () => ({ project: suffix }),
      start: (send) => {
        started.set(suffix, (started.get(suffix) ?? 0) + 1);
        publish.set(suffix, send);
        return () => {
          stopped.set(suffix, (stopped.get(suffix) ?? 0) + 1);
          publish.delete(suffix);
        };
      },
    };
    return publisher;
  };
  return { started, stopped, publish, resolved, resolve };
}

async function boot(resolve: TopicFamilyResolver, verify: () => WsUpgradeVerdict = () => ({ trusted: true })): Promise<string> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const hub = createSocketHub();
  hub.registerTopicFamily('activity:project:', resolve);
  attachUpgradeRouter(server, [socketHubRoute(hub, verify)]);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  hubs.push(hub);
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}${WS_PATH}`;
}

async function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: unknown[] = [];
  const waiters: Array<(frame: unknown) => void> = [];
  ws.on('message', (raw) => {
    const frame: unknown = JSON.parse(String(raw));
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return {
    ws,
    frames,
    send: (frame: unknown) => ws.send(JSON.stringify(frame)),
    next: (): Promise<unknown> =>
      frames.length > 0
        ? Promise.resolve(frames.shift())
        : new Promise((resolve, reject) => {
            waiters.push(resolve);
            setTimeout(() => reject(new Error('no frame within 2s')), 2_000).unref();
          }),
  };
}

describe('a topic family', () => {
  it('starts and stops one publisher per concrete name', async () => {
    const family = makeFamily(['shop', 'docs']);
    const url = await boot(family.resolve);
    const alpha = await connect(url);
    const beta = await connect(url);

    alpha.send({ type: 'subscribe', topic: 'activity:project:shop' });
    expect(await alpha.next()).toEqual({ type: 'event', topic: 'activity:project:shop', data: { project: 'shop' } });
    beta.send({ type: 'subscribe', topic: 'activity:project:shop' });
    beta.send({ type: 'subscribe', topic: 'activity:project:docs' });
    await beta.next();
    await beta.next();
    expect(Object.fromEntries(family.started)).toEqual({ shop: 1, docs: 1 });

    family.publish.get('shop')?.({ n: 1 });
    expect(await alpha.next()).toEqual({ type: 'event', topic: 'activity:project:shop', data: { n: 1 } });
    expect(await beta.next()).toEqual({ type: 'event', topic: 'activity:project:shop', data: { n: 1 } });

    // Demand per name: docs stops at its last release while shop still has alpha.
    beta.send({ type: 'unsubscribe', topic: 'activity:project:docs' });
    beta.send({ type: 'unsubscribe', topic: 'activity:project:shop' });
    await vi.waitFor(() => expect(family.stopped.get('docs')).toBe(1), { timeout: HANG_GUARD_MS });
    expect(family.stopped.get('shop')).toBeUndefined();
    alpha.ws.terminate();
    await vi.waitFor(() => expect(family.stopped.get('shop')).toBe(1), { timeout: HANG_GUARD_MS });

    // The last release dropped the name: its next subscriber resolves and starts it again.
    const gamma = await connect(url);
    gamma.send({ type: 'subscribe', topic: 'activity:project:shop' });
    await gamma.next();
    expect(family.started.get('shop')).toBe(2);
    expect(family.resolved.filter((name) => name === 'shop')).toHaveLength(2);
    gamma.ws.close();
    beta.ws.close();
  });

  it('answers a name its resolver does not know with the unknown-topic error', async () => {
    const family = makeFamily(['shop']);
    const url = await boot(family.resolve);
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'activity:project:nope' });
    expect(await client.next()).toEqual({ type: 'error', topic: 'activity:project:nope', error: 'unknown topic' });
    client.send({ type: 'subscribe', topic: 'activity:project:' }); // the bare prefix names nothing
    expect(await client.next()).toEqual({ type: 'error', topic: 'activity:project:', error: 'unknown topic' });
    expect(family.resolved).toEqual(['nope']);
    client.ws.close();
  });

  it('refuses an untrusted connection before its resolver runs', async () => {
    const family = makeFamily(['shop']);
    const url = await boot(family.resolve, () => ({ trusted: false }));
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'activity:project:shop' });
    expect(await client.next()).toEqual({ type: 'error', topic: 'activity:project:shop', error: 'forbidden topic' });
    expect(family.resolved).toEqual([]);
    expect(family.started.size).toBe(0);
    client.ws.close();
  });

  it('starts nothing for a subscription released while its publisher resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const family = makeFamily(['shop']);
    const url = await boot(async (suffix) => {
      await gate;
      return family.resolve(suffix);
    });
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'activity:project:shop' });
    client.send({ type: 'unsubscribe', topic: 'activity:project:shop' });
    client.send({ type: 'subscribe', topic: 'activity:project:none' }); // a marker: its answer comes after
    release();
    expect(await client.next()).toEqual({ type: 'error', topic: 'activity:project:none', error: 'unknown topic' });
    expect(family.started.size).toBe(0);
    expect(client.frames).toEqual([]);
    client.ws.close();
  });

  it('refuses a registration that overlaps the family', () => {
    const hub = createSocketHub();
    const publisher: TopicPublisher = { snapshot: async () => null, start: () => () => undefined };
    hub.registerTopicFamily('activity:project:', async () => publisher);
    expect(() => hub.registerTopic('activity:project:shop', publisher)).toThrow(/topic family/);
    expect(() => hub.registerTopicFamily('activity:', async () => publisher)).toThrow(/overlaps/);
    hub.registerTopic('activity:workspace', publisher);
    hub.close();
  });
});
