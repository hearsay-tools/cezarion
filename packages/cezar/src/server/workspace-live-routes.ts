import { Hono } from 'hono';
import { createHomeRecoveryRoutes } from './home-recovery-routes.ts';
import { createLiveRoutes } from './live-routes.ts';

/** Workspace-only live families share the single mount and its trust boundary. */
export function createWorkspaceLiveRoutes(
  live: Parameters<typeof createLiveRoutes>[0],
  recovery: Parameters<typeof createHomeRecoveryRoutes>[0],
) {
  return new Hono().route('/', createLiveRoutes(live)).route('/', createHomeRecoveryRoutes(recovery));
}
