import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { previewClientMessageSchema, type PreviewServerMessage } from '@open-mercato/cezar-contract';
import { WebSocketServer, type WebSocket } from 'ws';
import { previewToolEnabled } from '../ci-wait/tools.ts';
import type { PreviewHost, RunContext } from '../preview/host.ts';
import type { Viewer } from '../preview/session.ts';
import { PROJECT_ID_RE } from '../workspace/config.ts';
import { matchPath, type UpgradeRoute } from './upgrade-router.ts';
import type { WsUpgradeVerdict } from './ws.ts';

/**
 * The preview pane's WebSocket (#781, spec 2026-10-02-live-preview-v1 "WebSocket"):
 * `/api/v1/p/:projectId/runs/:id/preview/ws` and the boot alias `/api/v1/runs/:id/preview/ws`.
 * A named exception to the one-socket-per-cockpit rule of the subscription bus: one socket per
 * open pane, carrying that viewer's JPEG frames down and the contract's input vocabulary up.
 *
 * Every refusal happens before the handshake: flag off → 404, the request-origin guard refuses or
 * admits only as untrusted → 403 (a foreign page on another loopback port must never see a task's
 * page), unknown project or run → 404. A run whose worktree is gone completes the handshake and is
 * told so, because that is a state the pane renders (5.15), not an error.
 */

export const PREVIEW_WS_PATHS = ['/api/v1/p/:projectId/runs/:id/preview/ws', '/api/v1/runs/:id/preview/ws'];

/** Same reaping cadence as the subscription hub. */
const HEARTBEAT_MS = 30_000;
/** Input frames are small; a paste through `insertText` is the largest legitimate one. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

export type PreviewSocketHost = Pick<PreviewHost, 'handle' | 'detach'>;

export type PreviewSocketProject = { store: RunContext['store']; dataDir: string };

export interface PreviewSocketDeps {
  /** Absent when `CEZ_PREVIEW` was off at boot: the path answers 404. */
  host?: PreviewSocketHost;
  verify: (req: IncomingMessage) => WsUpgradeVerdict;
  /** `undefined` is the boot project. An unknown or unusable project resolves to undefined. */
  resolveProject: (projectId: string | undefined) => Promise<PreviewSocketProject | undefined>;
  heartbeatMs?: number;
  log?: (line: string) => void;
}

export interface PreviewSocket {
  route: UpgradeRoute;
  /** Terminates every open pane socket. Idempotent. */
  close(): void;
}

function reject(socket: Duplex, status: 403 | 404): void {
  socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Not Found'}\r\nconnection: close\r\n\r\n`);
  socket.destroy();
}

export function createPreviewSocket(deps: PreviewSocketDeps): PreviewSocket {
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const open = new Set<WebSocket>();
  let closed = false;

  const connected = (ws: WebSocket, req: IncomingMessage, ctx: RunContext | undefined): void => {
    open.add(ws);
    let alive = true;
    let warned = false;
    const send = (msg: PreviewServerMessage) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    };
    const viewer: Viewer = {
      userAgent: req.headers['user-agent'] ?? 'another tab',
      send,
      sendFrame: (buf) => {
        if (ws.readyState === 1) ws.send(buf, { binary: true });
      },
      close: (code, reason) => ws.close(code, reason),
    };
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, heartbeatMs);
    beat.unref?.();
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('close', () => {
      clearInterval(beat);
      open.delete(ws);
      if (ctx) deps.host?.detach(ctx.runId, viewer);
    });
    // A socket error is followed by `close`; without a listener ws would throw it.
    ws.on('error', () => undefined);
    if (!ctx) {
      send({ t: 'state', stage: 'worktree-removed' });
      return;
    }
    ws.on('message', (raw, isBinary) => {
      let parsed: unknown;
      try {
        parsed = isBinary ? undefined : JSON.parse(String(raw));
      } catch { /* not JSON: dropped below */ }
      const msg = previewClientMessageSchema.safeParse(parsed);
      if (!msg.success) {
        if (!warned) log(`preview ${ctx.runId}: dropped an invalid client message`);
        warned = true;
        return;
      }
      void deps.host?.handle(ctx, viewer, msg.data).catch(() => undefined);
    });
  };

  const handle = async (req: IncomingMessage, socket: Duplex, head: Buffer, params: Record<string, string>): Promise<void> => {
    // The socket may close while the project resolves; ws must not see an unhandled 'error'.
    socket.on('error', () => socket.destroy());
    const host = deps.host;
    if (closed || !host || !previewToolEnabled()) return reject(socket, 404);
    const verdict = deps.verify(req);
    if (!verdict || !verdict.trusted) return reject(socket, 403);
    const { projectId, id } = params;
    if (projectId !== undefined && !PROJECT_ID_RE.test(projectId)) return reject(socket, 404);
    const project = await deps.resolveProject(projectId).catch(() => undefined);
    const run = id === undefined ? undefined : project?.store.getRun(id);
    if (!project || !run) return reject(socket, 404);
    if (socket.destroyed) return;
    const ctx: RunContext | undefined = run.worktreePath && existsSync(run.worktreePath)
      ? { runId: run.id, title: run.title, worktreePath: run.worktreePath, dataDir: project.dataDir, store: project.store }
      : undefined;
    wss.handleUpgrade(req, socket, head, (ws) => connected(ws, req, ctx));
  };

  return {
    route: {
      match: matchPath(PREVIEW_WS_PATHS),
      handle: (req, socket, head, params) => void handle(req, socket, head, params),
    },
    close() {
      if (closed) return;
      closed = true;
      for (const ws of [...open]) ws.terminate();
      wss.close();
    },
  };
}
