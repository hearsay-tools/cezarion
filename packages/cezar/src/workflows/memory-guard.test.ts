import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';
import { AUTONOMOUS_NUDGE, NO_WAIT_NUDGE_NOTE } from './run.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { emitUsageForTest } from '../core/process-usage.ts';

describe('RunManager memory guard', () => {
  const f = setupMonitoringFixture();
  let session: AgentSession;
  let emit: (event: AgentEvent) => void;
  let settle: () => void;
  let close: () => void;
  let limit: number | null;
  let started: Promise<void>;
  let notifyStarted: () => void;

  beforeEach(() => {
    limit = 10;
    started = new Promise<void>(resolve => { notifyStarted = resolve; });
    vi.spyOn(f.semaphore, 'memoryLimitMb').mockImplementation(() => limit);
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession(_spec, onEvent) {
        let open = true;
        let resolve!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(done => { resolve = done; });
        settle = () => resolve({ text: '', toolCalls: [], tokensUsed: 0 });
        close = () => { open = false; };
        emit = event => onEvent?.(event);
        session = {
          get open() { return open; }, result,
          sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(async () => {}),
          discardQueuedMessages: vi.fn(), holdsHumanInput: () => false,
          end: vi.fn(close), interrupt: vi.fn(() => { close(); settle(); }),
        };
        queueMicrotask(() => {
          emit({ type: 'session', sessionId: 'memory-session' });
          notifyStarted();
        });
        return session;
      },
    };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function start() {
    const record = f.manager.startRun(f.SINGLE_STEP, {
      task: 'work', runner: 'claude', autonomous: true, worktree: false,
    });
    f.currentId = record.id;
    await started;
    return record.id;
  }

  function sample(id: string, mb = 20) {
    emitUsageForTest({ [id]: { cpuPct: 0, rssBytes: mb * 1024 * 1024, procCount: 1 } });
  }

  function pauses(id: string) {
    return f.store.readEvents(id).filter(event => event.type === 'lifecycle'
      && typeof event.message === 'string' && event.message.startsWith('paused — memory limit exceeded'));
  }

  it('ignores an active run before its session attaches and preserves autonomous startup', async () => {
    let sampled = false;
    let addedEvents: ReturnType<typeof f.store.readEvents> = [];
    const append = f.store.appendEvent.bind(f.store);
    vi.spyOn(f.store, 'appendEvent').mockImplementation((id, event) => {
      const result = append(id, event);
      if (event.type === 'step-start') {
        expect(f.manager.isActive(id)).toBe(true);
        const before = f.store.readEvents(id);
        sample(id);
        addedEvents = f.store.readEvents(id).slice(before.length);
        sampled = true;
      }
      return result;
    });
    const id = await start();
    expect(sampled).toBe(true);
    expect(addedEvents).toEqual([]);
    expect(session.open).toBe(true);
    expect(session.end).not.toHaveBeenCalled();
    expect(pauses(id)).toEqual([]);
    emit({ type: 'turn-end' });
    expect(session.sendAgentMessage).toHaveBeenCalledWith([{ type: 'text', text: AUTONOMOUS_NUDGE }], []);
  });

  it('records the pause and suppresses autonomous turn input before the process exits', async () => {
    const id = await start();
    vi.mocked(session.end).mockImplementation(() => {});
    sample(id);
    expect(session.end).toHaveBeenCalledOnce();
    expect(session.open).toBe(true);
    expect(pauses(id)).toMatchObject([{ message: 'paused — memory limit exceeded (20 MiB > 10 MiB)' }]);
    expect(f.store.readEvents(id)).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'note', message: expect.stringContaining('resume it with Continue'),
    })]));
    emit({ type: 'turn-end' });
    expect(session.sendAgentMessage).not.toHaveBeenCalledWith([{ type: 'text', text: AUTONOMOUS_NUDGE }], []);
    expect(f.store.readEvents(id)).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'note', message: expect.stringContaining(NO_WAIT_NUDGE_NOTE),
    })]));
    close();
    expect(session.open).toBe(false);
    settle();
    await waitForProduct(f.manager, f.store, () => !f.manager.isActive(id));
    expect(pauses(id)).toHaveLength(1);
  });

  it('ends the over-limit session and settles its execution', async () => {
    const id = await start();
    sample(id);
    expect(session.end).toHaveBeenCalledOnce();
    expect(session.open).toBe(false);
    settle();
    await waitForProduct(f.manager, f.store, () => !f.manager.isActive(id));
    expect(pauses(id)).toHaveLength(1);
  });

  it('does not pause twice while the first session exit is pending', async () => {
    const id = await start();
    vi.mocked(session.end).mockImplementation(() => {});
    sample(id);
    sample(id);
    expect(session.open).toBe(true);
    expect(session.end).toHaveBeenCalledOnce();
    expect(pauses(id)).toHaveLength(1);
  });

  it.each([null, 0, -1])('ignores usage when the limit is %s', async value => {
    const id = await start();
    limit = value;
    sample(id);
    expect(session.end).not.toHaveBeenCalled();
    expect(pauses(id)).toEqual([]);
  });

  it.each([5, 10])('keeps a session using %s MiB at or below the limit', async mb => {
    const id = await start();
    sample(id, mb);
    expect(session.open).toBe(true);
    expect(session.end).not.toHaveBeenCalled();
    expect(pauses(id)).toEqual([]);
  });

  it('ignores samples for another manager and empty snapshots', async () => {
    const id = await start();
    sample('another-project');
    emitUsageForTest({});
    expect(session.end).not.toHaveBeenCalled();
    expect(pauses(id)).toEqual([]);
  });

  it('does not pause an already closed session', async () => {
    const id = await start();
    close();
    sample(id);
    expect(session.end).not.toHaveBeenCalled();
    expect(pauses(id)).toEqual([]);
  });

  it('does not pause a cancelled session whose process has not exited', async () => {
    const id = await start();
    vi.mocked(session.interrupt).mockImplementation(() => {});
    f.manager.cancel(id);
    expect(session.open).toBe(true);
    sample(id);
    expect(session.end).not.toHaveBeenCalled();
    expect(pauses(id)).toEqual([]);
    close();
    settle();
    await waitForProduct(f.manager, f.store, () => !f.manager.isActive(id));
  });
});
