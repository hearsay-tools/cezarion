import { productIdentity } from './home/identity.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { testHome } from './home/test-home.testkit.ts';
import { defaultHeadlessDeps, printHeadlessEvent, runHeadless, type HeadlessDeps } from './headless-run.ts';
import { RunStoreOpenError } from './runs/store-open-error.ts';
import { QUICK_TASK_WORKFLOW } from './workflows/types.ts';

const access = { allowWorkers: false, allowMessaging: true };

function fixture() {
  const trace: string[] = [];
  const home = testHome();
  const state = { final: 'done', duringStart: () => {}, record: { branch: 'cez/task', tokensUsed: 42 } as { branch: string; tokensUsed: number } | undefined };
  const store = Object.assign(new EventEmitter(), {
    getRun: vi.fn(() => state.record),
    close: vi.fn(() => { trace.push('store.close'); }),
  });
  const fakeProcess = Object.assign(new EventEmitter(), {
    platform: 'linux', pid: 1234, exitCode: undefined as number | undefined,
    kill: vi.fn((_pid: number, signal: string) => { trace.push(`kill ${signal}`); }),
  });
  vi.spyOn(fakeProcess, 'off').mockImplementation((event, listener) => {
    trace.push(`off ${String(event)}`);
    EventEmitter.prototype.off.call(fakeProcess, event, listener);
    return fakeProcess;
  });
  const output = { log: vi.fn(), error: vi.fn() };
  const status = vi.fn().mockResolvedValue({ providers: [] });
  const watch = vi.fn(() => { trace.push('watch'); });
  const refresh = vi.fn(async () => { trace.push('refresh'); });
  const startRun = vi.fn(() => {
    trace.push(`startRun listeners=${store.listenerCount('run')}`);
    state.duringStart();
    queueMicrotask(() => {
      store.emit('run', { id: 'other', status: RUN_STATUS.done });
      store.emit('run', { id: 'task', status: RUN_STATUS.running });
      store.emit('event', { event: { type: 'text', text: 'task output' } });
      store.emit('run', { id: 'task', status: state.final });
    });
    return { id: 'task' };
  });
  const delegation = {
    service: { setDiscovery: vi.fn() }, attachProject: vi.fn(),
    close: vi.fn(async () => { trace.push('delegation.close'); }),
  };
  const deps = {
    ...defaultHeadlessDeps,
    initWorkspace: vi.fn(async () => { trace.push('workspace'); return 'project'; }),
    loadWorkflows: vi.fn().mockResolvedValue({ workflows: [QUICK_TASK_WORKFLOW], issues: [] }),
    ProviderAuthService: vi.fn(class { status = status; }),
    providersRequiredByWorkflow: vi.fn(() => [] as string[]),
    loadConfig: vi.fn().mockResolvedValue({ defaultRunner: 'codex' }),
    providerAuthChecksDisabled: vi.fn(() => false),
    loadWorkspaceConfig: vi.fn().mockResolvedValue({ disabledProviders: ['claude'] }),
    unavailableProviderMessage: vi.fn(() => null as string | null),
    applyProviderEnablement: vi.fn(() => ({ providers: [] })),
    openStore: vi.fn((_root: string, opts: { repoHandleSignal: AbortSignal }) => {
      trace.push('openStore');
      opts.repoHandleSignal.addEventListener('abort', () => { trace.push('abort'); });
      return store;
    }),
    DelegationController: { start: vi.fn(async () => delegation) },
    createHostDiscovery: vi.fn(() => ({ models: 'catalog' })),
    forwardToSessionGroups: vi.fn((signal: string) => { trace.push(`forward ${signal}`); }),
    ProviderRuntimeAuthObserver: vi.fn(class { watch = watch; }),
    WorkspaceSemaphore: vi.fn(class { refresh = refresh; }),
    RunManager: vi.fn(class { startRun = startRun; }),
    process: fakeProcess,
    console: output,
    onTerminal: vi.fn(() => true),
  };
  const run = (workflowName?: string) => runHeadless(home, '/repo', 'the task', workflowName, 'model', access, deps as unknown as HeadlessDeps);
  return { trace, home, state, store, fakeProcess, output, status, watch, refresh, startRun, delegation, deps, run };
}

