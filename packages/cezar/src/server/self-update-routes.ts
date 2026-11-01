import { Hono } from 'hono';
import { selfUpdateApplyRequestSchema, selfUpdateChannelRequestSchema, selfUpdateDevelopmentQuerySchema } from '@open-mercato/cezar-contract/self-update';
import type { RunStore } from '../runs/store.ts';
import { SelfUpdateBusyError, SelfUpdateService } from '../self-update/service.ts';
import { jsonZodValidator, queryZodValidator } from './validators.ts';

/** The `createApp` dependency this family adds to `ServerDeps`. */
export interface SelfUpdateServerDeps {
  /** The cockpit's own updater (`/api/v1/workspace/self-update`, src/self-update/). Built by
   *  the CLI, which knows the entry file, the port and how to restart; absent in tests and for
   *  bare `createApp` callers, where the family answers a read-only "not available" status. */
  selfUpdate?: SelfUpdateService;
}

/** No injected updater (tests, embedded callers): a READ-ONLY service over the running entry.
 *  It has no way to restart the process, so it must not install either — an install that flips
 *  `current` under a process that keeps running the old code is the worst of both. */
function readOnlySelfUpdate(version: string, localHandoff: () => boolean): SelfUpdateService {
  return new SelfUpdateService({
    pkgName: '@wjarka/cezarion',
    version,
    entry: process.argv[1] ?? '',
    restart: () => {},
    readOnly: true,
    trimPaths: () => !localHandoff(),
  });
}

/**
 * The browser supplies a version STRING (validated shape, never a URL, a path or a tarball)
 * and a channel; the server resolves both against the npm registry and its own managed
 * layout. Allowed in hosted mode on purpose: an update pulls a published package from the
 * registry, so the request cannot inject code, and a VPS behind the installer's Basic auth
 * is exactly where "update from the cockpit" replaces `cezar server-deploy` — but hosted
 * applies are FORWARD-ONLY (see the guard on /apply below).
 */
export function createSelfUpdateRoutes(
  deps: SelfUpdateServerDeps & { version: string },
  /** False on a hosted cockpit: no checkout paths, registry releases only, forward-only applies. */
  localHandoff: () => boolean,
  /** Every open project's store: an update restarts the process under all of them. */
  stores: () => readonly RunStore[],
) {
  const selfUpdate = deps.selfUpdate ?? readOnlySelfUpdate(deps.version, localHandoff);
  const managedUpdateStatus = async (opts?: { refresh?: boolean }) => {
    const activeRuns = [...new Set(stores())].reduce((count, store) => count + store.listRuns().filter(run => ['queued', 'waiting', 'running'].includes(run.status)).length, 0);
    return { ...await selfUpdate.status({ ...opts, registryOnly: !localHandoff() }), activeRuns };
  };
  return new Hono()
    .get('/workspace/self-update', async (c) => c.json(await managedUpdateStatus()))

    .post('/workspace/self-update/refresh', async (c) => c.json(await managedUpdateStatus({ refresh: true })))

    // The development channel's pickers: cezar's own worktrees and its open PRs' preview builds.
    // A separate read because it costs a git call per worktree and a GitHub round trip.
    .get('/workspace/self-update/development', queryZodValidator(selfUpdateDevelopmentQuerySchema), async (c) =>
      c.json(await selfUpdate.development({ refresh: c.req.valid('query').refresh === '1' })),
    )

    .put('/workspace/self-update/channel', jsonZodValidator(selfUpdateChannelRequestSchema, { message: 'body must be { channel: "stable" | "nightly" | "development" }' }), async (c) => {
      const { channel } = c.req.valid('json');
      await selfUpdate.setChannel(channel);
      return c.json(await managedUpdateStatus());
    })

    .post('/workspace/self-update/apply', jsonZodValidator(selfUpdateApplyRequestSchema, { message: 'body must be { version }' }), async (c) => {
      const { version: target } = c.req.valid('json');
      // SECURITY: a hosted cockpit may only move FORWARD. Installing a published package cannot
      // inject code, but installing an OLDER one can: every hosted-mode guard — the `/api/*`
      // request-origin check (open-mercato/cezar#426), the `settingsAdmin` 409 that closes the agent-config hooks
      // RCE path — lives in the running version, so a downgrade to a release that predates them
      // re-opens exactly what they close, through a route those guards never get to see. A
      // local cockpit keeps the full picker, downgrades included: there is no boundary left to
      // escalate across when the caller already owns the machine. `forwardOnlyRefusal` decides
      // what "forward" means — publish time, not just semver order, because a nightly for the
      // next minor outranks every later patch of the current one.
      if (!localHandoff()) {
        const refusal = await selfUpdate.forwardOnlyRefusal(target);
        if (refusal) return c.json({ error: refusal }, 409);
      }
      try {
        selfUpdate.apply(target, { registryOnly: !localHandoff() });
      } catch (error) {
        if (error instanceof SelfUpdateBusyError) return c.json({ error: error.message }, 409);
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
      return c.json(await managedUpdateStatus());
    });
}
