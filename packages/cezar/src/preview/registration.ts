import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { PreviewResultCode, PreviewServeRequest, PreviewServeResult, PreviewServer } from '@open-mercato/cezar-contract';
import { previewRefusal } from '../ci-wait/errors.ts';

/**
 * Registration semantics for `cezar_preview_serve` (#781, spec 2026-10-02-live-preview-v1): which
 * code a request earns, and the message and recovery hint the agent reads back. Pure: the run
 * manager supplies the run's state and the host's view of the port.
 */

export const PREVIEW_MAX_SERVERS = 8;

/** What registration needs from the workspace-wide preview host; `PreviewHost` implements it. */
export interface PreviewHostLike {
  /** The task whose dev server holds `port`, across every project. */
  portOwner(port: number): { runId: string; title: string } | undefined;
  /** One TCP probe: does anything answer on `port` now? */
  probe(port: number): Promise<boolean>;
}

export type PreviewRegistrationInput = {
  request: PreviewServeRequest;
  worktreePath?: string;
  cezarPort?: number;
  existing: PreviewServer[];
  owner?: { runId: string; title: string };
  runId: string;
  enabled: boolean;
  headless: boolean;
};

/**
 * The first refusal that applies, else `registered` or `replaced` with the entry to store.
 * `answeredAtRegistration` is `false` here; the caller records its own probe.
 */
export function validateRegistration(input: PreviewRegistrationInput): { code: PreviewResultCode; server?: PreviewServer } {
  const { request } = input;
  if (!input.enabled) return { code: 'preview_disabled' };
  if (input.headless) return { code: 'headless' };
  if (!input.worktreePath) return { code: 'worktree_missing' };
  let cwd: string | undefined;
  if (request.cwd !== undefined) {
    if (isAbsolute(request.cwd)) return { code: 'cwd_outside_worktree' };
    const inside = relative(input.worktreePath, resolve(input.worktreePath, request.cwd));
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { code: 'cwd_outside_worktree' };
    cwd = inside || undefined;
  }
  if (request.port === input.cezarPort) return { code: 'cezar_port' };
  if (input.owner && input.owner.runId !== input.runId) return { code: 'port_held' };
  const replaced = input.existing.some(server => server.port === request.port);
  if (!replaced && input.existing.length >= PREVIEW_MAX_SERVERS) return { code: 'too_many' };
  const server: PreviewServer = {
    port: request.port,
    command: request.command,
    ...(cwd ? { cwd } : {}),
    label: request.label ?? request.command.trim().split(/\s+/)[0]!,
    ...(request.path ? { path: request.path } : {}),
    registeredAt: new Date().toISOString(),
    answeredAtRegistration: false,
  };
  return { code: replaced ? 'replaced' : 'registered', server };
}

/** What the agent called with, plus the holder's title for `port_held`. Never a path or an env value. */
export type PreviewHintContext = { command: string; port: number; label?: string; ownerTitle?: string };

const EXAMPLE_CALL = '{ "command": "npm run dev -- --port 5173 --strictPort", "port": 5173 }';

/** The spec's "Every result carries a recovery hint" table: the agent's next step, in one sentence or two. */
export function previewHint(code: PreviewResultCode, ctx: PreviewHintContext): string {
  switch (code) {
    case 'registered':
    case 'replaced':
      return `Continue your work. Cezar runs \`${ctx.command}\` in the worktree when the user approves it from the preview; a copy you already run on \`:${ctx.port}\` is reused while it answers, and it stops when your session ends. Call again only if the command or port changes. Do not wait for the user to open it.`;
    case 'invalid_input': return `A valid call: ${EXAMPLE_CALL}. Fix the field and call again.`;
    case 'cwd_outside_worktree': return 'Pass a path relative to the worktree root, e.g. `"apps/web"`, or omit `cwd`.';
    case 'cezar_port': return 'Register your app\'s dev server port, not the cockpit\'s.';
    case 'port_held': {
      const free = ctx.port === 5180 ? 5181 : 5180;
      return `Task "${ctx.ownerTitle ?? 'another task'}" holds \`:${ctx.port}\`. Start your server on a free port (e.g. \`--port ${free} --strictPort\`) and register that port. Do not stop the other task's server.`;
    }
    case 'too_many': return 'Re-register an existing port to replace it instead of adding a new one.';
    case 'worktree_missing': return 'Do not retry.';
    case 'preview_disabled':
    case 'headless':
    case 'unavailable':
      return previewRefusal(code).hint;
  }
}

function previewMessage(code: PreviewResultCode, ctx: PreviewHintContext): string {
  switch (code) {
    case 'registered': return `Registered \`:${ctx.port}\` (${ctx.label ?? ctx.command.trim().split(/\s+/)[0]}) for this task.`;
    case 'replaced': return `Replaced the registration for \`:${ctx.port}\`.`;
    case 'invalid_input': return 'The arguments are invalid.';
    case 'cwd_outside_worktree': return '`cwd` resolves outside the worktree.';
    case 'cezar_port': return `\`:${ctx.port}\` is cezar's own port.`;
    case 'port_held': return `\`:${ctx.port}\` is held by the dev server of task "${ctx.ownerTitle ?? 'another task'}".`;
    case 'too_many': return `This task already has ${PREVIEW_MAX_SERVERS} registered servers.`;
    case 'worktree_missing': return 'This task\'s worktree no longer exists.';
    case 'preview_disabled':
    case 'headless':
    case 'unavailable':
      return previewRefusal(code).message;
  }
}

/** The tool's whole answer for `code`. */
export function previewResult(code: PreviewResultCode, ctx: PreviewHintContext): PreviewServeResult {
  return { ok: code === 'registered' || code === 'replaced', code, message: previewMessage(code, ctx), hint: previewHint(code, ctx) };
}
