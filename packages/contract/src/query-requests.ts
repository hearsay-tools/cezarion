import { z } from 'zod';
import { modelDiscoveryRunnerSchema } from './workspace.ts';

/**
 * Query schemas for the READ routes — deliberately permissive.
 *
 * These exist to make a query key VISIBLE to the route type (`hc` refuses a `query` argument for
 * a key no validator declares), NOT to narrow what the route accepts. Every one of these handlers
 * compares `=== '1'` and treats everything else as false, so `?refresh=0` is a successful request
 * today; a literal schema would silently turn it into a 400. The comparison stays in the handler
 * and the validator stays out of its way.
 *
 * The one route that really is strict on the wire — `GET /github/prs/:number/changes`, which 400s
 * on `?refresh=true` — keeps its own `z.enum(['1'])` schema next to the route.
 */
/**
 * One query value, matching what `c.req.query('k')` did before these routes were validated.
 *
 * Hono's query validator hands a REPEATED key as an array (`?wait=1&wait=1` → `['1','1']`), where
 * `c.req.query()` silently took the first. A plain `z.string()` therefore turns a request that
 * used to answer 200 into a 400 — a wire change no caller asked for. Collapsing to the first
 * value keeps the old behaviour, and the client still sees a plain `key?: string`.
 */
export const queryValue = z.union([z.string(), z.array(z.string()).transform((v) => v[0] as string)]).optional();

export const refreshQuery = z.object({ refresh: queryValue });

export const waitQuery = z.object({ wait: queryValue });

export const modelDiscoveryQuerySchema = z.object({ runner: z.union([z.string(), z.array(z.string()).transform((v) => v[0] as string)]).pipe(modelDiscoveryRunnerSchema) });

export const strictRefreshQuerySchema = z.object({ refresh: queryValue.refine((v) => v === undefined || v === '1') });

export const browseQuerySchema = z.object({ path: queryValue, showHidden: queryValue });

export const worktreeFilesQuerySchema = z.object({ path: queryValue, raw: queryValue });

export const commitQuerySchema = z.object({ structured: queryValue });
