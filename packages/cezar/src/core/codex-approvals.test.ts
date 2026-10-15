import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { UiEvent } from './ui-events.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';

const bin = fileURLToPath(new URL('../../scripts/mock-codex-app-server.mjs', import.meta.url));

describe('Codex approvals over the native mock wire (hearsay-tools/cezarion#1049)', () => {
  it.each(['accept', 'decline', 'cancel'])('waits for an explicit %s response and echoes the exact native reply', async decision => {
    const ui: UiEvent[] = [];
    const session = new CodexAppServerRunner({ bin, timeoutMs: 0 }).startSession({ cwd: process.cwd(), userPrompt: 'mock:approval' }, undefined,
      { onUiEvent: event => ui.push(event) });
    try {
      await vi.waitFor(() => expect(ui.some(e => e.type === 'permission.requested')).toBe(true), { timeout: 2000 });
      expect(ui.some(e => e.type === 'turn.completed')).toBe(false);
      const event = ui.find(e => e.type === 'permission.requested')!;
      expect(session.sendMessage([{ type: 'text', text: 'accept' }])).toBe(false);
      expect(session.sendAgentMessage([{ type: 'text', text: 'accept' }])).toBe(false);
      const index = decision === 'accept' ? 0 : decision === 'decline' ? 2 : 3;
      expect(session.respondPermission?.(event.requestId, event.options[index]!.id)).toBe(true);
      await vi.waitFor(() => expect(ui.some(e => e.type === 'turn.completed')).toBe(true), { timeout: 2000 });
      session.end();
      expect((await session.result).text).toBe(`Approval response: ${JSON.stringify({ decision })}\nCEZ:DONE`);
      expect(ui).toContainEqual({ type: 'permission.resolved', requestId: event.requestId, optionId: event.options[index]!.id });
    } finally { session.interrupt(); await session.result; }
  });

  it('answers an unsupported server request and lets the native server continue', async () => {
    const session = new CodexAppServerRunner({ bin, timeoutMs: 0 }).startSession({ cwd: process.cwd(), userPrompt: 'mock:approval-unsupported' }, undefined,
      { autoEndAfterFirstTurn: true });
    try {
      expect((await session.result).text).toContain('Approval error: -32601');
    } finally { session.interrupt(); await session.result; }
  });
});
