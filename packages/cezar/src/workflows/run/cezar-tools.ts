import { randomUUID } from 'node:crypto';
import type { acquireCiResources } from '../../ci-wait/resources.ts';
import { previewCdpSession, previewRunContext, type PreviewHostLike } from '../../preview/registration.ts';
import type { RunStore, RunRecord } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import type { AutomationToolService, RunModuleContext } from './types.ts';
import type { CezarToolHandlers } from '../../ci-wait/controller.ts';
import { askErrorMessage, waitErrorMessage, scheduleRefusal } from '../../ci-wait/errors.ts';
import { askErrorCodeSchema, waitErrorCodeSchema, type CezarAskAnswer, type CezarCancelWaitAnswer, type CezarWaitRequestInput, type CezarAskRequest, type CezarDoneRequest, type CezarDoneAnswer, type WaitVia, type HumanWaitEntry, type PrWaitEntry, type TimerWaitEntry, type WorkerWaitEntry, type ProcessWaitEntry, type PeerWaitEntry } from '@open-mercato/cezar-contract/waits';
import type { PreviewServeRequest, PreviewServeResult, PreviewStopRequest, PreviewStopResult } from '@open-mercato/cezar-contract/preview';
import { CANCEL_MESSAGES, openWaitList, waitAnswerKind } from '../waits.ts';

/** How long a schedule tool call waits for the service after recovery (hearsay-tools/cezarion#1465). */
const AUTOMATION_TOOLS_READY_MS = 30_000;
export class AutomationToolsSlot {
  constructor(_context: RunModuleContext, private readonly cockpitAttached: () => boolean) {}
  private automationTools?: AutomationToolService | undefined;
  private automationToolsWaiters = new Set<() => void>();
  setAutomationTools(tools: AutomationToolService | undefined): void {
    this.automationTools = tools;
    if (tools) for (const wake of [...this.automationToolsWaiters]) wake();
  }
  async awaitAutomationTools(signal: AbortSignal): Promise<AutomationToolService | undefined> {
    if (this.automationTools || !this.cockpitAttached()) return this.automationTools;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); this.automationToolsWaiters.delete(done); resolve(); };
      // bound: the CLI's 30 s startup retry; the server attaches the service right after recovery.
      const timer = setTimeout(done, AUTOMATION_TOOLS_READY_MS);
      signal.addEventListener('abort', done, { once: true });
      this.automationToolsWaiters.add(done);
    });
    return this.automationTools;
  }
}

