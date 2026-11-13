import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import type { UpgradeRoute } from './upgrade-router.ts';

/**
 * Demand-driven topic WebSocket bus. Start publishers on first subscription and stop on last
 * release. The browser’s shared live owner coordinates local demand. Upgrade authorization
 * belongs to the supplied guard, not the hub.
 */

/** The one upgrade path. Workspace-level like `/api/workspace/events` — never
 *  mirrored under `/api/p/:projectId` (topics carry workspace data). */
export const WS_PATH = '/api/v1/ws';

/** Heartbeat cadence — the interval on which the hub both REAPS silently-dead
 *  clients (a killed browser process sends no FIN) and emits a liveness beat
 *  every client can see. A client that missed the previous beat's pong is gone;
 *  terminating it releases its topic subscriptions so publishers can stop. */
const HEARTBEAT_MS = 30_000;

/** Client frames are tiny control messages; anything bigger is not our
 *  protocol. Kills the abuse case of a page streaming megabytes at the hub. */
const MAX_PAYLOAD_BYTES = 4_096;

/** Everything a client may say. Malformed frames get an `error` frame back
 *  (not a disconnect — one buggy caller must not tear down its tab's other
 *  subscriptions). */
const clientFrameSchema = z.object({
  type: z.enum(['subscribe', 'unsubscribe']),
  topic: z.string().min(1).max(128),
});

export interface TopicPublisher {
  /** Fresh payload for a subscriber that just arrived — sent immediately so a
   *  (re)connecting cockpit never waits out a publisher interval to render. */
  snapshot(): Promise<unknown>;
  /** Subscriber count went 0→1: start producing. Call `publish` whenever the
   *  topic has news (every call is broadcast verbatim to all subscribers).
   *  Returns the stop function, called at 1→0. */
  start(publish: (data: unknown) => void): () => void;
}

/**
 * A topic family's resolver: the publisher for one concrete name under the family's prefix, from
 * the rest of the name. `undefined` (or a rejection) answers the unknown-topic error. It runs on
 * the first subscriber of a concrete name, each time the name's demand starts again.
 */
export type TopicFamilyResolver = (suffix: string) => TopicPublisher | undefined | Promise<TopicPublisher | undefined>;

export interface TopicOptions {
  /** Whether an ADMITTED-BUT-UNTRUSTED connection may subscribe (see
   *  `WsUpgradeVerdict`). Defaults to `false` — the safe default that makes the
   *  topic-safety invariant mechanical: a topic carrying run/repo/PR content is
   *  legible only to the cockpit itself unless a publisher explicitly opts in.
   *  Set `true` only for data already safe for any local page (e.g. `health`,
   *  the CORS-open discovery payload). */
  loopbackReadable?: boolean;
}

/**
 * The upgrade guard's verdict: reject, or admit at a trust level.
 *
 * `false` — reject the handshake (403). A `trusted` connection is provably the
 * cockpit itself — a same-authority Origin, a no-Origin native client, or a dev
 * proxy the browser vouches for via `Sec-Fetch-Site` — and may subscribe to any
 * topic. A NON-`trusted` connection was admitted by the loopback-origin fallback
 * on a browser that ships no `Sec-Fetch` metadata, where the dev proxy and a
 * foreign page on another local port are indistinguishable at the handshake: it
 * may subscribe ONLY to topics a publisher flagged `loopbackReadable`.
 */
export type WsUpgradeVerdict = false | { trusted: boolean };

