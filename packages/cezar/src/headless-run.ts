import { commandText } from './home/command.ts';
import { createHostDiscovery } from './discovery/catalog.ts';
import { DelegationController } from './delegation/provision.ts';
import { ProviderAuthService, providerAuthChecksDisabled } from './core/provider-auth.ts';
import { applyProviderEnablement } from './core/provider-availability.ts';
import { forwardToSessionGroups } from './core/session-process.ts';
import { loadConfig } from './config.ts';
import { RunStoreOpenError } from './runs/store-open-error.ts';
import type { RunStore } from './runs/store.ts';
import type { Home } from './home/home.ts';
import { RunManager } from './workflows/run.ts';
import { acquireCiResources } from './ci-wait/resources.ts';
import { createRunner } from './core/runner-factory.ts';
import { loadWorkflows } from './workflows/load.ts';
import { ProviderRuntimeAuthObserver } from './server/provider-auth-runtime.ts';
import { providersRequiredByWorkflow, unavailableProviderMessage } from './server/provider-action-gate.ts';
import { loadWorkspaceConfig } from './workspace/config.ts';
import { WorkspaceSemaphore } from './workspace/semaphore.ts';

/** Task access for a headless run (hearsay-tools/cezarion#2784): both on unless a --no-* flag says otherwise. */
export type TaskAccess = { allowWorkers: boolean; allowMessaging: boolean };

export const defaultHeadlessDeps = {
  loadWorkflows, ProviderAuthService, providersRequiredByWorkflow, loadConfig,
  providerAuthChecksDisabled, loadWorkspaceConfig, unavailableProviderMessage,
  applyProviderEnablement, DelegationController, createHostDiscovery,
  forwardToSessionGroups, ProviderRuntimeAuthObserver, WorkspaceSemaphore, RunManager,
  createRunner, process, console,
};

export type HeadlessDeps = typeof defaultHeadlessDeps & {
  initWorkspace: (repoRoot: string, home: Home) => Promise<string | undefined>;
  openStore: (repoRoot: string, opts: { repoHandleSignal: AbortSignal }) => RunStore;
  onTerminal: () => boolean;
};

