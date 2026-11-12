import { testHome } from '../home/test-home.testkit.ts';
import { registrationGroups } from '../core/registration-coverage.testkit.ts';
import type { Caller } from './credentials.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { openTestRunStore } from '../runs/run-store-open.testkit.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { createFixtureManager, fixtureWork, managerDisposed } from '../workflows/fixture-cleanup.testkit.ts';
import { type WorkerSpawnRequest } from '@open-mercato/cezar-contract/delegation';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { onTestFinished, afterEach, beforeEach, expect, vi } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import type { AgentRunResult, AgentRunSpec, AgentSession, AgentEvent } from '../core/agent-runner.ts';
import * as runners from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunStore } from '../runs/store.ts';
import { join } from 'node:path';
import { fixture, waitForOwnedWork } from './service.testkit.ts';
import { DelegationController } from './provision.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import type { RunManager } from '../workflows/run.ts';
export function delegationToken(spec: AgentRunSpec): string {
  const token = spec.env?.CEZ_DELEGATION_TOKEN;
  expect(token).toBeDefined();
  return token!;
}

export const until = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15000, interval: 10 });

type AcceptedIdentityWorker = {
  home: string;
  parent: ReturnType<RunManager['startRun']>;
  caller: Caller;
  request: WorkerSpawnRequest;
  child: Awaited<ReturnType<DelegationController['service']['spawn']>>;
};

export function provisionWorkflowFixture() {
  let f: ReturnType<typeof fixture>, controller: DelegationController;
  const toolSessions = new Map<string, { manager: RunManager; generation: string }>();
  function observeTools(manager: RunManager) {
    const handlers = manager.squawkToolHandlers.bind(manager);
    vi.spyOn(manager, 'squawkToolHandlers').mockImplementation((id, generation) => {
      toolSessions.set(id, { manager, generation }); return handlers(id, generation);
    });
  }
  const recoveredManagers: RunManager[] = [];
  const recoveredStores: RunStore[] = [];
  const sessions: Array<{ spec: AgentRunSpec; session: AgentSession; emit(event: AgentEvent): void; finish(text?: string): void }> = [];
  beforeEach(async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
    f = fixture(); await f.releaseAdmission(); vi.restoreAllMocks();
    toolSessions.clear(); observeTools(f.manager);
    onTestFinished(scopeFixtureProcesses());
    const home = join(f.root, 'default-claude'); mkdirSync(home); vi.stubEnv('CLAUDE_CONFIG_DIR', home);
    vi.spyOn(runners, 'createRunner').mockImplementation(backend => ({ backend: backend ?? 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => {}, run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), startSession: (spec, emit) => {
      let resolve!: (value: AgentRunResult) => void; let open = true;
      const result = new Promise<AgentRunResult>(done => { resolve = done; });
      const finish = (text = '') => { open = false; resolve({ text, toolCalls: [], tokensUsed: 0 }); };
      const session: AgentSession = { result, get open() { return open; }, sendMessage: () => open, sendAgentMessage: () => open ? Promise.resolve() : false, discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt: finish, end: finish };
      sessions.push({ spec, session, emit: event => emit?.(event), finish }); return session;
    } }));
    controller = await DelegationController.start(); controller.attachProject({ home: testHome(), id: 'project', root: f.root, manager: f.manager, store: f.store });
  });
  afterEach(async () => {
    for (const manager of recoveredManagers) {
      for (const run of f.store.listRuns()) manager.cancel(run.id);
    }
    // After a restart the fixture's manager is the dead process: the recovered ones cancel.
    if (!managerDisposed(f.manager)) for (const run of f.store.listRuns()) f.manager.cancel(run.id);
    for (const s of sessions) s.finish();
    for (const manager of recoveredManagers) {
      await waitForOwnedWork(manager, f.store);
      manager.dispose();
    }
    recoveredManagers.length = 0;
    for (const store of recoveredStores) store.flush(); recoveredStores.length = 0;
    await controller.close(); sessions.length = 0; await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  // Real acceptance/store/manager and account registry; only the external agent wire is fake.
  async function acceptIdentityWorker(settings: { model?: string; effort?: string } = { model: 'haiku', effort: 'high' }, grants?: { allowedTools: string[]; bashAllowlist: string[] }, spawnInputs: Pick<WorkerSpawnRequest, 'context' | 'backend' | 'model' | 'workflow'> = {}, prepare?: (parentId: string) => void): Promise<AcceptedIdentityWorker> {
    const home = join(f.root, 'account-a'); mkdirSync(home);
    await mergeWriteAgentAccounts(store => { store.accounts = [{ id: 'account-a', provider: 'claude', configDir: home, label: 'A', addedAt: '' }]; }, testHome());
    const workflow = grants ? { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!, ...grants }] } : QUICK_TASK_WORKFLOW;
    const parent = f.manager.startRun(workflow, { task: 'parent', runner: 'claude', ...settings, agentProfile: 'account-a', worktree: false });
    await until(() => sessions.length === 1);
    const caller: Caller = controller.credentials.authenticate(delegationToken(sessions[0]!.spec))!;
    await f.holdAdmission();
    prepare?.(parent.id);
    const request = { task: 'child', baseline: 'HEAD', requestId: randomUUID(), ...spawnInputs };
    const child = await controller.service.spawn(caller, request);
    await acceptedBeforeLaunch(child.workerId);
    return { home, parent, caller, request, child };
  }
  async function acceptedBeforeLaunch(workerId: string) {
    await Promise.all([...fixtureWork(f.manager).pending].filter(([, label]) => label === 'pump').map(([promise]) => promise));
    expect(f.store.getRun(workerId)?.status).toBe('queued');
    expect(f.store.readWorkerExecution(workerId)?.phase).toBe('queued');
    expect(sessions.some(entry => entry.spec.env?.CEZ_TASK_ID === workerId)).toBe(false);
  }
  async function launchAccepted(accepted: Awaited<ReturnType<typeof acceptIdentityWorker>>, mode: 'queued' | 'restart' | 'continue') {
    if (mode === 'restart') {
      // A restart: the old store goes too, or it would still own the parent's family.
      f.manager.dispose(); sessions[0]!.finish();
      setRunStatus(f.store, accepted.parent.id, RUN_STATUS.waiting); f.store.close();
      const store = openTestRunStore(join(f.root, '.ai/cezar'), { keepLive: true });
      const manager = createFixtureManager(store, f.root); recoveredManagers.push(manager); recoveredStores.push(store);
      observeTools(manager);
      controller.attachProject({ home: testHome(), id: 'restarted', root: f.root, store, manager });
      await manager.recover(); return { manager, store };
    }
    await acceptedBeforeLaunch(accepted.child.workerId);
    await f.releaseAdmission();
    return { manager: f.manager, store: f.store };
  }
  /** The fake session calls cezar_done, then its turn ends, which completes an earlier workflow step
   *  (hearsay-tools/cezarion#1620, hearsay-tools/cezarion#2397). */
  const doneTurn = (entry: { spec: AgentRunSpec; emit(event: AgentEvent): void }, text: string) => void (async () => {
    const runId = entry.spec.env!.CEZ_TASK_ID!;
    const tools = toolSessions.get(runId);
    if (!tools) throw new Error(`no tool launch for ${runId}`);
    const answer = await tools.manager.squawkToolHandlers(runId, tools.generation).finishTurn({}, new AbortController().signal);
    if (!answer.ok) throw new Error(`cezar_done refused: ${answer.code}`);
    entry.emit({ type: 'text', text });
    entry.emit({ type: 'turn-end' });
  })();

  return { get f() { return f; }, get controller() { return controller; }, sessions, recoveredManagers, recoveredStores, acceptIdentityWorker, acceptedBeforeLaunch, launchAccepted, doneTurn };
}