export interface SocketHub {
  /** Register a topic clients may subscribe to. Registration is boot-time
   *  wiring (createApp), so a duplicate name is a programming error: throw.
   *  `options.loopbackReadable` defaults to `false` (topic legible to trusted
   *  connections only) — see `TopicOptions`. */
  registerTopic(name: string, publisher: TopicPublisher, options?: TopicOptions): void;
  /** Register every topic whose name starts with `prefix` (spec 2026-11-05-live-activity-view,
   *  Live transport): the first subscriber of a concrete name resolves its publisher, demand is
   *  counted per concrete name, and the last release stops and drops it. `options` applies to
   *  every name in the family, under the same trust rules as `registerTopic`. A prefix that
   *  overlaps another registration is a programming error: throw. */
  registerTopicFamily(prefix: string, resolve: TopicFamilyResolver, options?: TopicOptions): void;
  /** Accept one `WS_PATH` upgrade under the request-origin guard's verdict:
   *  `false` answers 403 before the handshake, otherwise its `trusted` flag
   *  decides which topics the connection may read. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, verdict: WsUpgradeVerdict): void;
  /** Stop publishers, terminate clients, clear timers. Idempotent; the server
   *  that routes upgrades here calls it on its own `close`. */
  close(): void;
  /** Call `listener` once when the hub closes: whatever a topic's registration holds for the
   *  server's lifetime is released there. Returns the release of the listener itself. */
  onClose(listener: () => void): () => void;
}

interface TopicState {
  publisher: TopicPublisher;
  subscribers: Set<WebSocket>;
  /** Non-null exactly while the publisher runs (≥1 subscriber). */
  stop: (() => void) | null;
  /** `TopicOptions.loopbackReadable`, resolved (default `false`). */
  loopbackReadable: boolean;
  /** A family member: dropped from the map when its last subscriber leaves. */
  family: boolean;
}

interface TopicFamily {
  prefix: string;
  resolve: TopicFamilyResolver;
  loopbackReadable: boolean;
}

interface ClientState {
  /** Flipped by `pong`, cleared before each `ping` — two silent beats = dead. */
  alive: boolean;
  topics: Set<string>;
  /** Family names whose publisher is still resolving, each with this subscribe's token: a
   *  resolution that finds another token (or none) was released meanwhile and attaches nothing. */
  pending: Map<string, object>;
  /** The upgrade verdict's trust flag (see `WsUpgradeVerdict`). An untrusted
   *  connection may subscribe only to `loopbackReadable` topics. */
  trusted: boolean;
  /** Topics whose subscribe snapshot is still pending, each with the publishes held for it. The
   *  snapshot was read before them, so it must reach the client first: sent after a publish, it
   *  would replace newer data, and a deduplicating publisher never sends that data again. */
  held: Map<string, unknown[]>;
}

export interface SocketHubOptions {
  /** Heartbeat interval override (ms). Defaults to `HEARTBEAT_MS`; tests set it
   *  small so reaping and the liveness beat are observable without a 30 s wait. */
  heartbeatMs?: number;
}

