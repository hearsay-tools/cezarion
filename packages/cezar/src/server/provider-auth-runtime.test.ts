import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAuthService,
  type ProviderId,
  type RunProviderCommand,
} from '../core/provider-auth.ts';
import { RunStore } from '../runs/store.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import type { RuntimeAuthProfileResolver } from './provider-auth-runtime.ts';
import {
  ProviderRuntimeAuthObserver,
  recoverWithProviderRuntimeAuthObservation,
  watchProviderRuntimeAuthFailures,
} from './provider-auth-runtime.ts';

const CONNECTED_OUTPUT: Record<ProviderId, string> = {
  claude: '{"loggedIn":true}',
  cursor: '{"isAuthenticated":true}',
  codex: 'Logged in using ChatGPT',
  opencode: [
    '┌  Credentials ~/.local/share/opencode/auth.json',
    '●  Anthropic oauth',
    '└  1 credential',
  ].join('\n'),
  pi: 'provider  model  context  max-out  thinking  images\nanthropic  claude  200K  64K  yes  yes',
};

const providerForExecutable = (executable: string): ProviderId => {
  if (executable === 'agent') return 'cursor';
  if (executable === 'claude' || executable === 'codex' || executable === 'opencode' || executable === 'pi') return executable;
  throw new Error(`unexpected executable: ${executable}`);
};

/** A service whose Claude CLI agrees the credentials are gone, so the latch's self-check confirms
 *  the rejection instead of clearing it. */
function loggedOutClaudeProviderAuth(): ProviderAuthService {
  return new ProviderAuthService({
    platform: 'linux',
    runCommand: vi.fn<RunProviderCommand>(async (executable) => (
      executable === 'claude'
        ? { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 }
        : { stdout: CONNECTED_OUTPUT[providerForExecutable(executable)], stderr: '', exitCode: 0 }
    )),
    createAuthFailureId: () => 'auth-incident-1',
  });
}

