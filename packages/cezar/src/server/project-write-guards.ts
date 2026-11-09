import type { MiddlewareHandler } from 'hono';
import type { ProjectApiEnv } from './server.ts';

/** Logical deletion cannot expose a fallback copy. Legacy-only resource cleanup remains allowed. */
export function protectFallbackRun(kind: 'record' | 'worktree'): MiddlewareHandler<ProjectApiEnv> {
  return async (context, next) => {
    const id = context.req.param('id');
    const error = id && context.get('project').store.fallbackDeleteError(id, kind);
    if (error) return context.json({ error }, 409);
    return next();
  };
}
