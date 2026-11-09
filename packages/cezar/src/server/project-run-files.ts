import { artifactDirectory } from '../artifacts/store.ts';
import type { RunStore } from '../runs/store.ts';
import type { MiddlewareHandler } from 'hono';
import { delegationFailure } from '../delegation/routes.ts';
import { DelegationPolicyError } from '../delegation/policy.ts';
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

/**
 * The one explicit write that copies a family read from `.ai/squawk/` into this store, before
 * `requireRunControl` applies ownership. View state (`read`, `unread`) and record deletion never
 * adopt: they are refused instead. A live process of the migrating binary answers 409.
 */
export const adoptFallbackControl: MiddlewareHandler<ProjectApiEnv> = async (context, next) => {
  const id = context.req.param('id');
  const { method, path } = context.req;
  if (method === 'GET' || method === 'HEAD' || id === undefined || /\/(?:read|unread)$/.test(path) || (method === 'DELETE' && path.endsWith(`/runs/${id}`))) return next();
  const store = context.get('project').store;
  if (store.runOwnership(id) !== 'fallback') return next();
  try { store.adoptFallbackFamily(id); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The delegation route answers in the delegation error shape, as `requireRunControl` does.
    if (path.endsWith('/worker-destroy')) return context.json(delegationFailure(new DelegationPolicyError('incompatible_state', message)).body, 409);
    return context.json({ error: message }, 409);
  }
  return next();
};

/** All artifact routes bind their reads to the directory that owns the selected run. */
export function runArtifactDirectory(store: Pick<RunStore, 'sourceDataDir'>, runId: string): string {
  return artifactDirectory(store.sourceDataDir(runId), runId);
}
