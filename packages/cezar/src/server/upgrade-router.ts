import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * The HTTP server's one `upgrade` listener (#781, spec 2026-10-02-live-preview-v1 "WebSocket").
 * Each WebSocket endpoint is a route; the first whose `match` returns params handles the upgrade,
 * and an unmatched path is destroyed. Upgrade-only endpoints never reach Hono, so each one is
 * inventoried by hand in BACKWARD_COMPATIBILITY.md §2.
 */

export interface UpgradeRoute {
  /** Path params when `pathname` is this route's, else undefined. */
  match(pathname: string): Record<string, string> | undefined;
  handle(req: IncomingMessage, socket: Duplex, head: Buffer, params: Record<string, string>): void;
}

/** The server surface the router needs: the `http.Server` that `serve()` returns has it. */
export interface UpgradeCapableServer {
  on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export function attachUpgradeRouter(server: UpgradeCapableServer, routes: readonly UpgradeRoute[]): void {
  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      // `req.url` on an upgrade is the path (+query); the base only satisfies URL parsing.
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    for (const route of routes) {
      const params = route.match(pathname);
      if (params) return route.handle(req, socket, head, params);
    }
    // With an `upgrade` listener installed, Node no longer destroys unhandled upgrades.
    socket.destroy();
  });
}

/**
 * A `match` for one or more `/a/:param/b` patterns. A param is one non-empty segment, decoded;
 * one that does not decode is no match.
 */
export function matchPath(patterns: readonly string[]): UpgradeRoute['match'] {
  const compiled = patterns.map(pattern => pattern.split('/'));
  return pathname => {
    const parts = pathname.split('/');
    for (const segments of compiled) {
      if (segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const matched = segments.every((segment, i) => {
        const part = parts[i]!;
        if (!segment.startsWith(':')) return segment === part;
        if (!part) return false;
        try {
          params[segment.slice(1)] = decodeURIComponent(part);
          return true;
        } catch {
          return false;
        }
      });
      if (matched) return params;
    }
    return undefined;
  };
}
