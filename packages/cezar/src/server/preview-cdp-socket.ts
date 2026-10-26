import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { previewToolEnabled } from '../ci-wait/tools.ts';
import type { AgentCdpLink } from '../preview/cdp-proxy.ts';
import type { PreviewHost } from '../preview/host.ts';
import { isLoopbackHostHeader } from './capabilities.ts';
import { matchPath, type UpgradeRoute } from './upgrade-router.ts';

/**
 * The agent's CDP proxy socket (hearsay-tools/cezarion#784, spec 2026-10-26-preview-agent-cdp):
 * `CEZ_PREVIEW_CDP_URL` points here, and `agent-browser --cdp <url>` connects to it as it would to
 * Chromium's own browser endpoint. Workspace-level: the token alone names the run.
 *
 * Refused before the handshake: the feature off, a `Host` that is neither loopback nor the cockpit's
 * own bound origin (DNS rebinding), any `Origin` (a web page; an agent's CDP client sends none), and
 * a token no live session holds.
 */

export const PREVIEW_CDP_WS_PATHS = ['/api/v1/preview/cdp/:token'];

/** Same reaping cadence as the subscription hub and the pane socket. */
const HEARTBEAT_MS = 30_000;
/** A CDP command is small, but `Runtime.evaluate` can carry a whole script; Chrome itself takes far more. */
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
/** A WebSocket close reason holds at most 123 bytes. */
const MAX_REASON_BYTES = 123;

export type PreviewCdpHost = Pick<PreviewHost, 'hasAgentGrant' | 'connectAgent'>;

export interface PreviewCdpSocketDeps {
  /** Absent when `CEZ_PREVIEW` was off at boot: the path answers 404. */
  host?: PreviewCdpHost | undefined;
  /** The cockpit's bound origin (`CEZ_COCKPIT_URL`), whose host the agent's address names. */
  cockpitOrigin?: () => string | undefined;
  heartbeatMs?: number;
}

export interface PreviewCdpSocket {
  route: UpgradeRoute;
  /** Terminates every open agent socket. Idempotent. */
  close(): void;
}

function reject(socket: Duplex, status: 403 | 404): void {
  socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Not Found'}\r\nconnection: close\r\n\r\n`);
  socket.destroy();
}

function reasonOf(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= MAX_REASON_BYTES ? text : bytes.subarray(0, MAX_REASON_BYTES).toString('utf8').replace(/�+$/, '');
}

export function createPreviewCdpSocket(deps: PreviewCdpSocketDeps): PreviewCdpSocket {
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
  const open = new Set<WebSocket>();
  let closed = false;

  const connected = (ws: WebSocket, host: PreviewCdpHost, token: string): void => {
    open.add(ws);
    let alive = true;
    let link: AgentCdpLink | undefined;
    let gone = false;
    // Commands sent before the browser is ready wait here, in order.
    const early: string[] = [];
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, heartbeatMs);
    beat.unref?.();
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const text = String(raw);
      if (link) link.fromClient(text);
      else early.push(text);
    });
    ws.on('close', () => {
      gone = true;
      clearInterval(beat);
      open.delete(ws);
      link?.close();
    });
    // A socket error is followed by `close`; without a listener ws would throw it.
    ws.on('error', () => undefined);
    void host
      .connectAgent(token, {
        send: text => {
          if (ws.readyState === 1) ws.send(text);
        },
        close: (code, reason) => ws.close(code, reasonOf(reason)),
      })
      .then(result => {
        if ('refused' in result) return ws.close(1008, reasonOf(result.refused));
        if (gone) return result.close();
        link = result;
        for (const text of early.splice(0)) result.fromClient(text);
      })
      .catch(() => ws.close(1011, 'The preview browser is not available'));
  };

  const allowedHost = (host: string | undefined): boolean => {
    if (isLoopbackHostHeader(host)) return true;
    const origin = deps.cockpitOrigin?.();
    try {
      return !!host && !!origin && new URL(origin).host === host;
    } catch {
      return false;
    }
  };

  const handle = (req: IncomingMessage, socket: Duplex, head: Buffer, params: Record<string, string>): void => {
    socket.on('error', () => socket.destroy());
    const host = deps.host;
    if (closed || !host || !previewToolEnabled()) return reject(socket, 404);
    if (!allowedHost(req.headers.host) || req.headers.origin !== undefined) return reject(socket, 403);
    const token = params.token;
    if (!token || !host.hasAgentGrant(token)) return reject(socket, 403);
    wss.handleUpgrade(req, socket, head, ws => connected(ws, host, token));
  };

  return {
    route: {
      match: matchPath(PREVIEW_CDP_WS_PATHS),
      handle,
    },
    close() {
      if (closed) return;
      closed = true;
      for (const ws of [...open]) ws.terminate();
      wss.close();
    },
  };
}
