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
  availableDecisions: z.array(commandDecision).min(1).nullable().optional(),
});
const fileParams = common.extend({ grantRoot: nullableText, availableDecisions: z.array(simpleDecision).min(1).optional() });
const permissionsParams = common.extend({ cwd: z.string(), permissions: permissionProfile });
// hearsay-tools/cezarion#1294: Codex asks before an MCP tool call with an elicitation
// (codex-rs/core/src/mcp_tool_call.rs). Like Codex's own TUI, read one as a tool approval
// only when its kind says so and its form asks for nothing; elicitations carry no item id.
const messageOnlySchema = z.object({ type: z.literal('object'), properties: z.object({}).strict() }).passthrough().nullish();
const mcpToolParams = z.object({
  threadId: text, turnId: text, serverName: text, mode: z.literal('form'), message: z.string(), requestedSchema: messageOnlySchema,
  _meta: z.object({ codex_approval_kind: z.literal('mcp_tool_call'), persist: z.union([z.string(), z.array(z.string())]).optional() }).passthrough(),
}).passthrough();

export interface CodexApproval {
  rpcId: number | string;
  turnId: string;
  event: UiPermissionRequestedEvent;
  /** No native payload crosses the human-input boundary. */
  responses: Map<string, Record<string, unknown>>;
}

const CODEX_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
]);
const MCP_ELICITATION_METHOD = 'mcpServer/elicitation/request';

/** True for a request cezar answers as an approval; every other elicitation stays unsupported. */
export function isCodexApprovalRequest(method: string, raw: unknown): boolean {
  if (CODEX_APPROVAL_METHODS.has(method)) return true;
  if (method !== MCP_ELICITATION_METHOD || !raw || typeof raw !== 'object') return false;
  const { mode, _meta: meta, requestedSchema } = raw as Record<string, unknown>;
  return mode === 'form' && !!meta && typeof meta === 'object' && (meta as Record<string, unknown>).codex_approval_kind === 'mcp_tool_call'
    && messageOnlySchema.safeParse(requestedSchema).success;
}

function offer() {
  const options: PermissionOption[] = [];
  const responses = new Map<string, Record<string, unknown>>();
  const add = (label: string, kind: PermissionOption['kind'], result: Record<string, unknown>) => {
    const id = randomUUID();
    options.push({ id, label, kind }); responses.set(id, result);
  };
  return { options, responses, add };
}

/** `cezarServer` is the run's own MCP server, which is never worth a saved rule. */
export function codexApproval(method: string, rpcId: number | string, raw: unknown, cezarServer?: string): CodexApproval | undefined {
  if (method === MCP_ELICITATION_METHOD) return mcpToolApproval(rpcId, raw, cezarServer);
  const schema = method === 'item/commandExecution/requestApproval' ? commandParams
    : method === 'item/fileChange/requestApproval' ? fileParams : permissionsParams;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return undefined;
  const params = parsed.data;
  const requestId = randomUUID();
  const { options, responses, add } = offer();
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
  const { threadId: _threadId, turnId: _turnId, itemId: _itemId, approvalId: _approvalId, startedAtMs: _startedAtMs, availableDecisions: _availableDecisions, ...details } = params;
  const scopedDecisions = Array.isArray(_availableDecisions) ? _availableDecisions.filter(decision => typeof decision === 'object') : [];
  return {
    rpcId, turnId: params.turnId, responses,
    event: { type: 'permission.requested', requestId, itemId: params.itemId,
      title: method === 'item/permissions/requestApproval' ? 'Codex requests additional permissions'
        : method === 'item/fileChange/requestApproval' ? 'Codex requests file changes'
          : params.networkApprovalContext ? 'Codex requests network access'
            : params.kind === 'writeStdin' ? 'Codex requests terminal input' : 'Codex requests command execution',
      // Retain action context, including exact proposed rules and permission
      // paths. Never abbreviate an amendment into an ambiguous "always allow".
      details: JSON.stringify({ ...details, ...(scopedDecisions.length ? { availableDecisions: scopedDecisions } : {}) }, null, 2), options },
  };
}

function mcpToolApproval(rpcId: number | string, raw: unknown, cezarServer: string | undefined): CodexApproval | undefined {
  const parsed = mcpToolParams.safeParse(raw);
  if (!parsed.success) return undefined;
  const { serverName, message, turnId, _meta: { codex_approval_kind: _kind, persist, tool_params_display: _display, ...meta } } = parsed.data;
  const remembers = new Set(typeof persist === 'string' ? [persist] : persist ?? []);
  const { options, responses, add } = offer();
  // The reply shapes Codex's own TUI sends; a remembered scope rides in `_meta.persist`.
  add('Allow once', 'allow_once', { action: 'accept', content: null, _meta: null });
  if (remembers.has('session')) add('Allow this tool for this session', 'allow_always', { action: 'accept', content: null, _meta: { persist: 'session' } });
  // `always` saves an approve rule in the user's Codex config. cezar's server name is per run.
  if (remembers.has('always') && serverName !== cezarServer) {
    add('Always allow this tool (saved in your Codex config)', 'allow_always', { action: 'accept', content: null, _meta: { persist: 'always' } });
  }
  // Codex reads `cancel` as the same skipped call, so one refusal is enough.
  add('Decline and continue', 'reject_once', { action: 'decline', content: null, _meta: null });
  return {
    rpcId, turnId, responses,
    event: { type: 'permission.requested', requestId: randomUUID(), title: 'Codex requests an MCP tool call',
      details: JSON.stringify({ server: serverName, message, ...meta }, null, 2), options },
  };
}
