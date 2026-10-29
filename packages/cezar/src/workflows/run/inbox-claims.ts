import { randomUUID } from 'node:crypto';
import type { AgentSession } from '../../core/agent-runner.ts';
import { hasLiveInboxClaim } from '../../delegation/input.ts';
import type { InboxClaim } from '@open-mercato/cezar-contract/delegation';
import type { RunRecord } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import { historyDeletionPending } from './run-guards.ts';
import type { RunModuleContext } from './types.ts';

interface InboxClaimsHost {
  activeGet(runId: string): ActiveRun | undefined;
  executionBlockedByRootFinish(run: RunRecord): boolean;
  workerExecutionStopped(runId: string): boolean;
  reconcileWorkerWaits(): void;
  retireEmptyWake(runId: string): void;
  deliverConversationInput(runId: string): void;
  settleIdleBoundary(runId: string, state: ActiveRun, session: AgentSession): void;
  releaseSlot(): void;
  providerOwnsInboxInput(runId: string, id: string): boolean;
  canClaimInboxInput(runId: string, id: string): boolean;
  armInboxClaimExpiry(runId: string): void;
}

export class InboxClaims {
  readonly inboxClaimTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly context: RunModuleContext, private readonly host: InboxClaimsHost) {}

  dispose(): void {
    for (const timer of this.inboxClaimTimers.values()) clearTimeout(timer);
    this.inboxClaimTimers.clear();
  }

  /** A wait wake is only a pointer. Only provider submission/opening prompts own delivery. */
  providerOwnsInboxInput(runId: string, id: string): boolean {
    const state = this.host.activeGet(runId);
    return !!state?.agentInputFlight?.inputIds.includes(id) || state?.openingAgentInputId === id ||
      this.context.store.getRun(runId)?.continuationMessage?.agentInputId === id;
  }

  canClaimInboxInput(runId: string, id: string): boolean {
    const run = this.context.store.getRun(runId);
    const input = run?.agentInputs?.find(entry => entry.id === id);
    return !this.context.disposed() && !!run && ['queued', 'running', 'waiting'].includes(run.status) &&
      !historyDeletionPending(this.context.store, runId) && !this.host.executionBlockedByRootFinish(run) && !this.host.workerExecutionStopped(runId) &&
      !!input && input.source === 'agent' && !!input.conversation && !input.deliveredAt &&
      !hasLiveInboxClaim(input) && !this.host.providerOwnsInboxInput(runId, id);
  }

  /** The service supplies authorized, bounded IDs; claim and flight reservations are synchronous. */
  reserveInboxInputs(runId: string, generation: string, ids: readonly string[]): { receiptId: string; expiresAt: string; inputIds: string[] } | undefined {
    if (!ids.length || ids.some(id => !this.host.canClaimInboxInput(runId, id)) ||
      this.context.store.getRun(runId)?.agentInputs?.some(input => !input.deliveredAt && hasLiveInboxClaim(input))) return undefined;
    const claim: InboxClaim = { receiptId: randomUUID(), generation, expiresAt: new Date(Date.now() + 120_000).toISOString() };
    this.context.store.claimInboxInputs(runId, ids, claim);
    this.host.armInboxClaimExpiry(runId);
    return { receiptId: claim.receiptId, expiresAt: claim.expiresAt, inputIds: [...ids] };
  }

  acknowledgeInbox(runId: string, generation: string, receiptId: string): 'acknowledged' | 'already-acknowledged' {
    if (this.context.disposed() || this.context.store.getRun(runId)?.agentInputs?.some(input => input.inboxClaim?.receiptId === receiptId &&
      !input.deliveredAt && this.host.providerOwnsInboxInput(runId, input.id))) throw new Error('inbox receipt displaced');
    const result = this.context.store.ackInboxInputs(runId, receiptId, generation, new Date().toISOString());
    this.host.armInboxClaimExpiry(runId);
    this.host.reconcileWorkerWaits();
    this.host.retireEmptyWake(runId);
    this.host.deliverConversationInput(runId);
    // A done the turn end kept behind this claim settles now that the input is read: the inbox
    // acknowledgement is the boundary's last owed input (hearsay-tools/cezarion#1620).
    const state = this.host.activeGet(runId);
    if (state?.session?.open) this.host.settleIdleBoundary(runId, state, state.session);
    this.host.releaseSlot();
    return result;
  }

  releaseInbox(runId: string, generation: string, receiptId: string): 'released' {
    if (this.context.disposed()) throw new Error('inbox manager disposed');
    const result = this.context.store.releaseInboxInputs(runId, receiptId, generation);
    this.host.armInboxClaimExpiry(runId);
    this.host.reconcileWorkerWaits();
    this.host.deliverConversationInput(runId);
    this.host.releaseSlot();
    return result;
  }

  /** Expiry is an independent wake source, including after the provider's last turn. */
  armInboxClaimExpiry(runId: string): void {
    const previous = this.inboxClaimTimers.get(runId);
    if (previous) clearTimeout(previous);
    this.inboxClaimTimers.delete(runId);
    if (this.context.disposed()) return;
    const deadlines = (this.context.store.getRun(runId)?.agentInputs ?? []).flatMap(input =>
      input.inboxClaim && !input.inboxClaim.acknowledgedAt ? [Date.parse(input.inboxClaim.expiresAt)] : []);
    if (!deadlines.length) return;
    let warned = false;
    const expire = () => {
      this.inboxClaimTimers.delete(runId);
      if (this.context.disposed() || !this.context.store.getRun(runId)) return;
      try {
        this.context.store.clearExpiredInboxClaims(runId, new Date().toISOString());
        this.host.reconcileWorkerWaits();
        this.host.deliverConversationInput(runId);
        this.host.armInboxClaimExpiry(runId);
        this.host.releaseSlot();
      } catch {
        if (!warned) console.warn('[cez] inbox expiry checkpoint failed; retrying in 1 second');
        warned = true;
        if (!this.context.disposed()) arm(1_000);
      }
    };
    const arm = (delay: number) => {
      const timer = setTimeout(expire, delay);
      timer.unref?.(); this.inboxClaimTimers.set(runId, timer);
    };
    arm(Math.max(0, Math.min(...deadlines) - Date.now()));
  }

}
