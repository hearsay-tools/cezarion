import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunSpec, AgentRunner, AgentSession } from './agent-runner.ts';
import { CursorRunner } from './cursor-runner.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';

const spec: AgentRunSpec = { cwd: '/tmp', userPrompt: 'start', toolGrant: UNSET_TOOL_GRANT };
function fakeRunner(transport: 'cursor-print', starts: string[], specs: AgentRunSpec[]): AgentRunner {
  return {
    backend: 'cursor', specSupport: {} as AgentRunner['specSupport'], systemPromptOnResume: 'in-thread',
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
    startSession(_spec, onEvent): AgentSession {
      starts.push(transport);
      specs.push(_spec);
      onEvent?.({ type: 'session', sessionId: 'native-id' });
      return {
        result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
        pid: 123, open: true, sendMessage: () => true, sendAgentMessage: async () => {},
        discardQueuedMessages: () => {}, holdsHumanInput: () => false,
        end: () => {}, interrupt: () => {},
      };
    },
  };
}

describe('Cursor transport facade', () => {
  function setup(options: Partial<ConstructorParameters<typeof CursorRunner>[0]> = {}) {
    const starts: string[] = [];
    const specs: AgentRunSpec[] = [];
    const inspect = vi.fn(async () => ({ supported: true as const }));
    const runner = new CursorRunner({
      inspect, makePrint: () => fakeRunner('cursor-print', starts, specs), ...options,
    });
    return { starts, specs, inspect, runner };
  }

  const ACP_REFUSED = 'This Cursor session was started on the ACP transport, which Cezarion no longer supports, '
    + 'so it cannot resume. Start a new task to continue this work.';
  const unsupported = (reason: string) => `Cursor CLI cannot run this task: ${reason}. Run "agent update" to install a `
    + 'supported Cursor CLI, or update Cezarion if your build is newer than this version supports.';

  it('refuses an ACP-tagged resume without a print probe or a session (hearsay-tools/cezarion#1267)', async () => {
    const { starts, inspect, runner } = setup({ sessionTransport: 'cursor-acp' });
    const events: AgentEvent[] = [];
    await runner.startSession({ ...spec, resume: true, sessionId: 'native-id' }, event => events.push(event)).result;
    expect(inspect).not.toHaveBeenCalled();
    expect(starts).toEqual([]);
    expect(events).toEqual([{ type: 'error', message: ACP_REFUSED }]);
  });

  it('uses explicit print without fallback', async () => {
    const { starts, inspect, runner } = setup({ sessionTransport: 'cursor-print' });
    await runner.startSession(spec).result;
    expect(inspect).toHaveBeenCalledOnce();
    expect(starts).toEqual(['cursor-print']);
  });

  it('fails an explicit print resume when its prerequisites changed', async () => {
    const { starts, runner } = setup({ sessionTransport: 'cursor-print', inspect: async () => ({ supported: false, reason: 'catalog changed' }) });
    const events: AgentEvent[] = [];
    await runner.startSession({ ...spec, resume: true, sessionId: 'native-id' }, event => events.push(event)).result;
    expect(starts).toEqual([]);
    expect(events).toEqual([{ type: 'error', message: unsupported('catalog changed') }]);
  });

  it('refuses an untagged legacy resume without a print probe or a session (hearsay-tools/cezarion#1267)', async () => {
    const { starts, inspect, runner } = setup();
    const events: AgentEvent[] = [];
    await runner.startSession({ ...spec, resume: true, sessionId: 'native-id' }, event => events.push(event)).result;
    expect(inspect).not.toHaveBeenCalled();
    expect(starts).toEqual([]);
    expect(events).toEqual([{ type: 'error', message: ACP_REFUSED }]);
  });

  it('chooses print for a supported fresh session', async () => {
    const { starts, inspect, runner } = setup();
    await runner.startSession(spec).result;
    expect(inspect).toHaveBeenCalledOnce();
    expect(starts).toEqual(['cursor-print']);
  });

  it('passes a qualified default model and catalog into print', async () => {
    const models = [{ id: 'model-a', label: 'A', description: 'Default model' }, { id: 'model-a-low', label: 'A Low', description: '' }];
    const seen: unknown[] = [];
    const { specs, runner } = setup({
      inspect: async () => ({ supported: true, model: 'model-a', models }),
      makePrint: (catalog) => { seen.push(catalog); return fakeRunner('cursor-print', [], specs); },
    });
    await runner.startSession({ ...spec, effort: 'low' }).result;
    expect(seen).toEqual([models]);
    expect(specs[0]).toMatchObject({ model: 'model-a', effort: 'low' });
  });

  it('fails a fresh session on an unqualified build before inference, with the fix (hearsay-tools/cezarion#1267)', async () => {
    const { starts, runner } = setup({ inspect: async () => ({ supported: false, reason: 'old CLI' }) });
    const events: AgentEvent[] = [];
    const ui: unknown[] = [];
    await runner.startSession(spec, event => events.push(event), { onUiEvent: event => ui.push(event) }).result;
    expect(starts).toEqual([]);
    expect(events).toEqual([{ type: 'error', message: unsupported('old CLI') }]);
    expect(ui).toEqual([{ type: 'session.error', message: unsupported('old CLI'), fatal: true }]);
  });

  it('does not launch after cancellation during preflight', async () => {
    let release!: (result: { supported: true }) => void;
    const { starts, runner } = setup({ inspect: () => new Promise(resolve => { release = resolve; }) });
    const session = runner.startSession(spec);
    session.interrupt();
    release({ supported: true });
    await session.result;
    expect(starts).toEqual([]);
  });

  it('holds human input but refuses worker input while selecting', async () => {
    let release!: (result: { supported: true }) => void;
    const { runner } = setup({ inspect: () => new Promise(resolve => { release = resolve; }) });
    const session = runner.startSession(spec);
    expect(session.sendMessage([{ type: 'text', text: 'follow up' }])).toBe(true);
    expect(session.heldHumanInputCount?.()).toBe(1);
    expect(session.sendAgentMessage([{ type: 'text', text: 'worker input' }])).toBe(false);
    session.discardQueuedMessages();
    expect(session.heldHumanInputCount?.()).toBe(0);
    release({ supported: true });
    await session.result;
  });

  it('reports uncertain preflight without starting a session', async () => {
    const { starts, runner } = setup({ inspect: async () => { throw new Error('discovery failed'); } });
    const events: AgentEvent[] = [];
    await runner.startSession(spec, event => events.push(event)).result;
    expect(starts).toEqual([]);
    expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('discovery failed') });
  });
});