describe('watchProviderRuntimeAuthFailures', () => {
  let root: string;
  let store: RunStore;
  let providerAuth: ProviderAuthService;
  const unwatchers: Array<() => void> = [];
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-provider-auth-runtime-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    delete process.env.CEZ_DRY_RUN;
    const runCommand = vi.fn<RunProviderCommand>(async (executable) => ({
      stdout: CONNECTED_OUTPUT[providerForExecutable(executable)],
      stderr: '',
      exitCode: 0,
    }));
    providerAuth = new ProviderAuthService({
      platform: 'linux',
      runCommand,
      createAuthFailureId: () => 'auth-incident-1',
    });
  });

  afterEach(() => {
    for (const unwatch of unwatchers.splice(0)) unwatch();
    store.flush();
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const watch = (resolveProfile?: RuntimeAuthProfileResolver) => {
    const onInvalidated = vi.fn();
    unwatchers.push(resolveProfile
      ? watchProviderRuntimeAuthFailures(store, providerAuth, onInvalidated, resolveProfile)
      : watchProviderRuntimeAuthFailures(store, providerAuth, onInvalidated));
    return onInvalidated;
  };

  /** The self-check now runs behind the async account resolution, so it is posted, not synchronous
   *  with `appendEvent` — wait for the call, then for its answer. */
  const verified = async (verifying: ReturnType<typeof vi.spyOn>) => {
    await vi.waitFor(() => expect(verifying).toHaveBeenCalled());
    await verifying.mock.results[0]!.value;
  };

  it('invalidates the step backend for an auth error in a mixed-provider run', () => {
    const onInvalidated = watch();
    const run = store.createRun({
      title: 'mixed',
      workflow: 'mixed',
      task: 'work',
      runner: 'claude',
      steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }],
    });
    store.updateStep(run.id, 'implement', { backend: 'codex' });

    store.appendEvent(run.id, {
      type: 'error',
      stepId: 'implement',
      message: 'authentication failed with HTTP 401',
    });

    expect(onInvalidated).toHaveBeenCalledWith({
      provider: 'codex',
      status: 'disconnected',
      hint: expect.any(String),
      authFailureId: 'auth-incident-1',
    });
    expect(store.readEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'provider-auth-required',
        provider: 'codex',
        authFailureId: 'auth-incident-1',
        stepId: 'implement',
      }),
    ]));
  });

  it('falls back to the run backend when the event has no matching step', () => {
    const onInvalidated = watch();
    const run = store.createRun({
      title: 'fallback',
      workflow: 'quick-task',
      task: 'work',
      runner: 'opencode',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });

    store.appendEvent(run.id, {
      type: 'error',
      stepId: 'missing',
      message: 'unauthorized credential returned HTTP 401',
    });

    expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode',
      status: 'disconnected',
    }));
  });

  it('treats a legacy run with no backend as Claude', () => {
    const onInvalidated = watch();
    const run = store.createRun({
      title: 'legacy',
      workflow: 'quick-task',
      task: 'work',
      steps: [],
    });

    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      status: 'disconnected',
    }));
  });

  it.each(['error', 'session.error', 'note'])(
    'observes auth failures carried by %s events',
    (type) => {
      const onInvalidated = watch();
      const run = store.createRun({
        title: type,
        workflow: 'quick-task',
        task: 'work',
        runner: 'codex',
        steps: [],
      });

      store.appendEvent(run.id, {
        type,
        message: 'OAuth access token is invalid',
      });

      expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex',
        status: 'disconnected',
      }));
    },
  );

  it('ignores unrelated errors and non-message events', () => {
    const onInvalidated = watch();
    const run = store.createRun({
      title: 'ignore',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    store.appendEvent(run.id, {
      type: 'error',
      message: 'the compiler rejected this TypeScript program',
    });
    store.appendEvent(run.id, {
      type: 'error',
      text: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });
    store.appendEvent(run.id, {
      type: 'tool.result',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).not.toHaveBeenCalled();
  });

  it('appends one safe task event when v1 and v2 report the same provider failure', () => {
    const onInvalidated = watch();
    const run = store.createRun({
      title: 'duplicate',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });
    store.appendEvent(run.id, {
      type: 'session.error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).toHaveBeenCalledTimes(1);
    const required = store.readEvents(run.id).filter(({ type }) => type === 'provider-auth-required');
    expect(required).toHaveLength(1);
    const { seq: _seq, ts: _ts, ...safe } = required[0]!;
    expect(safe).toEqual({
      type: 'provider-auth-required',
      provider: 'claude',
      authFailureId: 'auth-incident-1',
    });
  });

  it('records the current incident on each affected task but invalidates the workspace once', () => {
    const onInvalidated = watch();
    const first = store.createRun({
      title: 'first',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });
    const second = store.createRun({
      title: 'second',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    for (const run of [first, second]) {
      store.appendEvent(run.id, {
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
    }

    expect(onInvalidated).toHaveBeenCalledTimes(1);
    for (const run of [first, second]) {
      expect(store.readEvents(run.id).filter(({ type }) => type === 'provider-auth-required'))
        .toEqual([expect.objectContaining({
          provider: 'claude',
          authFailureId: 'auth-incident-1',
        })]);
    }
  });

  describe('the latch checks itself against the CLI before it stands', () => {
    const failing = (store_: RunStore, runner: ProviderId = 'claude') => {
      const run = store_.createRun({
        title: 'self-check',
        workflow: 'quick-task',
        task: 'work',
        runner,
        steps: [],
      });
      store_.appendEvent(run.id, {
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      return run;
    };

    it('announces the recovery when the credentials were never gone', async () => {
      const onProviderStatus = watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      failing(store);
      await verified(verifying);

      expect(onProviderStatus.mock.calls.map(([status]) => status)).toEqual([
        expect.objectContaining({ provider: 'claude', status: 'disconnected' }),
        { provider: 'claude', status: 'connected' },
      ]);
      await expect(providerAuth.status()).resolves.toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: 'claude', status: 'connected' }),
        ]),
      });
    });

    it('leaves the latch standing when the CLI confirms the logout', async () => {
      providerAuth = loggedOutClaudeProviderAuth();
      const onProviderStatus = watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      failing(store);
      await verified(verifying);

      expect(onProviderStatus).toHaveBeenCalledTimes(1);
      expect(onProviderStatus).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        status: 'disconnected',
        authFailureId: 'auth-incident-1',
      }));
      await expect(providerAuth.status()).resolves.toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: 'claude', status: 'disconnected' }),
        ]),
      });
    });

    it('self-checks once for a burst of auth-shaped lines under one latch', async () => {
      watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');
      const run = failing(store);

      // Same run, same incident: the second and third line describe the latch already standing.
      for (const type of ['session.error', 'note'] as const) {
        store.appendEvent(run.id, { type, message: 'unauthorized: 401 token expired' });
      }
      await verified(verifying);

      expect(verifying).toHaveBeenCalledTimes(1);
    });

    it('keeps the task transcript record of what the runner reported', async () => {
      watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');
      const run = failing(store);
      await verified(verifying);

      // Recovery repairs workspace status, not history: the task still shows why it stopped.
      expect(store.readEvents(run.id).filter(({ type }) => type === 'provider-auth-required'))
        .toEqual([expect.objectContaining({ provider: 'claude', authFailureId: 'auth-incident-1' })]);
    });

    // The CLI answers per login: the `work` account's config dir hears the truth about `work`, the
    // bare default about itself. The pair below only passes when the self-check asks the RIGHT one.
    const accountAwareRunCommand = (workAnswer: { stdout: string; exitCode: number }) => {
      const runCommand = vi.fn<RunProviderCommand>(async (_executable, _args, _timeout, env) => (
        env?.CLAUDE_CONFIG_DIR === '/work'
          ? { stdout: workAnswer.stdout, stderr: '', exitCode: workAnswer.exitCode }
          : { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
      ));
      providerAuth = new ProviderAuthService({
        platform: 'linux',
        runCommand,
        createAuthFailureId: () => 'auth-incident-1',
      });
      return runCommand;
    };
    const workAccountResolver = vi.fn<RuntimeAuthProfileResolver>(async (_provider, profileId) => (
      profileId === 'work' ? { kind: 'profile' as const, id: 'work', configDir: '/work' } : null
    ));

    it('self-checks the account the failing step recorded', async () => {
      const runCommand = accountAwareRunCommand({ stdout: '{"loggedIn":true}', exitCode: 0 });
      const onProviderStatus = watch(workAccountResolver);
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      const run = store.createRun({
        title: 'named account',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }],
      });
      store.updateStep(run.id, 'implement', { profileId: 'work' });
      store.appendEvent(run.id, {
        type: 'error',
        stepId: 'implement',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      await verified(verifying);

      // The probe carried the account's config dir, and its answer cleared the latch.
      expect(runCommand).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], 10_000, {
        CLAUDE_CONFIG_DIR: '/work',
      });
      // The account's answer is filed under the account; the workspace channel carries DEFAULT
      // rows only, and with no cached default answer there is nothing to reconcile on it.
      expect(onProviderStatus).toHaveBeenCalledTimes(1);
      expect(onProviderStatus).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        status: 'disconnected',
        authFailureId: 'auth-incident-1',
      }));
      expect(providerAuth.peekProfileStatus('claude', 'work'))
        .toEqual({ provider: 'claude', status: 'connected', profileId: 'work' });
    });

    it('keeps the latch when the recorded account itself confirms the logout', async () => {
      // The DEFAULT login is connected — that answer must not clear an incident raised by `work`,
      // or every later run on the broken account is waved through to fail again.
      accountAwareRunCommand({ stdout: '{"loggedIn":false}', exitCode: 1 });
      const onProviderStatus = watch(workAccountResolver);
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      const run = store.createRun({
        title: 'named account logged out',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }],
      });
      store.updateStep(run.id, 'implement', { profileId: 'work' });
      store.appendEvent(run.id, {
        type: 'error',
        stepId: 'implement',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      await verified(verifying);

      expect(onProviderStatus).toHaveBeenCalledTimes(1);
      expect(onProviderStatus).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        status: 'disconnected',
        authFailureId: 'auth-incident-1',
      }));
      await expect(providerAuth.status()).resolves.toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: 'claude', status: 'disconnected' }),
        ]),
      });
    });

    it('keeps the latch when the recorded account cannot be checked at all', async () => {
      const runCommand = accountAwareRunCommand({ stdout: '{"loggedIn":true}', exitCode: 0 });
      const onProviderStatus = watch(workAccountResolver);
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      const run = store.createRun({
        title: 'dangling account',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }],
      });
      store.updateStep(run.id, 'implement', { profileId: 'gone' });
      store.appendEvent(run.id, {
        type: 'error',
        stepId: 'implement',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      // The watcher resolves the account (and gets nothing) before deciding to skip the probe.
      await vi.waitFor(() => expect(workAccountResolver).toHaveBeenCalled());
      await workAccountResolver.mock.results[0]!.value;

      // No resolvable account, no probe, no recovery: the incident stands for Try again to clear.
      expect(verifying).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
      expect(onProviderStatus).toHaveBeenCalledTimes(1);
      expect(onProviderStatus).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        status: 'disconnected',
      }));
    });

    it('falls back to the run account for an error with no matching step', async () => {
      const runCommand = accountAwareRunCommand({ stdout: '{"loggedIn":true}', exitCode: 0 });
      const onProviderStatus = watch(workAccountResolver);
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      const run = store.createRun({
        title: 'run account',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        agentProfile: 'work',
        steps: [],
      });
      store.appendEvent(run.id, {
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      await verified(verifying);

      expect(runCommand).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], 10_000, {
        CLAUDE_CONFIG_DIR: '/work',
      });
      // The account's answer is filed under the account, never broadcast as the default's.
      expect(onProviderStatus).toHaveBeenCalledTimes(1);
      expect(onProviderStatus).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        status: 'disconnected',
      }));
    });

    it('publishes the default row, not the account row, when a named account recovers', async () => {
      accountAwareRunCommand({ stdout: '{"loggedIn":true}', exitCode: 0 });
      // The workspace holds a complete default answer, as it does after any page load.
      await providerAuth.status();
      const onProviderStatus = watch(workAccountResolver);
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      const run = store.createRun({
        title: 'named recovery',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }],
      });
      store.updateStep(run.id, 'implement', { profileId: 'work' });
      store.appendEvent(run.id, {
        type: 'error',
        stepId: 'implement',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      await verified(verifying);

      expect(onProviderStatus.mock.calls.map(([status]) => status)).toEqual([
        expect.objectContaining({
          provider: 'claude',
          status: 'disconnected',
          authFailureId: 'auth-incident-1',
        }),
        // The named account's answer stays under the account; the workspace channel carries the
        // provider's DEFAULT row, so a disconnected default is never shown connected. A row with
        // `profileId` here would be dropped by the cockpit's parser and misread as the default.
        { provider: 'claude', status: 'connected' },
      ]);
    });

    it('carries the reported incident through the account-resolution wait', async () => {
      // A's check is triggered, but its account resolution stalls; while it stalls, another auth
      // failure advances the incident (a non-transition line the watcher skips). The stalled
      // check must answer the incident it was triggered by — or stand down entirely — never
      // clear the newer one.
      let releaseResolver!: (target: { kind: 'profile'; id: string; configDir: string }) => void;
      const resolverGate = new Promise<{ kind: 'profile'; id: string; configDir: string }>(
        (resolve) => { releaseResolver = resolve; },
      );
      const gatingResolver = vi.fn<RuntimeAuthProfileResolver>(async () => resolverGate);
      const runCommand = accountAwareRunCommand({ stdout: '{"loggedIn":true}', exitCode: 0 });
      const onProviderStatus = watch(gatingResolver);
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      const run = store.createRun({
        title: 'resolver race',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }],
      });
      store.updateStep(run.id, 'implement', { profileId: 'work' });
      store.appendEvent(run.id, {
        type: 'error',
        stepId: 'implement',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      await vi.waitFor(() => expect(gatingResolver).toHaveBeenCalled());
      // The newer failure advances the incident while A's resolution is still pending.
      store.appendEvent(run.id, {
        type: 'error',
        stepId: 'implement',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      releaseResolver({ kind: 'profile', id: 'work', configDir: '/work' });
      await vi.waitFor(() => expect(verifying).toHaveBeenCalled());
      await verifying.mock.results[0]!.value;

      // The stalled check stood down: A's CLI was never asked, and the incident stands.
      expect(runCommand).not.toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], 10_000, {
        CLAUDE_CONFIG_DIR: '/work',
      });
      await expect(providerAuth.status()).resolves.toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: 'claude',
            status: 'disconnected',
            authFailureId: 'auth-incident-1',
          }),
        ]),
      });
    });

    it('resolves a recorded account through the workspace store by default', async () => {
      await mergeWriteAgentAccounts((current) => ({
        ...current,
        accounts: [...current.accounts, {
          id: 'work',
          provider: 'claude' as const,
          configDir: '/work-from-store',
          label: 'Work',
          addedAt: '',
        }],
      }));
      const runCommand = vi.fn<RunProviderCommand>(async (_executable, _args, _timeout, env) => (
        env?.CLAUDE_CONFIG_DIR === '/work-from-store'
          ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
          : { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 }
      ));
      providerAuth = new ProviderAuthService({
        platform: 'linux',
        runCommand,
        createAuthFailureId: () => 'auth-incident-1',
      });
      const onProviderStatus = watch();
      const verifying = vi.spyOn(providerAuth, 'verifyRuntimeAuthFailure');

      const run = store.createRun({
        title: 'stored account',
        workflow: 'quick-task',
        task: 'work',
        runner: 'claude',
        steps: [{ id: 'implement', name: 'Implement', kind: 'agent' }],
      });
      store.updateStep(run.id, 'implement', { profileId: 'work' });
      store.appendEvent(run.id, {
        type: 'error',
        stepId: 'implement',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      await verified(verifying);

      expect(runCommand).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], 10_000, {
        CLAUDE_CONFIG_DIR: '/work-from-store',
      });
      // Filed under the account, never broadcast as the default's answer.
      expect(onProviderStatus).toHaveBeenCalledTimes(1);
      expect(onProviderStatus).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        status: 'disconnected',
      }));
      expect(providerAuth.peekProfileStatus('claude', 'work'))
        .toEqual({ provider: 'claude', status: 'connected', profileId: 'work' });

      // Leave the shared per-worker sandbox as it was found.
      await mergeWriteAgentAccounts((current) => ({
        ...current,
        accounts: current.accounts.filter((account) => account.id !== 'work'),
      }));
    });
  });

  it('unsubscribes cleanly', () => {
    const onInvalidated = vi.fn();
    const unwatch = watchProviderRuntimeAuthFailures(store, providerAuth, onInvalidated);
    const run = store.createRun({
      title: 'unsubscribed',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    unwatch();
    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth token has been revoked.',
    });

    expect(onInvalidated).not.toHaveBeenCalled();
  });

  it('deduplicates observation when startup and app construction watch the same store', () => {
    const onInvalidated = vi.fn();
    const observer = new ProviderRuntimeAuthObserver(providerAuth, onInvalidated);
    const run = store.createRun({
      title: 'deduplicated',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    observer.watch(store);
    observer.watch(store);
    store.appendEvent(run.id, {
      type: 'error',
      message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    });

    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it('attaches boot-store observation before recovery can emit an auth failure', async () => {
    const run = store.createRun({
      title: 'boot recovery',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });
    // A CLI that agrees the credentials are gone, so the self-check leaves the latch standing and
    // this case stays about its own subject: observation is attached BEFORE recovery runs.
    providerAuth = loggedOutClaudeProviderAuth();
    const observer = new ProviderRuntimeAuthObserver(providerAuth, vi.fn());

    await recoverWithProviderRuntimeAuthObservation(
      store,
      async () => {
        store.appendEvent(run.id, {
          type: 'error',
          message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
        });
      },
      observer,
    );

    await expect(providerAuth.status().then(({ providers }) => providers[0]))
      .resolves.toMatchObject({ provider: 'claude', status: 'disconnected' });
  });
});
