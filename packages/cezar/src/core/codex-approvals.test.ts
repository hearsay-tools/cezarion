import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { UiEvent } from './ui-events.ts';
import { codexApproval, isCodexApprovalRequest } from './codex-approvals.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';

const bin = fileURLToPath(new URL('../../scripts/mock-codex-app-server.mjs', import.meta.url));

describe('Codex approvals over the native mock wire (hearsay-tools/cezarion#1049)', () => {
  it('shows action and scope details without transport bookkeeping', () => {
    const approval = codexApproval('item/commandExecution/requestApproval', 5, { threadId: 'thread-secret-id', turnId: 'turn-secret-id', itemId: 'item-secret-id', startedAtMs: 1, command: 'git status --short', cwd: '/repo', reason: 'Network is restricted', availableDecisions: ['decline'], additionalPermissions: { network: { enabled: true } } })!;
    expect(approval.event.details).toContain('git status --short');
    expect(approval.event.details).toContain('/repo');
    expect(approval.event.details).toContain('Network is restricted');
    expect(approval.event.details).toContain("\"enabled\": true");
    expect(approval.event.details).not.toContain('secret-id');
    expect(approval.event.details).not.toContain('availableDecisions');
    expect(approval.event.details).not.toContain('startedAtMs');
  });

  it.each(['accept', 'decline', 'cancel'])('waits for an explicit %s response and echoes the exact native reply', async decision => {
    const ui: UiEvent[] = [];
    const session = new CodexAppServerRunner({ bin, timeoutMs: 0 }).startSession({ toolGrant: UNSET_TOOL_GRANT, cwd: process.cwd(), userPrompt: 'mock:approval' }, undefined,
      { onUiEvent: event => ui.push(event) });
    try {
      // bound: wait for the native permission request to reach the UI mapper.
      await vi.waitFor(() => expect(ui.some(e => e.type === 'permission.requested')).toBe(true), { timeout: 10_000 });
      expect(ui.some(e => e.type === 'turn.completed')).toBe(false);
      const event = ui.find(e => e.type === 'permission.requested')!;
      expect(session.sendMessage([{ type: 'text', text: 'accept' }])).toBe(false);
      expect(session.sendAgentMessage([{ type: 'text', text: 'accept' }])).toBe(false);
      const index = decision === 'accept' ? 0 : decision === 'decline' ? 2 : 3;
      expect(session.respondPermission?.(event.requestId, event.options[index]!.id)).toBe(true);
      // bound: wait for the fixture's native process receipt on a loaded host.
      await vi.waitFor(() => expect(ui.some(e => e.type === 'turn.completed')).toBe(true), { timeout: 10_000 });
      session.end();
      // The mock then calls cezar_done; a bare session has no tool controller, so only its first line is the echo.
      expect((await session.result).text.split('\n')[0]).toBe(`Approval response: ${JSON.stringify({ decision })}`);
      expect(ui).toContainEqual({ type: 'permission.resolved', requestId: event.requestId, optionId: event.options[index]!.id });
    } finally { session.interrupt(); await session.result; }
  });

  // hearsay-tools/cezarion#1294: Codex 0.160.1 asks before an MCP tool call with an elicitation.
  const mcpReplies = [
    ['Allow once', 'allow_once', { action: 'accept', content: null, _meta: null }],
    ['Allow this tool for this session', 'allow_always', { action: 'accept', content: null, _meta: { persist: 'session' } }],
    ['Always allow this tool (saved in your Codex config)', 'allow_always', { action: 'accept', content: null, _meta: { persist: 'always' } }],
    ['Decline and continue', 'reject_once', { action: 'decline', content: null, _meta: null }],
  ] as const;
  // A hang guard only: each wait ends on the runner's own UI event.
  const seen = (ui: UiEvent[], type: UiEvent['type']) => vi.waitFor(() => expect(ui.some(e => e.type === type)).toBe(true), { timeout: 15_000 });
  const mcpSession = (userPrompt: string, ui: UiEvent[]) => new CodexAppServerRunner({ bin, timeoutMs: 0 }).startSession({ toolGrant: UNSET_TOOL_GRANT, cwd: process.cwd(), userPrompt,
    cezarTools: { name: 'cezar_ci_test', command: 'node', args: ['/never/started.mjs'] } }, undefined, { onUiEvent: event => ui.push(event) });

  it.each(mcpReplies)('asks before another server\'s MCP tool and %s reaches Codex exactly', async (label, kind, reply) => {
    const ui: UiEvent[] = [];
    const session = mcpSession('mock:mcp-approval', ui);
    try {
      await seen(ui, 'permission.requested');
      const event = ui.find(e => e.type === 'permission.requested')!;
      expect(event.title).toBe('Codex requests an MCP tool call');
      expect(event.options.map(option => [option.label, option.kind])).toEqual(mcpReplies.map(([l, k]) => [l, k]));
      expect(JSON.parse(event.details!)).toEqual({ server: 'docs', message: 'Allow the docs MCP server to run tool "search"?',
        tool_description: 'Mock search tool.', tool_params: { query: 'cezar' } });
      expect(session.sendMessage([{ type: 'text', text: 'accept' }])).toBe(false);
      const option = event.options.find(candidate => candidate.label === label)!;
      expect(session.respondPermission?.(event.requestId, option.id)).toBe(true);
      await seen(ui, 'turn.completed');
      session.end();
      expect((await session.result).text.split('\n')[0]).toBe(`Approval response: ${JSON.stringify(reply)}`);
      expect(ui).toContainEqual({ type: 'permission.resolved', requestId: event.requestId, optionId: option.id });
      expect(kind).toBe(option.kind);
    } finally { session.interrupt(); await session.result; }
  });

  it('asks before cezar\'s own tool when Codex still does, without saving a rule for its per-run server', async () => {
    const ui: UiEvent[] = [];
    const session = mcpSession('mock:mcp-approval-own', ui);
    try {
      await seen(ui, 'permission.requested');
      const event = ui.find(e => e.type === 'permission.requested')!;
      expect(JSON.parse(event.details!).server).toBe('cezar_ci_test');
      expect(event.options.map(option => option.label)).toEqual(['Allow once', 'Allow this tool for this session', 'Decline and continue']);
    } finally { session.interrupt(); await session.result; }
  });

  const toolApproval = (requestedSchema: unknown) => ({ threadId: 'thread-1', turnId: 'turn-1', serverName: 'docs', mode: 'form',
    message: 'Allow the docs MCP server to run tool "search"?', _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
    ...(requestedSchema === undefined ? {} : { requestedSchema }) });

  it.each([['absent', undefined], ['null', null], ['an object without properties', { type: 'object' }], ['empty properties', { type: 'object', properties: {} }]])(
    'reads a form whose schema is %s as a tool approval', (_shape, requestedSchema) => {
      expect(isCodexApprovalRequest('mcpServer/elicitation/request', toolApproval(requestedSchema))).toBe(true);
      expect(codexApproval('mcpServer/elicitation/request', 1, toolApproval(requestedSchema))?.event.title).toBe('Codex requests an MCP tool call');
    });

  it('leaves a form that asks for input to the unsupported-request answer', () => {
    const form = toolApproval({ type: 'object', properties: { reason: { type: 'string' } } });
    expect(isCodexApprovalRequest('mcpServer/elicitation/request', form)).toBe(false);
    expect(codexApproval('mcpServer/elicitation/request', 1, form)).toBeUndefined();
  });

  it.each([['mock:mcp-approval-form', -32601], ['mock:mcp-approval-null-turn', -32602]])('%s is answered with %i and no card', async (prompt, code) => {
    const ui: UiEvent[] = [];
    const session = new CodexAppServerRunner({ bin, timeoutMs: 0 }).startSession({ toolGrant: UNSET_TOOL_GRANT, cwd: process.cwd(), userPrompt: prompt }, undefined,
      { autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) });
    try {
      expect((await session.result).text).toContain(`Approval error: ${code}`);
      expect(ui.some(e => e.type === 'permission.requested')).toBe(false);
    } finally { session.interrupt(); await session.result; }
  });

  it('answers an unsupported server request and lets the native server continue', async () => {
    const session = new CodexAppServerRunner({ bin, timeoutMs: 0 }).startSession({ toolGrant: UNSET_TOOL_GRANT, cwd: process.cwd(), userPrompt: 'mock:approval-unsupported' }, undefined,
      { autoEndAfterFirstTurn: true });
    try {
      expect((await session.result).text).toContain('Approval error: -32601');
    } finally { session.interrupt(); await session.result; }
  });
});
