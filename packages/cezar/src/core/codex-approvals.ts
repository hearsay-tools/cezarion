import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PermissionOption, UiPermissionRequestedEvent } from './ui-events.ts';

// Native app-server v2 shapes (Codex 0.160.1). Older servers omit startedAtMs;
// availableDecisions is also supported by the documented pre-0.160 wire.
const text = z.string().min(1);
const nullableText = z.string().nullable().optional();
const specialPath = z.union([
  z.object({ kind: z.enum(['root', 'minimal', 'tmpdir', 'slash_tmp']) }).passthrough(),
  z.object({ kind: z.literal('project_roots'), subpath: nullableText }).passthrough(),
  z.object({ kind: z.literal('unknown'), path: z.string(), subpath: nullableText }).passthrough(),
]);
const fileSystemPath = z.discriminatedUnion('type', [
  z.object({ type: z.literal('path'), path: z.string() }).passthrough(),
  z.object({ type: z.literal('glob_pattern'), pattern: z.string() }).passthrough(),
  z.object({ type: z.literal('special'), value: specialPath }).passthrough(),
]);
const permissionProfile = z.object({
  network: z.object({ enabled: z.boolean().nullable().optional() }).passthrough().nullable().optional(),
  fileSystem: z.object({
    read: z.array(z.string()).nullable().optional(),
    write: z.array(z.string()).nullable().optional(),
    entries: z.array(z.object({ access: z.enum(['read', 'write', 'deny']), path: fileSystemPath }).passthrough()).nullable().optional(),
    globScanMaxDepth: z.number().int().min(1).nullable().optional(),
  }).passthrough().nullable().optional(),
}).strict();
const networkAmendment = z.object({ action: z.enum(['allow', 'deny']), host: text }).passthrough();
const simpleDecision = z.enum(['accept', 'acceptForSession', 'decline', 'cancel']);
const commandDecision = z.union([
  simpleDecision,
  z.object({ acceptWithExecpolicyAmendment: z.object({ execpolicy_amendment: z.array(z.string()) }).passthrough() }).strict(),
  z.object({ applyNetworkPolicyAmendment: z.object({ network_policy_amendment: networkAmendment }).passthrough() }).strict(),
]);
const common = z.object({
  threadId: text, turnId: text, itemId: text,
  startedAtMs: z.number().int().optional(), reason: nullableText, environmentId: nullableText,
}).passthrough();
const commandParams = common.extend({
  command: nullableText, cwd: nullableText, approvalId: nullableText,
  kind: z.enum(['command', 'writeStdin']).optional(),
  commandActions: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('read'), command: z.string(), name: z.string(), path: z.string() }).passthrough(),
    z.object({ type: z.literal('listFiles'), command: z.string(), path: nullableText }).passthrough(),
    z.object({ type: z.literal('search'), command: z.string(), path: nullableText, query: nullableText }).passthrough(),
    z.object({ type: z.literal('unknown'), command: z.string() }).passthrough(),
  ])).nullable().optional(),
  networkApprovalContext: z.object({ host: text, protocol: z.enum(['http', 'https', 'socks5Tcp', 'socks5Udp']) }).passthrough().nullable().optional(),
  proposedExecpolicyAmendment: z.array(z.string()).nullable().optional(),
  proposedNetworkPolicyAmendments: z.array(networkAmendment).nullable().optional(),
  additionalPermissions: permissionProfile.nullable().optional(),
  availableDecisions: z.array(commandDecision).min(1).optional(),
});
const fileParams = common.extend({ grantRoot: nullableText, availableDecisions: z.array(simpleDecision).min(1).optional() });
const permissionsParams = common.extend({ cwd: z.string(), permissions: permissionProfile });

export interface CodexApproval {
  rpcId: number | string;
  turnId: string;
  event: UiPermissionRequestedEvent;
  /** No native payload crosses the human-input boundary. */
  responses: Map<string, Record<string, unknown>>;
}

export const CODEX_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
]);

export function codexApproval(method: string, rpcId: number | string, raw: unknown): CodexApproval | undefined {
  const schema = method === 'item/commandExecution/requestApproval' ? commandParams
    : method === 'item/fileChange/requestApproval' ? fileParams : permissionsParams;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return undefined;
  const params = parsed.data;
  const requestId = randomUUID();
  const options: PermissionOption[] = [];
  const responses = new Map<string, Record<string, unknown>>();
  const add = (label: string, kind: PermissionOption['kind'], result: Record<string, unknown>) => {
    const id = randomUUID();
    options.push({ id, label, kind }); responses.set(id, result);
  };
  if (method === 'item/permissions/requestApproval') {
    add('Allow requested permissions for this turn', 'allow_once', { permissions: params.permissions, scope: 'turn' });
    add('Allow requested permissions for this session', 'allow_always', { permissions: params.permissions, scope: 'session' });
    add('Decline requested permissions', 'reject_once', { permissions: {}, scope: 'turn' });
  } else {
    const decisions = (params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel']) as z.infer<typeof commandDecision>[];
    for (const decision of decisions) {
      if (decision === 'accept') add('Allow once', 'allow_once', { decision });
      else if (decision === 'acceptForSession') add(method === 'item/fileChange/requestApproval'
        ? 'Allow future changes to these files for this session' : 'Allow matching commands for this session', 'allow_always', { decision });
      else if (decision === 'decline') add('Decline and continue', 'reject_once', { decision });
      else if (decision === 'cancel') add('Cancel turn', 'reject_once', { decision });
      else if ('acceptWithExecpolicyAmendment' in decision) {
        add(`Allow and persist command rule: ${JSON.stringify(decision.acceptWithExecpolicyAmendment.execpolicy_amendment)}`, 'allow_always', { decision });
      } else {
        const rule = decision.applyNetworkPolicyAmendment.network_policy_amendment;
        add(`Persist network rule: ${rule.action} ${rule.host}`, rule.action === 'allow' ? 'allow_always' : 'reject_always', { decision });
      }
    }
  }
  return {
    rpcId, turnId: params.turnId, responses,
    event: { type: 'permission.requested', requestId, itemId: params.itemId,
      title: method === 'item/permissions/requestApproval' ? 'Codex requests additional permissions'
        : method === 'item/fileChange/requestApproval' ? 'Codex requests file changes'
          : params.networkApprovalContext ? 'Codex requests network access'
            : params.kind === 'writeStdin' ? 'Codex requests terminal input' : 'Codex requests command execution',
      // Retain all native context, including exact proposed rules and permission
      // paths. Never abbreviate an amendment into an ambiguous "always allow".
      details: JSON.stringify(raw, null, 2), options },
  };
}
