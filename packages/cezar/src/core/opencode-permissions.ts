import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PermissionOption, UiPermissionRequestedEvent } from './ui-events.ts';

/**
 * The permissions behind OpenCode's own built-in asks (hearsay-tools/cezarion#1266). The 1.18.35
 * `build` agent ruleset asks for `doom_loop *`, `external_directory *`, `read *.env` and
 * `read *.env.*`; nobody configured those, so cezar answers them once. Every other ask came
 * from a rule the user wrote and goes to the cockpit.
 */
export const OPENCODE_DEFAULT_ASK_PERMISSIONS: ReadonlySet<string> = new Set(['external_directory', 'doom_loop', 'read']);

/** SSE `permission.asked` properties (OpenCode 1.18.35 `/doc` and a live probe, 2026-10-20). */
export const opencodePermissionAskSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  permission: z.string().min(1),
  patterns: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).optional(),
  always: z.array(z.string()).optional(),
  tool: z.object({ messageID: z.string(), callID: z.string() }).passthrough().optional(),
}).passthrough();
export type OpencodePermissionAsk = z.infer<typeof opencodePermissionAskSchema>;

export interface OpencodeUserPermissionRule {
  permission: string;
  pattern: string;
  action: string;
}

/**
 * The user's own permission rules, flattened from `GET /config`, which returns only
 * user-written config: `permission`, every `agent.<name>.permission` and every
 * `mode.<name>.permission`. `undefined` when the config is not an object at all, so
 * nothing can be said about where an ask came from.
 */
export function opencodeUserPermissionRules(config: unknown): OpencodeUserPermissionRule[] | undefined {
  if (!isRecord(config)) return undefined;
  const rules: OpencodeUserPermissionRule[] = [];
  const flatten = (permission: unknown): void => {
    if (typeof permission === 'string') {
      rules.push({ permission: '*', pattern: '*', action: permission });
      return;
    }
    if (!isRecord(permission)) return;
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === 'string') rules.push({ permission: key, pattern: '*', action: value });
      else if (isRecord(value)) {
        for (const [pattern, action] of Object.entries(value)) {
          if (typeof action === 'string') rules.push({ permission: key, pattern, action });
        }
      }
    }
  };
  flatten(config.permission);
  for (const section of [config.agent, config.mode]) {
    if (!isRecord(section)) continue;
    for (const entry of Object.values(section)) if (isRecord(entry)) flatten(entry.permission);
  }
  return rules;
}

/** OpenCode's `Wildcard.match`: anchored, `*` any run, `?` one character, across `/` too. */
export function opencodeWildcardMatch(value: string, pattern: string): boolean {
  const source = [...pattern].map((char) => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${source}$`, 's').test(value);
}

/**
 * An ask cezar may answer itself: a built-in permission no user rule names. A rule on the
 * permission key defers the ask whatever its pattern, which is stricter than OpenCode's own
 * pattern match. Unknown provenance (`rules` undefined) is never a default.
 */
export function isOpencodeDefaultAsk(ask: OpencodePermissionAsk, rules: readonly OpencodeUserPermissionRule[] | undefined): boolean {
  if (!rules || !OPENCODE_DEFAULT_ASK_PERMISSIONS.has(ask.permission)) return false;
  return !rules.some((rule) => opencodeWildcardMatch(ask.permission, rule.permission));
}

export type OpencodeReply = 'once' | 'always' | 'reject';

export interface OpencodePermissionBridge {
  nativeId: string;
  event: UiPermissionRequestedEvent;
  /** No native payload crosses the human-input boundary. */
  replies: Map<string, OpencodeReply>;
}

/** The cockpit request for an ask cezar does not answer itself, with opaque request and option ids. */
export function opencodePermissionBridge(ask: OpencodePermissionAsk): OpencodePermissionBridge {
  const options: PermissionOption[] = [];
  const replies = new Map<string, OpencodeReply>();
  const add = (label: string, kind: PermissionOption['kind'], reply: OpencodeReply) => {
    const id = randomUUID();
    options.push({ id, label, kind });
    replies.set(id, reply);
  };
  add('Allow once', 'allow_once', 'once');
  add('Allow always', 'allow_always', 'always');
  add('Reject', 'reject_once', 'reject');
  const { permission, patterns, always, metadata } = ask;
  return {
    nativeId: ask.id,
    replies,
    event: {
      type: 'permission.requested',
      requestId: randomUUID(),
      title: `OpenCode requests permission: ${permission}`,
      details: JSON.stringify({ permission, patterns, always, metadata }, null, 2),
      options,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
