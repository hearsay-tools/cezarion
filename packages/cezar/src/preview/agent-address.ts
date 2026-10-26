import { existsSync } from 'node:fs';
import { previewToolEnabled } from '../ci-wait/tools.ts';
import type { AgentGrant, RunContext } from './host.ts';
import type { PreviewHostLike } from './registration.ts';

/**
 * The agent's preview browser address (hearsay-tools/cezarion#784, spec
 * 2026-10-26-preview-agent-cdp): the cockpit's own bound origin as `ws:`, at the CDP proxy route,
 * with the grant's token. Undefined when the origin is not a URL.
 */
export function previewCdpUrl(cockpitOrigin: string, token: string): string | undefined {
  let address: URL;
  try {
    address = new URL(cockpitOrigin);
  } catch {
    return undefined;
  }
  address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
  address.pathname = `/api/v1/preview/cdp/${token}`;
  address.search = address.hash = '';
  return address.toString();
}

/**
 * A session's tool capability with the CDP address added: `CEZ_PREVIEW_CDP_URL` joins its env, and
 * its `revoke` also revokes the grant, so every site that ends the tools closes the agent's browser
 * sockets too.
 */
export function withPreviewCdp<S extends { env: Record<string, string>; revoke(): void }>(session: S, grant: AgentGrant, cockpitOrigin: string): S {
  const url = previewCdpUrl(cockpitOrigin, grant.token);
  if (!url) {
    grant.revoke();
    return session;
  }
  return { ...session, env: { ...session.env, CEZ_PREVIEW_CDP_URL: url }, revoke: () => { session.revoke(); grant.revoke(); } };
}

/**
 * `withPreviewCdp` behind its gate: only with `CEZ_PREVIEW=1`, a host that can grant, a cockpit
 * origin (none under `cez run`) and a worktree. Every runner's session goes through here, so the
 * harness parity cell R125 reads the same decision RunManager makes.
 */
export function previewCdpSession<S extends { env: Record<string, string>; revoke(): void }>(
  session: S,
  opts: { host?: Pick<PreviewHostLike, 'grantAgent'> | undefined; cockpitOrigin?: string | undefined; runId: string; worktree: boolean; context: () => RunContext | undefined },
): S {
  if (!previewToolEnabled() || !opts.host?.grantAgent || !opts.cockpitOrigin || !opts.worktree) return session;
  return withPreviewCdp(session, opts.host.grantAgent(opts.runId, opts.context), opts.cockpitOrigin);
}

/** The preview host's view of a run with a live worktree, read when the agent connects. */
export function previewRunContext(store: RunContext['store'], dataDir: string, runId: string): RunContext | undefined {
  const run = store.getRun(runId);
  if (!run?.worktreePath || !existsSync(run.worktreePath)) return undefined;
  return { runId, title: run.title, worktreePath: run.worktreePath, dataDir, store };
}