export async function runHeadless(
  home: Home,
  repoRoot: string,
  task: string,
  workflowName: string | undefined,
  model: string | undefined,
  access: TaskAccess,
  deps: HeadlessDeps,
): Promise<void> {
  await deps.initWorkspace(repoRoot, home);
  const { workflows, issues } = await deps.loadWorkflows(repoRoot);
  for (const issue of issues) deps.console.error(`! skipped ${issue.path}: ${issue.message}`);
  const name = workflowName ?? 'quick-task';
  const workflow = workflows.find((w) => w.name === name);
  if (!workflow) {
    deps.console.error(`unknown workflow: ${name} (available: ${workflows.map((w) => w.name).join(', ')})`);
    deps.process.exitCode = 1;
    return;
  }

  const providerAuth = new deps.ProviderAuthService();
  const requiredProviders = deps.providersRequiredByWorkflow(
    workflow,
    (await deps.loadConfig(repoRoot, home)).defaultRunner,
  );
  if (requiredProviders.length > 0 && !deps.providerAuthChecksDisabled()) {
    const [discovered, workspace] = await Promise.all([
      providerAuth.status(),
      deps.loadWorkspaceConfig(home.workspaceConfig),
    ]);
    const blocked = deps.unavailableProviderMessage(
      requiredProviders,
      deps.applyProviderEnablement(discovered, workspace.disabledProviders),
    );
    if (blocked) {
      deps.console.error(blocked);
      deps.process.exitCode = 1;
      return;
    }
  }

  const repoHandleController = new AbortController();
  let store: RunStore;
  try {
    store = deps.openStore(repoRoot, { repoHandleSignal: repoHandleController.signal });
  } catch (error) {
    if (!(error instanceof RunStoreOpenError)) throw error;
    deps.console.error(error.message);
    deps.process.exitCode = 1;
    return;
  }
  const delegation = await deps.DelegationController.start();
  delegation.service.setDiscovery(deps.createHostDiscovery(repoRoot, providerAuth, home));
  // Agent sessions lead their own process groups (hearsay-tools/cezarion#890): pass Ctrl-C and
  // SIGTERM on, then end by the same signal, as this process did before it had a handler.
  const forward = (signal: NodeJS.Signals) => {
    deps.forwardToSessionGroups(signal);
    deps.process.off('SIGINT', onSigint); deps.process.off('SIGTERM', onSigterm); deps.process.off('SIGHUP', onSighup);
    deps.process.kill(deps.process.pid, signal);
  };
  const onSigint = () => forward('SIGINT');
  const onSigterm = () => forward('SIGTERM');
  // Off a terminal the listener is a no-op that ignores the hangup (see onTerminal).
  const onSighup = deps.onTerminal() ? () => forward('SIGHUP') : () => {};
  deps.process.on('SIGINT', onSigint); deps.process.on('SIGTERM', onSigterm);
  if (deps.process.platform !== 'win32') deps.process.on('SIGHUP', onSighup);
  try {
    // Headless tasks still appear in the cockpit later, so persist the same
    // task-local recovery event when a credential expires after the preflight.
    const providerRuntimeAuth = new deps.ProviderRuntimeAuthObserver(providerAuth, () => {}, undefined, home);
    providerRuntimeAuth.watch(store);
    // Headless runs enforce the same workspace-level cap/memory limit (step
    // 2.5) — one refreshed semaphore, even with just one manager in play.
    const semaphore = new deps.WorkspaceSemaphore({ home });
    await semaphore.refresh();
    const manager = new deps.RunManager(store, repoRoot, { home, createRunner: deps.createRunner, semaphore, acquireCiResources });
    delegation.attachProject({ id: 'headless', root: repoRoot, store, manager, home });

    store.on('event', ({ event }) => printHeadlessEvent(event, deps.console));

    const run = manager.startRun(workflow, { task, model, ...access });
    // `review` is terminal here too (spec 009) — headless runs must not hang on
    // the GUI's review gate; the diff waits on the task branch/cockpit instead.
    const final = await new Promise<string>((resolveStatus) => {
      store.on('run', (r) => {
        if (r.id === run.id && ['done', 'review', 'failed', 'cancelled'].includes(r.status)) resolveStatus(r.status);
      });
    });
    const record = store.getRun(run.id);
    if (final === 'review') {
      deps.console.log(commandText(`\n  changes ready for review on branch ${record?.branch ?? '?'} — inspect them in the cockpit: npx cezarion`));
    }
    deps.console.log(commandText(`\nrun ${final} — ${record?.tokensUsed ?? 0} tokens — details in the cockpit: npx cezarion`));
    deps.process.exitCode = final === 'done' || final === 'review' ? 0 : 1;
  } finally {
    deps.process.off('SIGINT', onSigint); deps.process.off('SIGTERM', onSigterm); deps.process.off('SIGHUP', onSighup);
    await delegation.close();
    // A slow GitHub child must not keep a completed headless task alive. Any handle that
    // already arrived has repaired the store; an unfinished lookup remains unknown.
    repoHandleController.abort();
    store.close();
  }
}

export function printHeadlessEvent(event: Record<string, unknown>, output: Pick<Console, 'log' | 'error'>): void {
  switch (event.type) {
    case 'text':
      output.log(String(event.text ?? ''));
      break;
    case 'tool-call':
      output.log(`  → ${String(event.tool)} ${previewJson(event.input)}`);
      break;
    case 'tool-result':
      output.log(`  ← ${firstLine(String(event.result ?? ''))}`);
      break;
    case 'check-output':
      output.log(String(event.text ?? ''));
      break;
    case 'step-start':
      output.log(`\n── step: ${String(event.name)} ${Number(event.iteration) > 1 ? `(attempt ${event.iteration})` : ''}`);
      break;
    case 'note':
    case 'lifecycle':
      output.log(`  · ${String(event.message ?? '')}`);
      break;
    case 'error':
      output.error(`  ✗ ${String(event.message ?? '')}`);
      break;
  }
}

function previewJson(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
  } catch {
    return '';
  }
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}