export type ToolHost = {
  store: RunStore;
  registerWait(runId: string, request: CezarWaitRequestInput, via: WaitVia, generation: string, signal?: AbortSignal): Promise<PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry>;
  registerAsk(runId: string, request: CezarAskRequest, generation: string, signal?: AbortSignal): Promise<HumanWaitEntry>;
  cancelWait(runId: string, waitId: string, generation: string): { cancelled: true } | { cancelled: false; code: 'not_found' | 'already_resolved' | 'human_question' };
  acceptDone(runId: string, generation: string, request: CezarDoneRequest, signal?: AbortSignal): CezarDoneAnswer;
  registerPreviewServer(runId: string, request: PreviewServeRequest, signal?: AbortSignal): Promise<PreviewServeResult>;
  stopPreviewServer(runId: string, request: PreviewStopRequest, signal?: AbortSignal): Promise<PreviewStopResult>;
  awaitAutomationTools(signal: AbortSignal): Promise<AutomationToolService | undefined>;
};
export function cezarToolHandlers(runId: string, generation: string, host: ToolHost): CezarToolHandlers {
  const listOpen = () => openWaitList(host.store.getRun(runId)?.waits ?? []);
  const thrownCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return {
    registerWait: async (request, via, signal) => {
      try {
        const wait = await host.registerWait(runId, request, via, generation, signal);
        // The tools only open agent waits, which always carry a deadline.
        if (wait.deadline === undefined) throw new Error('registered wait has no deadline');
        return { answer: { ok: true, wait_id: wait.id, kind: waitAnswerKind(wait), deadline: wait.deadline, open_waits: listOpen() }, wait };
      } catch (error) {
        const code = waitErrorCodeSchema.safeParse(thrownCode(error));
        if (!code.success) throw error;
        return { answer: { ok: false, code: code.data, message: waitErrorMessage(code.data), open_waits: listOpen() } };
      }
    },
    ask: async (request, signal): Promise<CezarAskAnswer> => {
      try {
        const wait = await host.registerAsk(runId, request, generation, signal);
        return { ok: true, wait_id: wait.id, open_waits: listOpen() };
      } catch (error) {
        const code = askErrorCodeSchema.safeParse(thrownCode(error));
        if (!code.success) throw error;
        return { ok: false, code: code.data, message: askErrorMessage(code.data), open_waits: listOpen() };
      }
    },
    cancelWait: async ({ wait_id }) => {
      let outcome: { cancelled: true } | { cancelled: false; code: 'not_found' | 'already_resolved' | 'human_question' };
      try { outcome = host.cancelWait(runId, wait_id, generation); }
      catch { return { cancelled: false, code: 'unavailable', message: waitErrorMessage('unavailable'), open_waits: listOpen() }; }
      if (outcome.cancelled) return { cancelled: true, wait_id, open_waits: listOpen() };
      return { cancelled: false, code: outcome.code, message: CANCEL_MESSAGES[outcome.code], open_waits: listOpen() } satisfies CezarCancelWaitAnswer;
    },
    finishTurn: async (request, signal) => host.acceptDone(runId, generation, request, signal),
    registerPreview: (request, signal) => host.registerPreviewServer(runId, request, signal),
    stopPreview: (request, signal) => host.stopPreviewServer(runId, request, signal),
    // A schedule belongs to the project, not to this run: any session there may manage one.
    scheduleTask: async (request, signal) => {
      const tools = await host.awaitAutomationTools(signal);
      return tools ? tools.scheduleTask(request) : scheduleRefusal('unavailable');
    },
    scheduledTasks: async (request, signal) => {
      const tools = await host.awaitAutomationTools(signal);
      return tools ? tools.scheduledTasks(request) : scheduleRefusal('unavailable');
    },
  };
}


export function toolSessionRefusal(run: RunRecord | undefined, state: ActiveRun | undefined, active: ActiveRun | undefined, generation: string, signal: AbortSignal | undefined, disposed: boolean) {
  if (disposed) return 'manager_disposed' as const;
  if (signal?.aborted) return 'capability_revoked' as const;
  if (!run) return 'run_missing' as const;
  if (!['running', 'waiting'].includes(run.status)) return 'run_not_running' as const;
  if (run.stopping) return 'run_stopping' as const;
  if (!state || active !== state) return 'session_replaced' as const;
  if (!state.session?.open) return 'session_closed' as const;
  if (state.cancelled) return 'run_cancelled' as const;
  if (state.finishRequested) return 'finish_requested' as const;
  if (state.ciGeneration !== generation) return 'generation_mismatch' as const;
  return undefined;
}


export interface CiSessionHost {
  active: ReadonlyMap<string, ActiveRun>;
  ciResources(): ReturnType<typeof acquireCiResources>;
  cezarToolHandlers(runId: string, generation: string): CezarToolHandlers;
  preview(): PreviewHostLike | undefined;
  cockpit(): { origin: string; projectId: string } | undefined;
}

/** Provision the same capability and descriptor on every start, Continue and recovered launch. */
export async function provisionCiSession(context: RunModuleContext, host: CiSessionHost, runId: string, state: ActiveRun) {
  state.revokeCiTools?.();
  state.revokeCiTools = undefined;
  state.ciGeneration = randomUUID();
  state.ciTurnId = randomUUID();
  const generation = state.ciGeneration;
  const controller = await host.ciResources().controller();
  state.toolless = !controller;
  if (!controller || context.disposed() || state.cancelled || host.active.get(runId) !== state) return;
  const provisioned = previewCdpSession(controller.provision(host.cezarToolHandlers(runId, generation)), { host: host.preview(), cockpitOrigin: host.cockpit()?.origin, runId, worktree: !!context.store.getRun(runId)?.worktreePath, context: () => previewRunContext(context.store, context.dataDir, runId) });
  state.revokeCiTools = provisioned.revoke;
  return provisioned;
}