export function createSocketHub(options: SocketHubOptions = {}): SocketHub {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const topics = new Map<string, TopicState>();
  const families: TopicFamily[] = [];
  /** One resolution per concrete family name at a time, shared by its concurrent subscribers. */
  const resolving = new Map<string, Promise<TopicPublisher | undefined>>();
  const clients = new Map<WebSocket, ClientState>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const closeListeners = new Set<() => void>();

  const send = (ws: WebSocket, frame: unknown): void => {
    // OPEN as the literal 1: the check must hold for any socket implementation.
    if (ws.readyState === 1) ws.send(JSON.stringify(frame));
  };

  const attach = (ws: WebSocket, client: ClientState, topic: string, state: TopicState): void => {
    if (client.topics.has(topic)) return; // idempotent — a re-sent frame must not double anything
    client.topics.add(topic);
    state.subscribers.add(ws);
    const held: unknown[] = [];
    client.held.set(topic, held);
    if (state.stop === null) {
      state.stop = state.publisher.start((data) => {
        for (const subscriber of state.subscribers) {
          const pending = clients.get(subscriber)?.held.get(topic);
          if (pending) pending.push(data);
          else send(subscriber, { type: 'event', topic, data });
        }
      });
    }
    // The immediate snapshot — async, so the socket or the subscription may be
    // gone by the time it resolves; both are re-checked. A failing snapshot is
    // dropped: the publishes held meanwhile, and the next publish, carry the news.
    const release = (snapshot: { data: unknown } | undefined): void => {
      if (client.held.get(topic) !== held) return; // released, or subscribed again since
      client.held.delete(topic);
      if (snapshot) send(ws, { type: 'event', topic, data: snapshot.data });
      for (const data of held) send(ws, { type: 'event', topic, data });
    };
    void state.publisher
      .snapshot()
      .then((data) => release({ data }), () => release(undefined));
  };

  const familyOf = (topic: string): TopicFamily | undefined =>
    families.find((family) => topic.startsWith(family.prefix) && topic.length > family.prefix.length);

  const resolveMember = (family: TopicFamily, topic: string): Promise<TopicPublisher | undefined> => {
    const inFlight = resolving.get(topic);
    if (inFlight) return inFlight;
    // The resolver runs after the resolution is registered, so its cleanup always follows the
    // registration, also when it throws synchronously. A resolver that throws names no topic.
    const resolution: Promise<TopicPublisher | undefined> = Promise.resolve()
      .then(() => family.resolve(topic.slice(family.prefix.length)))
      .catch(() => undefined)
      .finally(() => {
        if (resolving.get(topic) === resolution) resolving.delete(topic);
      });
    resolving.set(topic, resolution);
    return resolution;
  };

  /** A family member's first subscriber resolves its publisher; the subscription may be released,
   *  or the socket gone, by the time it resolves. */
  const subscribeMember = (ws: WebSocket, client: ClientState, topic: string, family: TopicFamily): void => {
    if (client.pending.has(topic)) return; // idempotent while resolving
    const token = {};
    client.pending.set(topic, token);
    void resolveMember(family, topic).then((publisher) => {
      if (closed || client.pending.get(topic) !== token || clients.get(ws) !== client) return;
      client.pending.delete(topic);
      if (!publisher && !topics.has(topic)) {
        send(ws, { type: 'error', topic, error: 'unknown topic' });
        return;
      }
      let state = topics.get(topic);
      if (!state) {
        state = { publisher: publisher!, subscribers: new Set(), stop: null, loopbackReadable: family.loopbackReadable, family: true };
        topics.set(topic, state);
      }
      attach(ws, client, topic, state);
    });
  };

  const subscribe = (ws: WebSocket, client: ClientState, topic: string): void => {
    const state = topics.get(topic);
    const family = state ? undefined : familyOf(topic);
    if (!state && !family) {
      send(ws, { type: 'error', topic, error: 'unknown topic' });
      return;
    }
    if (!(state?.loopbackReadable ?? family!.loopbackReadable) && !client.trusted) {
      // Admitted by the loopback-origin fallback (a browser with no Sec-Fetch,
      // so indistinguishable from a foreign local page): only topics explicitly
      // marked safe for any local page are legible. This is the mechanical half
      // of the topic-safety invariant — the guard opens the door, the flag says
      // which rooms an unproven caller may enter. A family member is refused
      // before its resolver runs: an untrusted caller starts no work.
      send(ws, { type: 'error', topic, error: 'forbidden topic' });
      return;
    }
    if (state) attach(ws, client, topic, state);
    else subscribeMember(ws, client, topic, family!);
  };

  const unsubscribe = (ws: WebSocket, client: ClientState, topic: string): void => {
    client.pending.delete(topic); // a resolution still in flight attaches nothing now
    client.held.delete(topic);
    if (!client.topics.delete(topic)) return;
    const state = topics.get(topic);
    if (!state) return;
    state.subscribers.delete(ws);
    if (state.subscribers.size === 0 && state.stop !== null) {
      state.stop();
      state.stop = null;
    }
    // Demand is counted per concrete name: a family member's next subscriber resolves it again.
    if (state.subscribers.size === 0 && state.family) topics.delete(topic);
  };

  /** Started by the first upgrade, so a hub nobody connects to holds no timer. */
  const startHeartbeat = (): void => {
    if (heartbeat !== undefined) return;
    heartbeat = setInterval(() => {
      for (const [ws, client] of clients) {
        if (!client.alive) {
          // Missed the previous beat's pong — the peer is gone. Terminate (not
          // a polite close, there is nobody to handshake with); 'close' fires
          // synchronously and dropClient releases its topics.
          ws.terminate();
          continue;
        }
        client.alive = false;
        ws.ping(); // protocol ping — a live browser auto-pongs, flipping `alive` back
        // App-level beat too. The browser NEVER surfaces the protocol ping to
        // page JS, so a client cannot tell a silent-dead socket (sleep, network
        // partition — no FIN ever arrives) from an idle-but-healthy one on the
        // protocol ping alone. This visible frame is what the client's own
        // watchdog watches to decide to reconnect. Sent to every client,
        // subscribed or not; the client ignores it beyond noting liveness.
        send(ws, { type: 'ping' });
      }
    }, heartbeatMs);
    // Never the reason the process stays up — the HTTP server owns lifetime.
    heartbeat.unref?.();
  };

  const dropClient = (ws: WebSocket): void => {
    const client = clients.get(ws);
    if (!client) return;
    client.pending.clear();
    for (const topic of [...client.topics]) unsubscribe(ws, client, topic);
    clients.delete(ws);
  };

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, trusted?: boolean) => {
    // `trusted` is emitted by `handleUpgrade` from the upgrade verdict; default false is
    // the safe read for any path that reaches here without one.
    const client: ClientState = { alive: true, topics: new Set(), pending: new Map(), trusted: trusted === true, held: new Map() };
    clients.set(ws, client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        send(ws, { type: 'error', error: 'malformed frame: not JSON' });
        return;
      }
      const frame = clientFrameSchema.safeParse(parsed);
      if (!frame.success) {
        send(ws, { type: 'error', error: 'malformed frame: expected {type: subscribe|unsubscribe, topic}' });
        return;
      }
      if (frame.data.type === 'subscribe') subscribe(ws, client, frame.data.topic);
      else unsubscribe(ws, client, frame.data.topic);
    });
    ws.on('close', () => dropClient(ws));
    // A socket error is followed by `close`; the handler exists so ws never
    // throws it as an unhandled 'error' event.
    ws.on('error', () => undefined);
  });

  const hub: SocketHub = {
    registerTopic(name, publisher, options) {
      if (topics.has(name)) throw new Error(`ws topic already registered: ${name}`);
      if (familyOf(name)) throw new Error(`ws topic ${name} falls inside a registered topic family`);
      topics.set(name, {
        publisher,
        subscribers: new Set(),
        stop: null,
        loopbackReadable: options?.loopbackReadable ?? false,
        family: false,
      });
    },

    registerTopicFamily(prefix, resolve, options) {
      if (prefix.length === 0) throw new Error('ws topic family needs a prefix');
      const overlaps = (other: string) => other.startsWith(prefix) || prefix.startsWith(other);
      if (families.some((family) => overlaps(family.prefix)) || [...topics.keys()].some((name) => name.startsWith(prefix))) {
        throw new Error(`ws topic family overlaps a registration: ${prefix}`);
      }
      families.push({ prefix, resolve, loopbackReadable: options?.loopbackReadable ?? false });
    },

    handleUpgrade(req, socket, head, verdict) {
      if (closed) {
        socket.destroy();
        return;
      }
      if (!verdict) {
        socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      startHeartbeat();
      // Carry the verdict's trust flag onto the connection — `subscribe` reads
      // it to gate non-`loopbackReadable` topics.
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, verdict.trusted));
    },

    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const ws of [...clients.keys()]) {
        dropClient(ws); // stops publishers even if 'close' events never get to fire
        ws.terminate();
      }
      wss.close();
      for (const listener of [...closeListeners]) listener();
      closeListeners.clear();
    },

    onClose(listener) {
      if (closed) {
        listener();
        return () => undefined;
      }
      closeListeners.add(listener);
      return () => { closeListeners.delete(listener); };
    },
  };

  return hub;
}

/** The hub's route in the upgrade router: `WS_PATH`, under `verifyUpgrade`. */
export function socketHubRoute(hub: SocketHub, verifyUpgrade: (req: IncomingMessage) => WsUpgradeVerdict): UpgradeRoute {
  return {
    match: (pathname) => (pathname === WS_PATH ? {} : undefined),
    handle: (req, socket, head) => hub.handleUpgrade(req, socket, head, verifyUpgrade(req)),
  };
}