describe('runHeadless', () => {
  it.each([
    ['done', 0], ['review', 0], ['failed', 1], ['cancelled', 1],
  ] as const)('reports %s and exits %s after ordered teardown', async (final, exitCode) => {
    const f = fixture();
    f.state.final = final;
    await f.run();
    expect(f.fakeProcess.exitCode).toBe(exitCode);
    expect(f.output.log).toHaveBeenCalledWith(`\nrun ${final} — 42 tokens — details in the cockpit: ${productIdentity().npx}`);
    expect(f.trace).toEqual([
      'workspace', 'openStore', 'watch', 'refresh', 'startRun listeners=0',
      'off SIGINT', 'off SIGTERM', 'off SIGHUP', 'delegation.close', 'abort', 'store.close',
    ]);
    expect(f.output.log).toHaveBeenCalledWith('task output');
    expect(f.startRun).toHaveBeenCalledWith(QUICK_TASK_WORKFLOW, { task: 'the task', model: 'model', ...access });
    expect(f.delegation.attachProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'headless', root: '/repo', home: f.home, store: f.store }));
    expect(f.output.log.mock.calls.some(([line]) => String(line).includes('changes ready for review'))).toBe(final === 'review');
    expect(f.fakeProcess.eventNames()).toEqual([]);
  });

  it('keeps the review branch and missing-record fallbacks', async () => {
    const f = fixture();
    f.state.final = 'review';
    f.state.record = undefined;
    await f.run();
    expect(f.output.log.mock.calls).toEqual([
      ['task output'],
      [ `\n  changes ready for review on branch ? — inspect them in the cockpit: ${productIdentity().npx}` ],
      [ `\nrun review — 0 tokens — details in the cockpit: ${productIdentity().npx}` ],
    ]);
  });

  it('prints loader issues before rejecting an unknown workflow', async () => {
    const f = fixture();
    f.deps.loadWorkflows.mockResolvedValue({ workflows: [QUICK_TASK_WORKFLOW], issues: [{ path: '/bad.yaml', message: 'invalid' }] });
    await f.run('missing');
    expect(f.output.error.mock.calls).toEqual([
      ['! skipped /bad.yaml: invalid'],
      ['unknown workflow: missing (available: quick-task)'],
    ]);
    expect(f.fakeProcess.exitCode).toBe(1);
    expect(f.deps.ProviderAuthService).not.toHaveBeenCalled();
    expect(f.deps.openStore).not.toHaveBeenCalled();
  });

  it('prints the available workflow list in order', async () => {
    const f = fixture();
    f.deps.loadWorkflows.mockResolvedValue({ workflows: [{ ...QUICK_TASK_WORKFLOW, name: 'first' }, { ...QUICK_TASK_WORKFLOW, name: 'second' }], issues: [] });
    await f.run();
    expect(f.output.error).toHaveBeenCalledWith('unknown workflow: quick-task (available: first, second)');
  });

  it('checks enabled providers before opening the store', async () => {
    const f = fixture();
    f.deps.providersRequiredByWorkflow.mockReturnValue(['codex']);
    await f.run();
    expect(f.status).toHaveBeenCalledOnce();
    expect(f.deps.loadWorkspaceConfig).toHaveBeenCalledWith(f.home.workspaceConfig);
    expect(f.deps.applyProviderEnablement).toHaveBeenCalledWith({ providers: [] }, ['claude']);
    expect(f.deps.unavailableProviderMessage).toHaveBeenCalledWith(['codex'], { providers: [] });
    expect(f.deps.unavailableProviderMessage).toHaveBeenCalledBefore(f.deps.openStore);
  });

  it('refuses a blocked provider before starting resources', async () => {
    const f = fixture();
    f.deps.providersRequiredByWorkflow.mockReturnValue(['codex']);
    f.deps.unavailableProviderMessage.mockReturnValue('Codex credentials are unavailable.');
    await f.run();
    expect(f.output.error).toHaveBeenCalledWith('Codex credentials are unavailable.');
    expect(f.fakeProcess.exitCode).toBe(1);
    expect(f.deps.openStore).not.toHaveBeenCalled();
    expect(f.deps.DelegationController.start).not.toHaveBeenCalled();
    expect(f.fakeProcess.eventNames()).toEqual([]);
  });

  it.each([false, true])('skips provider discovery when checks are disabled=%s', async (disabled) => {
    const f = fixture();
    f.deps.providersRequiredByWorkflow.mockReturnValue(disabled ? ['codex'] : []);
    f.deps.providerAuthChecksDisabled.mockReturnValue(disabled);
    await f.run();
    expect(f.status).not.toHaveBeenCalled();
    expect(f.deps.loadWorkspaceConfig).not.toHaveBeenCalled();
    expect(f.deps.loadConfig).toHaveBeenCalledWith('/repo', f.home);
    expect(f.deps.providersRequiredByWorkflow).toHaveBeenCalledWith(QUICK_TASK_WORKFLOW, 'codex');
  });

  it('reports a store-open failure without creating delegation or signal listeners', async () => {
    const f = fixture();
    f.deps.openStore.mockImplementation(() => { throw new RunStoreOpenError('corrupt', '/repo/runs.db', 'store is damaged'); });
    await f.run();
    expect(f.output.error).toHaveBeenCalledWith('store is damaged');
    expect(f.fakeProcess.exitCode).toBe(1);
    expect(f.deps.DelegationController.start).not.toHaveBeenCalled();
    expect(f.fakeProcess.eventNames()).toEqual([]);
  });

  it('propagates other store-open errors', async () => {
    const f = fixture();
    const error = new Error('unexpected');
    f.deps.openStore.mockImplementation(() => { throw error; });
    await expect(f.run()).rejects.toBe(error);
    expect(f.output.error).not.toHaveBeenCalled();
    expect(f.fakeProcess.exitCode).toBeUndefined();
  });

  it('keeps teardown order when starting the run throws', async () => {
    const f = fixture();
    f.startRun.mockImplementation(() => { throw new Error('cannot start'); });
    await expect(f.run()).rejects.toThrow('cannot start');
    expect(f.trace.slice(-6)).toEqual(['off SIGINT', 'off SIGTERM', 'off SIGHUP', 'delegation.close', 'abort', 'store.close']);
    expect(f.fakeProcess.eventNames()).toEqual([]);
  });

  it('preserves the existing close rejection path', async () => {
    const f = fixture();
    f.delegation.close.mockRejectedValue(new Error('cannot close'));
    await expect(f.run()).rejects.toThrow('cannot close');
    expect(f.trace.slice(-3)).toEqual(['off SIGINT', 'off SIGTERM', 'off SIGHUP']);
    expect(f.store.close).not.toHaveBeenCalled();
    expect(f.deps.openStore.mock.calls[0]![1].repoHandleSignal.aborted).toBe(false);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('forwards %s before removing handlers and signalling itself', async (signal) => {
    const f = fixture();
    f.state.duringStart = () => { f.fakeProcess.emit(signal); };
    await f.run();
    const start = f.trace.indexOf(`forward ${signal}`);
    expect(f.trace.slice(start, start + 5)).toEqual([`forward ${signal}`, 'off SIGINT', 'off SIGTERM', 'off SIGHUP', `kill ${signal}`]);
    expect(f.deps.forwardToSessionGroups).toHaveBeenCalledWith(signal);
    expect(f.fakeProcess.kill).toHaveBeenCalledWith(1234, signal);
  });

  it('ignores off-terminal SIGHUP on Unix', async () => {
    const f = fixture();
    f.deps.onTerminal.mockReturnValue(false);
    f.state.duringStart = () => {
      expect(f.fakeProcess.listenerCount('SIGHUP')).toBe(1);
      f.fakeProcess.emit('SIGHUP');
    };
    await f.run();
    expect(f.deps.forwardToSessionGroups).not.toHaveBeenCalled();
    expect(f.fakeProcess.kill).not.toHaveBeenCalled();
  });

  it('does not install SIGHUP on Windows', async () => {
    const f = fixture();
    f.fakeProcess.platform = 'win32';
    f.deps.onTerminal.mockReturnValue(false);
    f.state.duringStart = () => { expect(f.fakeProcess.listenerCount('SIGHUP')).toBe(0); };
    await f.run();
    expect(f.deps.forwardToSessionGroups).not.toHaveBeenCalled();
  });
});