export const PROVISION_ROWS = {
  governedIntent: RUNNER_IDS.flatMap(backend => ['start', 'continue', 'recovery', 'noninteractive', 'off'].map(mode => ({ backend, mode }))),
  catalogMutation: ['queued', 'restart', 'continue'] as const,
  mixedBackend: ['queued', 'restart', 'continue'] as const,
  mixedChain: ['queued', 'restart', 'continue'] as const,
  legacyIdentity: ['queued', 'restart', 'continue'] as const,
  inputRecipes: ['queued', 'restart', 'continue'] as const,
  contextArtifacts: ['queued', 'restart', 'continue'].flatMap(mode => ['original-deleted', 'copy-missing', 'both-changed'].map(damage => ({ mode: mode as 'queued' | 'restart' | 'continue', damage }))),
  workflowGrants: ['restart', 'continue'].flatMap(mode => ['missing', 'malformed', 'missing-step'].flatMap(damage => [[], ['Read']].map(allowedTools => ({ mode: mode as 'restart' | 'continue', damage, allowedTools })))),
  privateGrants: ['queued', 'restart', 'continue'].flatMap(mode => ['missing', 'malformed'].map(damage => ({ mode: mode as 'queued' | 'restart' | 'continue', damage }))),
  claudeLayout: ['queued', 'restart', 'continue'].flatMap(mode => ['native', 'override', 'named'].map(layout => ({ mode: mode as 'queued' | 'restart' | 'continue', layout: layout as 'native' | 'override' | 'named' }))),
  claudeEnvironment: ['queued', 'restart', 'continue'].flatMap(mode => ['same-dir-override', 'other-override', 'home'].map(change => ({ mode: mode as 'queued' | 'restart' | 'continue', change }))),
  privateLayout: ['queued', 'restart', 'continue'] as const,
  accountRegistry: ['queued', 'restart', 'continue'].flatMap(mode => ['delete', 'repoint'].map(change => ({ mode: mode as 'queued' | 'restart' | 'continue', change }))),
  modelLock: ['queued', 'restart', 'continue'].flatMap(mode => [{ model: 'haiku' }, { effort: 'high' }].map(settings => ({ mode: mode as 'queued' | 'restart' | 'continue', settings }))),
  privateIdentity: ['queued', 'restart', 'continue'].flatMap(mode => ['missing', 'malformed'].map(damage => ({ mode: mode as 'queued' | 'restart' | 'continue', damage }))),
  supportedHomes: ['codex', 'opencode', 'pi', 'omp'] as const,
  authorityRevocation: ['cancel', 'failed', 'done'] as const,
} as const;

export const PROVISION_TEST_FILES = [
  'provision-intent-catalog.test.ts',
  'provision-accepted-grants.test.ts',
  'provision-input-recipes.test.ts',
  'provision-claude-layouts.test.ts',
  'provision-accounts-lifecycle.test.ts',
] as const;

export function provisionMatrixCounts(sources: readonly string[], files: readonly string[] = PROVISION_TEST_FILES): Record<string, number> {
  const counts = Object.fromEntries(Object.keys(PROVISION_ROWS).map(name => { return [name, 0]; }));
  for (const [index, source] of sources.entries()) {
    for (const name of registrationGroups(source, files[index] ?? `provision-source-${index}.test.ts`, 'it.each', 'PROVISION_ROWS', Object.keys(PROVISION_ROWS))) {
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}