describe('printHeadlessEvent', () => {
  it.each([
    [{ type: 'text', text: 'hello' }, 'hello'],
    [{ type: 'text' }, ''],
    [{ type: 'check-output', text: 42 }, '42'],
    [{ type: 'check-output' }, ''],
    [{ type: 'tool-call', tool: 'Read', input: { path: '/file' } }, '  → Read {"path":"/file"}'],
    [{ type: 'tool-call', tool: 'Read' }, '  → Read '],
    [{ type: 'tool-result', result: 'first\nsecond' }, '  ← first'],
    [{ type: 'tool-result' }, '  ← '],
    [{ type: 'step-start', name: 'implement', iteration: 1 }, '\n── step: implement '],
    [{ type: 'step-start', name: 'verify', iteration: 2 }, '\n── step: verify (attempt 2)'],
    [{ type: 'note', message: 'note' }, '  · note'],
    [{ type: 'lifecycle', message: 'state' }, '  · state'],
    [{ type: 'lifecycle' }, '  · '],
  ] as const)('keeps output for %j', (event, expected) => {
    const output = { log: vi.fn(), error: vi.fn() };
    printHeadlessEvent(event, output);
    expect(output.log).toHaveBeenCalledExactlyOnceWith(expected);
    expect(output.error).not.toHaveBeenCalled();
  });

  it.each(['failure', undefined])('prints errors to stderr (%s)', (message) => {
    const output = { log: vi.fn(), error: vi.fn() };
    printHeadlessEvent({ type: 'error', message }, output);
    expect(output.error).toHaveBeenCalledExactlyOnceWith(`  ✗ ${message ?? ''}`);
    expect(output.log).not.toHaveBeenCalled();
  });

  it('ignores unknown event types', () => {
    const output = { log: vi.fn(), error: vi.fn() };
    printHeadlessEvent({ type: 'unknown' }, output);
    expect(output.log).not.toHaveBeenCalled();
    expect(output.error).not.toHaveBeenCalled();
  });

  it('truncates JSON previews and tool results to 120 characters', () => {
    const output = { log: vi.fn(), error: vi.fn() };
    const long = 'x'.repeat(130);
    printHeadlessEvent({ type: 'tool-call', tool: 'Write', input: long }, output);
    printHeadlessEvent({ type: 'tool-result', result: `${long}\nignored` }, output);
    expect(output.log.mock.calls).toEqual([
      [`  → Write ${JSON.stringify(long).slice(0, 117)}…`],
      [`  ← ${long.slice(0, 117)}…`],
    ]);
  });

  it('keeps an empty preview when JSON serialization fails', () => {
    const output = { log: vi.fn(), error: vi.fn() };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    printHeadlessEvent({ type: 'tool-call', tool: 'Write', input: circular }, output);
    expect(output.log).toHaveBeenCalledExactlyOnceWith('  → Write ');
  });
});
