import { discoverTasks } from './task-discovery.ts';
import { discoveredRunners, missingModelChoices, type HostDiscovery } from '../discovery/catalog.ts';
import { assertConversationCapacity, assertFamilySender, byCreatedAtAndId, commitAccepted, familyPair, inboxEntryIn, isRootTask, notDeliveredInstruction,
  finishing, orphanedPeerMessage, peerPair, takesPart, projectConversationEvents, reconcileConversationState, replyOutcomes, type InboxEntry } from './conversations.ts';
export { rootDelegation } from './conversations.ts';
import { collectWorkerEvidence, revalidateRetainedWorkerResult, workerRevision } from './results.ts';
import { join } from 'node:path';
import { prepareWorkerContext, workerContextTask } from './context.ts';
import { acceptedWorkerIdentitySchema, workerContextHash, workerWorkflowHash } from './execution-identity.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  discoveryRequestSchema,
  type DiscoveryRequest,
  type DiscoveryResponse,
} from '@open-mercato/cezar-contract/discovery';
import {
  CONVERSATION_PAGE_MESSAGES,
  decodeConversationCursor,
  encodeConversationCursor,
  MAX_CONVERSATION_REQUEST_SECONDS,
  conversationSendRequestSchema,
  conversationInspectRequestSchema,
  conversationCancelRequestSchema,
  inboxReceiptRequestSchema,
  requestWaitRequestSchema,
  type ConversationSendRequest,
  type ConversationSendResult,
  type ConversationInspectRequest,
  type ConversationInspectResult,
  type ConversationCancelRequest,
  type ConversationMessage,
  type ConversationState,
  type InboxReserveResult,
  type InboxReceiptRequest,
  type InboxReceiptResult,
  type RequestWaitRequest,
  type RequestOutcome,
} from '@open-mercato/cezar-contract/conversations';
import {
  workerSpawnRequestSchema,
  workerSteerRequestSchema,
  workerWaitRequestSchema,
  workerParamsSchema,
  workerCancelWaitRequestSchema,
  type WorkerCancelWaitRequest,
  type WorkerListPage,
  type WorkerListQuery,
  type WorkerCollectedResult,
  type WorkerDestroy,
  type WorkerDestroyResult,
  type WorkerInspection,
  type WorkerOperation,
  type WorkerParams,
  type WorkerSpawnRequest,
  type WorkerSteerRequest,
  type WorkerWait,
  type WorkerWaitRequest,
} from '@open-mercato/cezar-contract/delegation';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { completionWaitEntry, hasWorkerDeadline, workerCompletionWaitProjection, workerWaitEntryToLegacy, type DeadlinedWorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import type { RunStore, RunRecord } from '../runs/store.ts';
import { assertConversationIdFree, ConversationIdInUseError } from '../runs/conversation-identity.ts';
import { workerDestroyView, workerOutcome } from '../runs/delegation-state.ts';
import type { DelegationExecutionSettings, RunManager } from '../workflows/run.ts';
import { QUICK_TASK_WORKFLOW, skillTaskSteps, plannedWorkflow, allowedToolsForStep, stepKind, type WorkflowDef, type WorkflowStepDef } from '../workflows/types.ts';
import { discoverSkills } from '../skills.ts';
import { findWorkflow } from '../workflows/load.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import type { Caller } from './credentials.ts';
import { isAuthenticatedCaller } from './credentials.ts';
import { parseDelegationEffort } from './effort.ts';
import { authorizeWorkerList, authorizeSpawn, authorizeSpawnReplay, authorizeWorker, authorizeCancelWait, authorizeRetainedResult, DelegationPolicyError } from './policy.ts';
import { releaseThenRemoveOwnedWorkspace } from '../git-worktree-release.ts';
import { gitCommonDir, planOwnedWorkspace, readOwnedDiff, resolveWorkerBaseline, WorkspaceHeldError } from './workspace.ts';
import { holdersStillHold, observeDestroy, recordHolders, type DestroyObservation } from './destroy-observation.ts';
import { DESTROY_ATTENTION_ATTEMPTS, DESTROY_BACKOFF, retryDelayMs, type Backoff } from './retry-backoff.ts';

export type DelegationProject = { id: string; root: string; store: RunStore; manager: RunManager };

/**
 * Resolve an explicit workflow or skill. With neither, use the built-in quick-task constant, not
 * a repo override. Require at least one agent step and resolve its runner/account independently.
 */
async function resolveSpawnWorkflow(project: Pick<DelegationProject, 'root' | 'manager'>, request: WorkerSpawnRequest): Promise<WorkflowDef> {
  const root = project.root;
  if (request.skill !== undefined) {
    const skills = await discoverSkills(root, { builtin: project.manager.builtinSkills?.() ?? [] });
    if (!skills.some(skill => skill.name === request.skill)) throw new DelegationPolicyError('invalid_input', `Unknown skill "${request.skill}"; available: ${skills.map(skill => skill.name).join(', ')}`);
    return plannedWorkflow(skillTaskSteps(request.skill));
  }
  if (request.workflow === undefined) return QUICK_TASK_WORKFLOW;
  const workflow = await findWorkflow(root, request.workflow);
  if (!workflow) throw new DelegationPolicyError('invalid_input', `Unknown workflow "${request.workflow}"; the catalog holds the built-in quick-task and .ai/cezar/workflows/*.yaml`);
  if (!workflow.steps.some(step => stepKind(step) === 'agent')) throw new DelegationPolicyError('invalid_input', `Workflow "${request.workflow}" has no agent step for a worker to run`);
  return workflow;
}

type WorkerGrants = { allowedTools?: string[]; bashAllowlist?: string[] };
/**
 * Intersect authored step grants with parent grants. Unset step grants inherit; unset parent
 * tools use the runner default and unset Bash rules mean unrestricted Bash. Native enforcement
 * remains runner-specific.
 */
function narrowGrants(parent: WorkerGrants, step: WorkflowStepDef, runner: RunnerId): WorkerGrants {
  const parentTools = step.allowedTools === undefined ? parent.allowedTools : parent.allowedTools ?? allowedToolsForStep(undefined, runner);
  const allowedTools = step.allowedTools === undefined ? parent.allowedTools : step.allowedTools.filter(tool => parentTools!.includes(tool));
  const bashAllowlist = step.bashAllowlist === undefined ? parent.bashAllowlist
    : parent.bashAllowlist === undefined ? [...step.bashAllowlist] : step.bashAllowlist.filter(command => parent.bashAllowlist!.includes(command));
  return { ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }), ...(bashAllowlist === undefined ? {} : { bashAllowlist: [...bashAllowlist] }) };
}

/** One resolved agent step: what the identity pins and what the public definition carries. */
type ResolvedSpawnStep = { step: WorkflowStepDef; settings: DelegationExecutionSettings; grants: WorkerGrants };

/**
 * Resolve each agent step before acceptance. Step choices override spawn defaults; equal
 * selections share resolution. Bind account, runner, model, effort and narrowed grants together.
 */
async function resolveSpawnSteps(manager: RunManager, parentId: string, request: WorkerSpawnRequest, workflow: WorkflowDef, validateModel: (step: WorkflowStepDef, settings: DelegationExecutionSettings) => Promise<void>): Promise<ResolvedSpawnStep[]> {
  const cache = new Map<string, Promise<DelegationExecutionSettings>>();
  const resolved: ResolvedSpawnStep[] = [];
  for (const step of workflow.steps) {
    if (stepKind(step) === 'check') continue;
    const selection = {
      ...(step.runner ?? request.backend) === undefined ? {} : { backend: step.runner ?? request.backend },
      ...(step.model ?? request.model) === undefined ? {} : { model: step.model ?? request.model },
      ...(step.effort ?? request.effort) === undefined ? {} : { effort: step.effort ?? request.effort },
      ...(step.agentProfile === undefined ? {} : { agentProfile: step.agentProfile }),
    };
    const key = JSON.stringify(selection);
    let pending = cache.get(key);
    if (!pending) { pending = manager.selectDelegationExecutionSettings(parentId, selection, settings => validateModel(step, settings)); cache.set(key, pending); }
    const settings = await pending;
    resolved.push({ step, settings, grants: narrowGrants({ ...(settings.allowedTools === undefined ? {} : { allowedTools: settings.allowedTools }),
      ...(settings.bashAllowlist === undefined ? {} : { bashAllowlist: settings.bashAllowlist }) }, step, settings.runner) });
  }
  return resolved;
}

function stepIdentityFields({ settings, grants }: ResolvedSpawnStep) {
  return { account: settings.accountBinding, grants, ...(settings.model === undefined ? {} : { model: settings.model }), ...(settings.effort === undefined ? {} : { effort: settings.effort }) };
}
export const delegationEnabled = () => process.env.CEZ_DELEGATION === '1';

type ConversationPair = { project: DelegationProject; sender: RunRecord; recipient: RunRecord } &
  ({ relationship: 'peer' } | { relationship: 'family'; root: RunRecord; worker: RunRecord });

/** A single controller's shared policy adapter; managers retain scheduling and lifecycle ownership. */
export class DelegationService {
  private discovery?: HostDiscovery;
  setDiscovery(discovery: HostDiscovery): void { this.discovery = discovery; }
  async discover(caller: Caller, value: DiscoveryRequest): Promise<DiscoveryResponse> {
    const project = this.context(caller);
    const request = discoveryRequestSchema.parse(value);
    if (request.kind === 'tasks') return discoverTasks(project.store, caller.runId, request);
    // Discovery accompanies spawn authority, including roots persisted before this command existed.
    authorizeSpawnReplay(caller, project.store.getRun(caller.runId), project.id);
    if (!this.discovery) throw new DelegationPolicyError('unavailable_transport', 'Host discovery is unavailable');
    return request.kind === 'models' ? this.discovery.models.get(request.runner) : discoveredRunners(await this.discovery.providers());
  }
  private async validateModels(request: WorkerSpawnRequest, resolved: Pick<ResolvedSpawnStep, 'step' | 'settings'>[]): Promise<void> {
    if (!this.discovery) return;
    const checked = new Set<string>();
    for (const { step, settings } of resolved) {
      // The host catalog says nothing authoritative about a different named account.
      if (settings.accountBinding?.profileId !== 'default') continue;
      const model = (step.model ?? request.model)?.trim();
      if (!model) continue; // Inherited/default models keep their existing resolution path.
      const runner = settings.runner;
      const key = JSON.stringify([runner, model]);
      if (checked.has(key)) continue;
      checked.add(key);
      const choices = await missingModelChoices(this.discovery, runner, model, settings.model, settings.modelIdentity);
      if (!choices) continue;
      const alternatives = choices.otherRunners.join(', ') || 'none';
      const available = choices.availableModels.map(row => `${row.id}${row.effortLevels ? ` (effort: ${row.effortLevels.join(', ') || 'none advertised'})` : ''}`).join('; ');
      // Full choices remain structured even when the human-readable error reaches its bound.
      throw new DelegationPolicyError('invalid_input', `Model "${model}" is not in the ${runner} catalog. Available models: ${available.slice(0, 1200)}. Other runners listing "${model}": ${alternatives}. Use cez discover models --runner=${runner}.`, choices);
    }
  }
  private projects = new Map<string, DelegationProject>();
  private serial = new Map<string, Promise<unknown>>();
  private destroyRetryTimers = new Map<string, Map<string, NodeJS.Timeout>>();
  private destroyRetryInFlight = new Map<string, Set<string>>();
  /** What each pending destroy's last full attempt observed (hearsay-tools/cezarion#879). */
  private destroyObservations = new Map<string, Map<string, DestroyObservation>>();
  /** Each project's common Git dir, resolved once per registration for the change check. */
  private commonDirs = new Map<string, Promise<string | undefined>>();
  // Private and overridable so tests need not wait out production cadence.
  private destroyBackoff: Backoff = DESTROY_BACKOFF;
  private destroyAttentionAttempts = DESTROY_ATTENTION_ATTEMPTS;
  /** How long destroy waits for proven termination; private and overridable so tests need not wait it out. */
  private terminationTimeoutMs = 30_000;
  registerProject(project: DelegationProject): () => void {
    const existing = this.projects.get(project.id);
    if (existing?.store === project.store && existing.manager === project.manager) return () => {};
    this.clearDestroyRetries(project.id);
    existing?.manager.pauseWorkerCleanup();
    this.projects.set(project.id, project);
    return () => { if (this.projects.get(project.id) === project) { this.clearDestroyRetries(project.id); project.manager.pauseWorkerCleanup(); this.projects.delete(project.id); } };
  }
  private clearDestroyRetries(projectId: string): void {
    for (const timer of this.destroyRetryTimers.get(projectId)?.values() ?? []) clearTimeout(timer);
    this.destroyRetryTimers.delete(projectId);
    this.destroyRetryInFlight.delete(projectId);
    this.destroyObservations.delete(projectId);
    this.commonDirs.delete(projectId);
  }
  /** Called only after manager recovery, when persisted destroy intents may be retried. */
  armDestroyRetries(projectId: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    project.manager.recoverWorkerCleanup();
    // A pending destroy keeps its worker in the live set (`isLiveRecord`), so this is every one.
    for (const run of project.store.listRuns()) this.scheduleDestroyRetry(project, run.id);
  }
  /** Arms the next automatic attempt of a pending destroy. A retry state written before a restart
   * resumes where it was; the fast cadence is the floor, and a little over the cap the ceiling, so
   * a clock that jumped cannot park a destroy for days (hearsay-tools/cezarion#879). */
  private scheduleDestroyRetry(project: DelegationProject, workerId: string): void {
    if (this.projects.get(project.id) !== project) return;
    const run = project.store.getRun(workerId);
    if (run?.delegation?.role !== 'worker' || !run.delegation.destroy || run.delegation.destroy.phase === 'complete') return;
    let timers = this.destroyRetryTimers.get(project.id);
    if (!timers) { timers = new Map(); this.destroyRetryTimers.set(project.id, timers); }
    if (timers.has(workerId) || this.destroyRetryInFlight.get(project.id)?.has(workerId)) return;
    const { fastMs, capMs } = this.destroyBackoff;
    const nextAt = run.destroyRetry ? Date.parse(run.destroyRetry.nextAt) - Date.now() : 0;
    const delay = Math.min(Math.max(fastMs, nextAt), capMs * 1.1);
    const timer = setTimeout(() => {
      timers.delete(workerId);
      if (this.projects.get(project.id) !== project) return;
      let inFlight = this.destroyRetryInFlight.get(project.id);
      if (!inFlight) { inFlight = new Set(); this.destroyRetryInFlight.set(project.id, inFlight); }
      inFlight.add(workerId);
      void this.destroyTick(project, workerId).catch(() => undefined).finally(() => {
        inFlight.delete(workerId);
        this.scheduleDestroyRetry(project, workerId);
      });
    }, delay);
    timer.unref?.();
    timers.set(workerId, timer);
  }
  /** One automatic attempt. It runs in full only when something its last full attempt observed has
   * changed, or a holder it named has exited; either way it records the attempt and when the next
   * is due, and from the attention threshold on the cockpit says the cleanup needs attention. */
  private destroyTick(project: DelegationProject, workerId: string) {
    return this.serialized(`worker:${project.id}:${workerId}`, async () => {
      const check = () => {
        if (this.projects.get(project.id) !== project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
        const current = project.store.getRun(workerId);
        if (current?.delegation?.role !== 'worker' || current.delegation.workspace.ownerRunId !== workerId || !current.delegation.destroy || current.delegation.destroy.phase === 'complete') {
          throw new DelegationPolicyError('incompatible_state', 'Worker destroy is no longer pending');
        }
        return current;
      };
      check();
      const seen = this.destroyObservations.get(project.id)?.get(workerId);
      const dataDir = join(project.root, '.ai/cezar');
      const unchanged = !!seen && holdersStillHold({ store: project.store, dataDir, workerId, holders: seen.holders }) &&
        seen.key === observeDestroy({ store: project.store, dataDir, commonDir: await this.commonDir(project), workerId });
      // One automatic full attempt at a time per project: attempts that coincide (every pending destroy after a
      // restart) would otherwise contend for the worktree mutation lock and come back lock-busy, never skipped.
      if (!unchanged) await this.serialized(`destroy-retries:${project.id}`, () => this.destroyAttempt(project, workerId, check, 'scheduled')).catch(() => undefined);
      if (this.projects.get(project.id) !== project) return;
      const current = project.store.getRun(workerId);
      if (current?.delegation?.role !== 'worker' || !current.delegation.destroy || current.delegation.destroy.phase === 'complete') return;
      const attempts = (current.destroyRetry?.attempts ?? 0) + 1;
      const retry = { attempts, nextAt: new Date(Date.now() + retryDelayMs(attempts, this.destroyBackoff)).toISOString(),
        ...(attempts >= this.destroyAttentionAttempts ? { needsAttention: true as const } : {}) };
      project.store.commitDestroyRetry(workerId, retry);
    });
  }
  private commonDir(project: DelegationProject): Promise<string | undefined> {
    let dir = this.commonDirs.get(project.id);
    if (!dir) {
      // A failure is not cached: the next attempt asks again, and until then the check is record-only.
      dir = gitCommonDir(project.root).catch(() => { this.commonDirs.delete(project.id); return undefined; });
      this.commonDirs.set(project.id, dir);
    }
    return dir;
  }
  private observeAttempt(project: DelegationProject, workerId: string, seen?: DestroyObservation): void {
    if (this.projects.get(project.id) !== project) return;
    let observations = this.destroyObservations.get(project.id);
    if (!seen) { observations?.delete(workerId); return; }
    if (!observations) { observations = new Map(); this.destroyObservations.set(project.id, observations); }
    observations.set(workerId, seen);
  }
  private context(caller: Caller) {
    if (!delegationEnabled()) throw new DelegationPolicyError('unavailable_transport', 'Delegation is unavailable');
    const project = isAuthenticatedCaller(caller) ? this.projects.get(caller.projectId) : undefined;
    if (!project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    return project;
  }
  private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.serial.set(key, next);
    try { return await next; } finally { if (this.serial.get(key) === next) this.serial.delete(key); }
  }
  private target(caller: Caller, params: WorkerParams, operation: WorkerOperation) {
    const project = this.context(caller);
    const { workerId } = workerParamsSchema.parse(params);
    const parent = project.store.getRun(caller.runId);
    const worker = project.store.getRun(workerId);
    authorizeWorker(caller, worker, operation, parent, project.id);
    return { project, parent: parent!, worker: worker! };
  }
  /**
   * The relationship resolver (spec 2026-10-27-task-communication-protocol § 2): `family` for a
   * root and its direct owned worker, `peer` for two root tasks of the caller's project, and
   * `denied_scope` with one text for everything else. `send` asks for the live pair a new message
   * needs; without it the pair is checked for reading. A peer's own durable records (history, its
   * requests, its inbox) are read through `peerRecords` instead, which a deleted peer does not block.
   */
  private conversationPair(caller: Caller, recipientRunId: string, send = false): ConversationPair {
    const project = this.context(caller);
    const sender = project.store.getRun(caller.runId);
    const recipient = project.store.getRun(recipientRunId);
    const peer = peerPair(sender, recipient, send);
    if (peer) return { project, ...peer };
    const { root, worker } = familyPair(sender, recipient);
    assertFamilySender(sender!, root, send);
    return { project, relationship: 'family', sender: sender!, recipient: recipient!, root, worker };
  }
  /** The caller's own peer records need only its participation: a root task whose own history is
   *  not being deleted. The record read names the counterpart; a deleted peer does not block it. */
  private peerRecords(caller: Caller) {
    const project = this.context(caller);
    const self = project.store.getRun(caller.runId);
    if (self?.delegation?.role !== 'root' || self.delegation.historyDeletion) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    return { project, self };
  }
  /** The ledger a new message lands in (spec § 2, Which ledger holds a message): a new request or
   *  progress message in the sender's family ledger, a follow-up or reply with the request it names. */
  private ledgerFor(pair: ConversationPair, kind: ConversationSendRequest['kind']): RunRecord {
    if (pair.relationship === 'family') return pair.root;
    const ledger = kind === 'reply' ? pair.recipient : pair.sender;
    // A peer that never opened a session has no ledger, so it holds no request to reply to.
    if (ledger.delegation?.role !== 'root') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    return ledger;
  }
  private currentConversation(project: DelegationProject, root: RunRecord): ConversationState {
    // A ledger whose history is being deleted is read as it stands: reconciliation would write to it.
    if (root.delegation?.role === 'root' && root.delegation.historyDeletion) return root.delegation.conversation ?? { messages: [], outcomes: [] };
    const state = reconcileConversationState(root, (id) => project.store.getRun(id), new Date().toISOString(), run => run.delegation?.role === 'worker'
      ? project.store.readWorkerExecution(run.id)?.phase === 'complete' : !project.manager.isActive(run.id), id => project.store.isUnreadable(id));
    if (root.delegation?.role === 'root' && state && state !== root.delegation.conversation) project.store.commitConversation(root.id, state);
    return state ?? { messages: [], outcomes: [] };
  }
  private conversationReceipt(project: DelegationProject, ledgerId: string, message: ConversationSendResult['message']): ConversationSendResult {
    const recipient = project.store.getRun(message.recipientRunId);
    const input = recipient?.agentInputs?.find(input => input.id === message.id);
    const ledger = project.store.getRun(ledgerId);
    const state = ledger?.delegation?.role === 'root' ? ledger.delegation.conversation : undefined;
    const outcome = state?.outcomes.find(outcome => outcome.requestId === (message.requestId ?? message.id));
    return { message, delivery: input?.consumedAt ? 'consumed' : input?.deliveredAt ? 'delivered' : input ? 'queued' : 'not-delivered', ...(outcome ? { outcome } : {}) };
  }
  async send(caller: Caller, value: ConversationSendRequest): Promise<ConversationSendResult> {
    const request = conversationSendRequestSchema.parse(value);
    const initial = this.conversationPair(caller, request.recipientRunId, true);
    return this.serialized(`conversation:${initial.project.id}:${this.ledgerFor(initial, request.kind).id}`, async () => {
      const pair = this.conversationPair(caller, request.recipientRunId, true);
      const { project, sender, recipient, relationship } = pair;
      const root = this.ledgerFor(pair, request.kind);
      const peer = relationship === 'peer';
      if (request.resume && (peer || sender.id !== root.id || recipient.delegation?.role !== 'worker')) {
        throw new DelegationPolicyError('denied_scope', 'Only an active parent may use --resume for its owned worker');
      }
      if (project.store.containsSessionSecret(JSON.stringify(request))) throw new DelegationPolicyError('invalid_input', 'Credentials cannot be included in delegated input');
      const requestHash = createHash('sha256').update(JSON.stringify({ senderRunId: sender.id, ...request })).digest('hex');
      const state = this.currentConversation(project, root);
      const existing = state.messages.find(message => message.id === request.id);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new DelegationPolicyError('invalid_input', 'Message ID payload conflict');
        projectConversationEvents(project.store, project.store.getRun(root.id)!);
        project.manager.reconcileWorkerWaits();
        if (recipient.agentInputs?.some(input => input.id === existing.id && !input.deliveredAt)) project.manager.deliverConversationInput(recipient.id);
        return this.conversationReceipt(project, root.id, existing);
      }
      const original = request.requestId ? state.messages.find(message => message.id === request.requestId && message.kind === 'request' && message.state === 'accepted') : undefined;
      if (request.requestId && (!original || (request.kind === 'reply'
        ? original.recipientRunId !== sender.id || original.senderRunId !== recipient.id
        : original.senderRunId !== sender.id || original.recipientRunId !== recipient.id))) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
      const settled = state.outcomes.find(outcome => outcome.requestId === request.requestId);
      // A worker's question has exactly one answer (#505): a second reply is refused, not recorded late.
      if (request.kind === 'reply' && settled && original?.question) throw new DelegationPolicyError('incompatible_state', 'This question was already answered');
      const now = new Date().toISOString();
      const destroyed = recipient.delegation?.role === 'worker' && recipient.delegation.destroy?.phase === 'complete';
      // A peer whose Finish is pending takes nothing more: Finish would settle it unread (spec § 5).
      const resumable = !['queued', 'running', 'waiting'].includes(recipient.status) || !!recipient.stopping || (recipient.delegation?.role === 'worker' && !!recipient.delegation.destroy) || (peer && finishing(recipient));
      const resume = !!request.resume && resumable;
      // The extended bound belongs to a new continuation, not merely the flag.
      // Exact retries have already returned above, even if that continuation is now active.
      if (request.timeoutSeconds > MAX_CONVERSATION_REQUEST_SECONDS && !resume) {
        throw new DelegationPolicyError('incompatible_state', 'Extended request deadlines require resuming a settled worker; active workers accept at most 1800 seconds');
      }
      if (resume && (destroyed || recipient.delegation?.role !== 'worker' || recipient.delegation.destroy ||
        recipient.status === 'cancelled' || recipient.stopping)) throw new DelegationPolicyError('incompatible_state',
          `Worker is ${destroyed ? 'destroyed' : 'stopped or being destroyed'}; --resume cannot restart it. Spawn a new worker with the follow-up instruction`);
      const instruction = destroyed ? 'Not delivered: this worker was destroyed. Spawn a new worker for further work.'
        : resumable && !resume ? notDeliveredInstruction(pair, root) : undefined;
      const message: ConversationSendResult['message'] = { id: request.id, senderRunId: sender.id, recipientRunId: recipient.id,
        kind: request.kind, ...(request.requestId ? { requestId: request.requestId } : {}), ...(peer ? { relationship } : {}),
        text: project.store.redactText(request.text), createdAt: now, requestHash,
        ...(request.kind === 'request' && !destroyed && (!resumable || resume) ? { deadline: new Date(Date.parse(now) + request.timeoutSeconds * 1000).toISOString() } : {}),
        ...(resume ? { resumed: true as const } : {}), ...(instruction ? { instruction } : {}),
        state: request.kind === 'reply' && settled ? 'late' : destroyed ? 'destroyed' : resumable && !resume ? 'continuation-required' : 'accepted' };
      const enqueue = !destroyed && (!resumable || resume);
      // Open worker questions reserve ledger room for their replies (#505); the reply spends its
      // own. The reply is also always admitted to the worker's inbox, one past its soft 32-input
      // bound: while the question is pending nothing else there can drain, and a worker has at
      // most one pending question, so this admits at most one extra input.
      const answering = request.kind === 'reply' && !settled && !!original?.question;
      // An answer the worker can no longer receive (stopping, stopped, destroyed) would record
      // the question as replied while nothing delivers it; the human answers it instead.
      if (answering && !enqueue) throw new DelegationPolicyError('incompatible_state', 'The worker can no longer receive this answer; its question goes back to the human');
      assertConversationCapacity(state, pair, request.kind, enqueue, request.kind === 'reply' && !settled, answering);
      const outcomes = replyOutcomes(state, request, settled, now);
      // `parentRunId` keeps its name and holds the ledger owner (spec § 2, Message identity).
      const input = { id: message.id, source: 'agent' as const, parentRunId: root.id, text: message.text, createdAt: now,
        conversation: { senderRunId: sender.id, recipientRunId: recipient.id, kind: message.kind, ...(message.requestId ? { requestId: message.requestId } : {}), ...(peer ? { relationship } : {}) },
        // A peer input outlives its sender's ledger: it keeps the message's identity for the recipient's inbox.
        ...(peer ? { requestHash, ...(message.deadline ? { deadline: message.deadline } : {}) } : {}) };
      const next = { messages: [...state.messages, message], outcomes };
      if (resume) {
        try { assertConversationIdFree(root, input, id => project.store.getRun(id), (runId, id) => project.store.hasProjection(runId, id)); }
        catch (error) { if (error instanceof ConversationIdInUseError) throw new DelegationPolicyError('invalid_input', error.message); throw error; }
        const result = project.manager.continueRun(recipient.id, {
          text: `Your parent resumed this worker with a new instruction.\nAgent conversation ${JSON.stringify({ id: input.id, ...input.conversation })}\n${input.text}`,
        }, true, { rootId: root.id, state: next, input });
        if (!result.ok) throw new DelegationPolicyError('incompatible_state', `Worker was not resumed: ${result.error}. No message was accepted; resolve this condition and retry the same command`);
      } else commitAccepted(project.store, root.id, next, enqueue ? input : undefined, peer && !recipient.delegation);
      projectConversationEvents(project.store, project.store.getRun(root.id)!);
      project.manager.reconcileWorkerWaits();
      if (enqueue) project.manager.deliverConversationInput(recipient.id);
      return this.conversationReceipt(project, root.id, message);
    });
  }
  async followUp(caller: Caller, value: ConversationSendRequest): Promise<ConversationSendResult> {
    if (value.kind !== 'follow-up') throw new DelegationPolicyError('invalid_input', 'Expected follow-up');
    return this.send(caller, value);
  }
  async reply(caller: Caller, value: ConversationSendRequest): Promise<ConversationSendResult> {
    if (value.kind !== 'reply') throw new DelegationPolicyError('invalid_input', 'Expected reply');
    return this.send(caller, value);
  }
  /**
   * One pair's history. A family pair reads its one ledger; a peer pair reads both roots' ledgers
   * and merges them in `(createdAt, id)` order, newest `CONVERSATION_PAGE_MESSAGES` first, with
   * `nextBefore` when older messages exist (spec § 2). A deleted peer leaves the caller's ledger.
   */
  async conversation(caller: Caller, value: ConversationInspectRequest): Promise<ConversationInspectResult> {
    const request = conversationInspectRequestSchema.parse(value);
    const { project, ledgers, self, other } = this.historyLedgers(caller, request.recipientRunId);
    const between = (message: ConversationMessage) => { return (message.senderRunId === self && message.recipientRunId === other) || (message.senderRunId === other && message.recipientRunId === self); };
    const states = ledgers.map(ledger => {
      const state = this.currentConversation(project, ledger);
      projectConversationEvents(project.store, project.store.getRun(ledger.id) ?? ledger);
      return state;
    });
    const before = request.before === undefined ? undefined : decodeConversationCursor(request.before);
    const merged = states.flatMap(state => state.messages.filter(between)).sort(byCreatedAtAndId)
      .filter(message => !before || byCreatedAtAndId(message, before) < 0);
    const messages = merged.slice(-CONVERSATION_PAGE_MESSAGES);
    const ids = new Set(messages.map(message => message.id));
    const outcomes = states.flatMap(state => state.outcomes.filter(outcome => ids.has(outcome.requestId)));
    const inputs = project.store.getRun(caller.runId)?.agentInputs ?? [];
    const unread = messages.some(message => message.recipientRunId === caller.runId &&
      inputs.some(input => input.id === message.id && !input.deliveredAt));
    return { messages, outcomes,
      ...(merged.length > messages.length ? { nextBefore: encodeConversationCursor(messages[0]!) } : {}),
      ...(unread ? { hint: 'This history includes unread messages. Run message inbox to receive and mark them delivered. Inbox will show them again intentionally; after acknowledgement, Cezar will not queue them again for normal end-of-turn delivery.' } : {}) };
  }
  /** The ledgers a history read covers: the family's one, or each peer root's own while it exists.
   *  A peer whose history is being deleted, or is deleted, stays readable to a participant (spec § 2). */
  private historyLedgers(caller: Caller, otherId: string): { project: DelegationProject; ledgers: RunRecord[]; self: string; other: string } {
    let pair: ConversationPair | undefined;
    try { pair = this.conversationPair(caller, otherId); } catch (error) {
      if (!(error instanceof DelegationPolicyError) || error.code !== 'denied_scope') throw error;
    }
    if (pair?.relationship === 'family') return { project: pair.project, ledgers: [pair.root], self: caller.runId, other: otherId };
    const { project, self } = this.peerRecords(caller);
    const other = project.store.getRun(otherId);
    if (!pair && !takesPart(self, other, otherId)) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    return { project, ledgers: [self, ...(other?.delegation?.role === 'root' ? [other] : [])], self: self.id, other: otherId };
  }
  async inbox(caller: Caller): Promise<InboxReserveResult> {
    const project = this.context(caller);
    const run = project.store.getRun(caller.runId);
    if (!run || (run.delegation?.role !== 'root' && run.delegation?.role !== 'worker')) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const selected: InboxEntry[] = [];
    let characters = 0;
    const states = new Map<string, ConversationState>();
    const ledgerState = (ledger: RunRecord) => {
      let state = states.get(ledger.id);
      if (!state) { state = this.currentConversation(project, ledger); states.set(ledger.id, state); }
      return state;
    };
    for (const input of run.agentInputs ?? []) {
      if (!input.conversation || input.conversation.recipientRunId !== run.id || !project.manager.canClaimInboxInput(run.id, input.id)) continue;
      const found = input.conversation.relationship === 'peer' ? this.peerInboxEntry(project, run, input, ledgerState) : this.familyInboxEntry(caller, run, input, ledgerState);
      if (!found) continue;
      if (selected.length >= 32 || (selected.length > 0 && characters + found.message.text.length > 100_000)) break;
      characters += found.message.text.length;
      selected.push(found);
    }
    if (!selected.length) return { messages: [], outcomes: [] };
    const receipt = project.manager.reserveInboxInputs(run.id, caller.generation, selected.map(entry => entry.message.id));
    if (!receipt) return { messages: [], outcomes: [] };
    const claimed = new Set(receipt.inputIds);
    const returned = selected.filter(entry => claimed.has(entry.message.id));
    if (!returned.length) throw new DelegationPolicyError('incompatible_state', 'Inbox claim returned no messages');
    const outcomes = [...new Map(returned.flatMap(entry => entry.outcome ? [[entry.outcome.requestId, entry.outcome] as const] : [])).values()];
    return { messages: returned.map(entry => entry.message), outcomes,
      receiptId: receipt.receiptId, expiresAt: receipt.expiresAt };
  }
  /** A peer input addressed to the caller: its participation is the whole check (spec § 2, two
   *  levels). When the sender's ledger went with its deletion, the input still carries the message. */
  private peerInboxEntry(project: DelegationProject, run: RunRecord, input: AgentInput, ledgerState: (ledger: RunRecord) => ConversationState): InboxEntry | undefined {
    if (run.delegation?.role !== 'root') return undefined;
    const ledger = project.store.getRun(input.parentRunId);
    if (!ledger) { const message = orphanedPeerMessage(input); return message && { message }; }
    return ledger.delegation?.role === 'root' ? inboxEntryIn(ledgerState(ledger), input, run.id) : undefined;
  }
  /** A family input: the pair must still be admitted, as before peers existed. */
  private familyInboxEntry(caller: Caller, run: RunRecord, input: AgentInput, ledgerState: (ledger: RunRecord) => ConversationState): InboxEntry | undefined {
    let pair: ConversationPair;
    try { pair = this.conversationPair(caller, input.conversation!.senderRunId); } catch (error) {
      if (error instanceof DelegationPolicyError && error.code === 'denied_scope') return undefined;
      throw error;
    }
    return pair.relationship === 'family' ? inboxEntryIn(ledgerState(pair.root), input, run.id) : undefined;
  }
  private inboxReceipt(caller: Caller, value: InboxReceiptRequest) {
    const { receiptId } = inboxReceiptRequestSchema.parse(value);
    const project = this.context(caller);
    const run = project.store.getRun(caller.runId);
    const members = run?.agentInputs?.filter(input => input.inboxClaim?.receiptId === receiptId && input.inboxClaim.generation === caller.generation) ?? [];
    if (!members.length || members.some(input => !input.conversation || input.conversation.recipientRunId !== caller.runId))
      throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    // A peer member is checked against the caller's own record only: a sender deleted between
    // reserve and acknowledge does not refuse the batch (spec § 2).
    for (const input of members) {
      if (input.conversation!.relationship === 'peer') this.peerRecords(caller);
      else this.conversationPair(caller, input.conversation!.senderRunId);
    }
    return { project, receiptId };
  }
  async ackInbox(caller: Caller, value: InboxReceiptRequest): Promise<InboxReceiptResult> {
    const { project, receiptId } = this.inboxReceipt(caller, value);
    try { return { receiptId, status: project.manager.acknowledgeInbox(caller.runId, caller.generation, receiptId) }; }
    catch { throw new DelegationPolicyError('incompatible_state', 'Inbox acknowledgement failed; retry the same receipt while it remains live'); }
  }
  async releaseInbox(caller: Caller, value: InboxReceiptRequest): Promise<InboxReceiptResult> {
    const { project, receiptId } = this.inboxReceipt(caller, value);
    try { return { receiptId, status: project.manager.releaseInbox(caller.runId, caller.generation, receiptId) }; }
    catch { throw new DelegationPolicyError('incompatible_state', 'Inbox release failed'); }
  }
  /** A request the caller sent, from its family ledger. A peer request needs only the caller's own
   *  record: wait and cancel still work after the peer's deletion (spec § 2). */
  private ownRequest(caller: Caller, requestId: string): { project: DelegationProject; root: RunRecord; message: ConversationMessage } {
    const project = this.context(caller); const sender = project.store.getRun(caller.runId);
    const root = sender?.delegation?.role === 'root' ? sender : sender?.delegation?.role === 'worker' ? project.store.getRun(sender.delegation.parentRunId) : undefined;
    const message = root?.delegation?.role === 'root' ? root.delegation.conversation?.messages.find(message => message.id === requestId && message.kind === 'request' && message.state === 'accepted' && message.senderRunId === caller.runId) : undefined;
    if (!message) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    if (message.relationship === 'peer') return { ...this.peerRecords(caller), root: root!, message };
    const pair = this.conversationPair(caller, message.recipientRunId);
    if (pair.relationship !== 'family') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    return { project: pair.project, root: pair.root, message };
  }
  async cancelRequest(caller: Caller, value: ConversationCancelRequest): Promise<RequestOutcome> {
    const { requestId } = conversationCancelRequestSchema.parse(value);
    const { project, root } = this.ownRequest(caller, requestId);
    const state = this.currentConversation(project, root);
    const existing = state.outcomes.find(outcome => outcome.requestId === requestId);
    if (existing) {
      projectConversationEvents(project.store, project.store.getRun(root.id)!); project.manager.reconcileWorkerWaits();
      return existing;
    }
    const outcome: RequestOutcome = { requestId, status: 'cancelled', observedAt: new Date().toISOString() };
    project.store.commitConversation(root.id, { ...state, outcomes: [...state.outcomes, outcome] });
    projectConversationEvents(project.store, project.store.getRun(root.id)!); project.manager.reconcileWorkerWaits();
    return outcome;
  }
  async waitRequests(caller: Caller, value: RequestWaitRequest) {
    const request = requestWaitRequestSchema.parse(value);
    for (const id of request.requestIds) this.ownRequest(caller, id);
    const project = this.context(caller);
    const wait = project.manager.registerRequestWait(caller.runId, request);
    return { wait, instruction: `Wait ${wait.id} registered until ${wait.deadline}. End your turn now to release capacity. Cezar resumes you when ${wait.mode === 'all' ? 'every selected request settles' : 'a selected request settles'} or at the deadline. Messages also wake you and keep this wait open; end your turn to keep waiting. Your other waits stay open beside it.` };
  }
  async spawn(caller: Caller, value: WorkerSpawnRequest) {
    const request = workerSpawnRequestSchema.parse(value);
    const initial = this.context(caller);
    return this.serialized(`parent:${initial.id}:${caller.runId}`, async () => {
      const project = this.context(caller);
      const parent = project.store.getRun(caller.runId);
      authorizeSpawnReplay(caller, parent, project.id);
      if (parent?.delegation?.role !== 'root') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
      if (project.store.containsSessionSecret(JSON.stringify(request))) throw new DelegationPolicyError('invalid_input', 'Credentials cannot be included in delegated input');
      const effortPin = parseDelegationEffort(request.effort);
      const requestHash = createHash('sha256').update(JSON.stringify({ task: request.task, baseline: request.baseline,
        ...(request.context === undefined ? {} : { context: request.context }),
        ...(request.backend === undefined ? {} : { backend: request.backend }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(effortPin === undefined ? {} : { effort: effortPin }),
        ...(request.workflow === undefined ? {} : { workflow: request.workflow }),
        ...(request.skill === undefined ? {} : { skill: request.skill }),
      })).digest('hex');
      const receipt = parent.delegation.receipts.find(r => r.requestId === request.requestId);
      if (receipt) {
        if (receipt.requestHash !== requestHash) throw new DelegationPolicyError('invalid_input', 'Request ID payload conflict');
        const worker = project.store.getRun(receipt.workerId);
        if (worker?.delegation?.role !== 'worker' || worker.delegation.parentRunId !== parent.id || worker.delegation.workspace.ownerRunId !== worker.id) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
        return { workerId: worker.id, baselineSha: worker.delegation.workspace.baselineSha };
      }
      authorizeSpawn(caller, parent, project.id, id => project.store.getRun(id));
      const catalog = await resolveSpawnWorkflow(project, request);
      const resolvedSteps = await resolveSpawnSteps(project.manager, parent.id, request, catalog, (step, settings) => this.validateModels(request, [{ step, settings }]));
      // Run-level fields hold the first agent step (cockpit columns, pre-#452 evidence readers);
      // the per-step list is what each launch binds.
      const first = resolvedSteps[0]!;
      const settings = first.settings;
      const identity = acceptedWorkerIdentitySchema.parse({ kind: 'accepted', ...stepIdentityFields(first),
        steps: resolvedSteps.map(entry => ({ stepId: entry.step.id, ...stepIdentityFields(entry) })) });
      const baselineSha = await resolveWorkerBaseline(project.root, settings.cwd, request.baseline);
      const workspace = await planOwnedWorkspace(project.root, randomUUID(), baselineSha);
      const prepared = request.context === undefined ? undefined : await prepareWorkerContext({
        repoRoot: project.root, dataDir: join(project.root, '.ai/cezar'), parentId: parent.id, workspace,
        parentCwd: settings.cwd, context: request.context, containsSecret: text => project.store.containsSessionSecret(text),
      });
      const context = prepared?.recipe;
      let accepted = false;
      try {
        // Ref resolution yields to Finish, revocation and project disposal; recheck before acceptance.
        const current = this.context(caller);
        if (current !== project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
        authorizeSpawn(caller, project.store.getRun(parent.id), project.id, id => project.store.getRun(id));
        // The public definition carries what each agent step RESOLVED to — runner, account,
        // model, effort and the narrowed grants — so the bound `workflowDef` and the private
        // per-step identity describe the same launch and the manager can hold them against each
        // other. Check steps run as authored.
        const workflowDef: WorkflowDef = { ...catalog, steps: catalog.steps.map(step => {
          const entry = resolvedSteps.find(candidate => candidate.step === step);
          if (!entry) return step;
          const { model: _model, effort: _effort, allowedTools: _tools, bashAllowlist: _bash, ...authored } = step;
          return { ...authored, runner: entry.settings.runner, agentProfile: entry.settings.accountBinding!.profileId,
            ...(entry.settings.model === undefined ? {} : { model: entry.settings.model }),
            ...(entry.settings.effort === undefined ? {} : { effort: entry.settings.effort }),
            ...entry.grants };
        }) };
        const worker = project.store.createOwnedRun({
          title: request.task.slice(0, 200), task: context ? workerContextTask(request.task, context) : request.task, workflow: workflowDef.name,
          runner: settings.runner, model: settings.model, effort: settings.effort, agentProfile: identity.account.profileId,
          systemPrompt: settings.systemPrompt, workflowDef,
          autonomous: parent.autonomous,
          steps: workflowDef.steps.map(step => ({ id: step.id, name: step.name ?? step.id, kind: stepKind(step) })),
        }, parent.id, request.requestId, { role: 'worker', permissions: [], parentRunId: parent.id, workspace, ...(context ? { context } : {}) }, requestHash, {
          ...identity, ...(context ? { contextHash: workerContextHash(context) } : {}),
          // A named catalog chain or skill is bound like the context recipe; the default quick-task leaves the identity as before.
          ...(request.workflow === undefined && request.skill === undefined ? {} : { workflowHash: workerWorkflowHash(workflowDef) }),
        });
        accepted = true;
        project.manager.enqueueOwnedRun(worker.id);
        return { workerId: worker.id, baselineSha };
      } finally { if (!accepted) await prepared?.discard(); }
    });
  }
  async list(caller: Caller, query: WorkerListQuery = {}): Promise<WorkerListPage> {
    const project = this.context(caller);
    const parent = project.store.getRun(caller.runId);
    authorizeWorkerList(caller, parent, project.id);
    if (parent?.delegation?.role !== 'root') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const workers: WorkerListPage['workers'] = [];
    const offset = Number(query.offset ?? 0);
    const end = Math.min(offset + 32, parent.delegation.receipts.length);
    for (const receipt of parent.delegation.receipts.slice(offset, end)) {
      const worker = project.store.getRun(receipt.workerId);
      // Deleted histories have no resources to supervise. Never expose an unrelated receipt target.
      if (worker?.delegation?.role !== 'worker' || worker.delegation.parentRunId !== parent.id ||
          worker.delegation.workspace.ownerRunId !== worker.id) continue;
      const inspection = await this.inspect(caller, { workerId: worker.id });
      workers.push({ workerId: inspection.workerId, parentRunId: inspection.parentRunId,
        status: inspection.status, workspace: inspection.workspace,
        ...(inspection.destroy ? { destroy: inspection.destroy } : {}), revision: workerRevision(worker),
        settled: inspection.outcome !== undefined && project.store.readWorkerExecution(worker.id)?.phase === 'complete',
        destroyed: worker.delegation.destroy?.phase === 'complete' });
    }
    return { workers, ...(end < parent.delegation.receipts.length ? { nextOffset: end } : {}) };
  }
  async inspect(caller: Caller, params: WorkerParams): Promise<WorkerInspection> {
    const { project, worker, parent } = this.target(caller, params, 'inspect');
    if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    project.manager.settleOrphanedWorkerExecution(worker.id); // #469: an orphan that died after recovery settles
    const outcome = workerOutcome(worker, new Date().toISOString());
    const wait = this.inspectedWait(parent, worker.id);
    const completion = parent.delegation?.role === 'root' ? completionWaitEntry(parent.waits, worker.id) : undefined;
    const completionWait = completion ? workerCompletionWaitProjection(completion, parent) : undefined;
    return { workerId: worker.id, parentRunId: parent.id, status: worker.status, workspace: worker.delegation.workspace,
      ...(worker.runner === undefined ? {} : { backend: worker.runner }), ...(worker.model === undefined ? {} : { model: worker.model }),
      ...(worker.delegation.context === undefined ? {} : { inputs: worker.delegation.context.inputs }),
      ...(worker.currentStepId === undefined ? {} : { currentStepId: worker.currentStepId }),
      ...(wait ? { wait } : {}), ...(completionWait ? { completionWait } : {}), ...(worker.delegation.destroy ? { destroy: workerDestroyView(worker) } : {}), ...(outcome ? { outcome } : {}) };
  }
  /** The wait an inspection shows: the newest open or owed list wait naming the worker, in the
   *  legacy `WorkerWait` shape (hearsay-tools/cezarion#1235). Cezar's completion wait carries no
   *  deadline, which that shape requires, so inspection shows it as `completionWait`
   *  (hearsay-tools/cezarion#1301). */
  private inspectedWait(parent: RunRecord, workerId: string): WorkerWait | undefined {
    if (parent.delegation?.role !== 'root') return undefined;
    const entry = (parent.waits ?? []).filter((wait): wait is DeadlinedWorkerWaitEntry => wait.kind === 'worker' && hasWorkerDeadline(wait) && !!wait.workerIds?.includes(workerId)).at(-1);
    return entry ? workerWaitEntryToLegacy(entry) : undefined;
  }
  async collect(caller: Caller, params: WorkerParams): Promise<WorkerCollectedResult> {
    const project = this.context(caller);
    const { workerId } = workerParamsSchema.parse(params);
    const parent = project.store.getRun(caller.runId);
    const worker = project.store.getRun(workerId);
    if (!worker) {
      const retained = project.store.readDeletedWorkerResult(caller.runId, workerId);
      authorizeRetainedResult(caller, parent, project.id, workerId, retained);
      const evidence = await revalidateRetainedWorkerResult(project.root, retained!);
      authorizeRetainedResult(caller, project.store.getRun(caller.runId), project.id, workerId, project.store.readDeletedWorkerResult(caller.runId, workerId));
      return project.store.commitWorkerResult(caller.runId, evidence, project.store.readWorkerResultDiff(caller.runId, workerId));
    }
    authorizeWorker(caller, worker, 'inspect', parent, project.id);
    project.manager.settleOrphanedWorkerExecution(workerId); // #469: before `settled` is computed
    if (parent?.delegation?.role === 'root' && parent.delegation.receipts.some(receipt => receipt.workerId === workerId && receipt.deletion?.phase === 'pending')) {
      const retained = project.store.readWorkerResult(parent.id, workerId);
      if (!retained || !project.store.canDeleteRun(workerId)) throw new DelegationPolicyError('incompatible_state', 'Worker history deletion evidence is unavailable');
      const evidence = await revalidateRetainedWorkerResult(project.root, retained);
      if (!project.store.canDeleteRun(workerId)) throw new DelegationPolicyError('incompatible_state', 'Worker history changed during collection');
      return project.store.commitWorkerResult(parent.id, evidence, project.store.readWorkerResultDiff(parent.id, workerId));
    }
    // Store records preserve object references. Copy before yielding to Continue or cleanup.
    const snapshot = structuredClone(worker);
    const evidence = await collectWorkerEvidence(project.root, project.store, snapshot);
    const current = this.target(caller, params, 'inspect');
    if (current.project !== project || workerRevision(current.worker) !== workerRevision(snapshot) ||
      current.worker.status !== snapshot.status || JSON.stringify(current.worker.delegation) !== JSON.stringify(snapshot.delegation)) {
      throw new DelegationPolicyError('incompatible_state', 'Worker changed during collection; collect the current execution again');
    }
    return project.store.commitWorkerResult(parent!.id, evidence.result, evidence.diffSnapshot);
  }
  async steer(caller: Caller, params: WorkerParams, value: WorkerSteerRequest) {
    const request = workerSteerRequestSchema.parse(value);
    const { project, worker, parent } = this.target(caller, params, 'steer');
    if (project.store.containsSessionSecret(request.text)) throw new DelegationPolicyError('invalid_input', 'Credentials cannot be included in delegated input');
    const state = project.manager.steerWorker(worker.id, { id: randomUUID(), source: 'agent', parentRunId: parent.id, text: request.text, createdAt: new Date().toISOString() });
    return { workerId: worker.id, state };
  }
  async stop(caller: Caller, params: WorkerParams) {
    const { project, worker } = this.target(caller, params, 'stop');
    return project.manager.requestWorkerStop(worker.id);
  }
  async diff(caller: Caller, params: WorkerParams) {
    const { project, worker } = this.target(caller, params, 'diff');
    return readOwnedDiff(project.root, worker);
  }
  async wait(caller: Caller, value: WorkerWaitRequest) {
    const request = workerWaitRequestSchema.parse(value);
    for (const workerId of request.workerIds) this.target(caller, { workerId }, 'wait');
    const project = this.context(caller);
    const wait = project.manager.registerWorkerWait(caller.runId, request);
    return { wait, instruction: `Wait ${wait.id} registered until ${wait.deadline}. End your turn now to release capacity. Cezar resumes you when ${wait.mode === 'all' ? 'all selected workers settle' : 'a selected worker settles'} or at the deadline. Messages also wake you and keep this wait open; end your turn to keep waiting. Your other waits stay open beside it.` };
  }
  async cancelWait(caller: Caller, value: WorkerCancelWaitRequest) {
    const { waitId } = workerCancelWaitRequestSchema.parse(value);
    const project = this.context(caller);
    const sender = project.store.getRun(caller.runId);
    if (sender?.delegation?.role === 'worker') {
      this.conversationPair(caller, sender.delegation.parentRunId);
      // hearsay-tools/cezarion#1235: a worker's request wait is a list entry, open or settled.
      const wait = [...sender.waits ?? [], ...sender.lastWaits ?? []].find(entry => entry.id === waitId && entry.kind === 'worker');
      if (wait?.kind !== 'worker' || !wait.requestIds?.length) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
      for (const requestId of wait.requestIds) this.ownRequest(caller, requestId);
    } else authorizeCancelWait(caller, sender, project.id);
    return { wait: project.manager.cancelWorkerWait(caller.runId, waitId) };
  }
  async destroy(caller: Caller, params: WorkerParams) {
    const { project, worker } = this.target(caller, params, 'destroy');
    return this.destroySerialized(project, worker.id, () => this.target(caller, params, 'destroy').worker);
  }
  /** Existing human HTTP authority, bound to its resolved project; never mint a pretend agent caller. */
  async destroyForHuman(projectId: string, workerId: string) {
    const project = this.projects.get(projectId);
    if (!project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const check = () => {
      const worker = project.store.getRun(workerId);
      if (this.projects.get(projectId) !== project || worker?.delegation?.role !== 'worker' || worker.delegation.workspace.ownerRunId !== workerId) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
      return worker;
    };
    check();
    return this.destroySerialized(project, workerId, check);
  }
  /** An explicit destroy (Clean up, `cez worker destroy`): always a full attempt, and it restarts the
   * backoff, so a timer armed for a later automatic attempt is dropped and re-armed at the fast cadence. */
  private destroySerialized(project: DelegationProject, workerId: string, check: () => RunRecord) {
    return this.serialized(`worker:${project.id}:${workerId}`, () => this.destroyAttempt(project, workerId, check, 'manual')).finally(() => {
      // A replaced registration owns its own timers under the same project id: leave them alone.
      if (this.projects.get(project.id) !== project) return;
      const timers = this.destroyRetryTimers.get(project.id);
      clearTimeout(timers?.get(workerId)); timers?.delete(workerId);
      this.scheduleDestroyRetry(project, workerId);
    });
  }
  /** One full destroy attempt; the caller holds the worker's serialization key. A manual attempt
   * clears the run's `destroyRetry`, which resets the backoff; a completed destroy drops it. */
  private async destroyAttempt(project: DelegationProject, workerId: string, check: () => RunRecord, mode: 'manual' | 'scheduled'): Promise<WorkerDestroyResult> {
    const assertAttached = () => {
      if (this.projects.get(project.id) !== project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    };
    assertAttached();
    let worker = check();
    if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const parent = project.store.getRun(worker.delegation.parentRunId);
    if (parent?.delegation?.role === 'root' && parent.delegation.receipts.some(receipt => receipt.workerId === workerId && receipt.deletion)) {
      throw new DelegationPolicyError('incompatible_state', 'Worker history deletion has begun; retry history deletion');
    }
    const commonDir = await this.commonDir(project);
    assertAttached();
    worker = check();
    if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    // What this attempt decided on (hearsay-tools/cezarion#879): a later tick that would see the same skips its
    // work. Retaken where the attempt decides (after termination, at each holder proof), so its own writes up
    // to there (stopping the worker, the removal's checkpoint) are not a change, and anything later is.
    const observe = () => observeDestroy({ store: project.store, dataDir: join(project.root, '.ai/cezar'), commonDir, workerId });
    let key = observe();
    const workspace = worker.delegation.workspace;
    const requestedAt = worker.delegation.destroy?.requestedAt ?? new Date().toISOString();
    const resources = (worker.delegation.destroy?.remaining ?? ['worktree', 'branch']).filter((resource): resource is 'worktree' | 'branch' => resource !== 'process');
    const persist = (phase: WorkerDestroy['phase'], remaining: WorkerDestroy['remaining'], error?: string) => {
      assertAttached();
      worker = project.store.getRun(workerId)!;
      if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
      project.store.commitDelegation([{ id: workerId, delegation: { ...worker.delegation, destroy: { requestedAt, phase, remaining,
        ...(error ? { error: error.slice(0, 2_000) } : {}) } } }]);
      // The retry state lives beside the delegation: an explicit destroy and a completed one both drop it.
      if (worker.destroyRetry && (phase === 'complete' || (mode === 'manual' && phase === 'requested'))) project.store.commitDestroyRetry(workerId, undefined);
    };
    /** What the attempt decided on, and the holders it ran into, kept only when that explains the
     * failure. A complete destroy keeps nothing, and neither does a failure no key input or named
     * holder accounts for (lock contention, a failed Git step, an unnamed blocker): it can clear
     * without changing anything a tick could see, so the next tick attempts in full. */
    const observed = (result: WorkerDestroyResult, holders: readonly number[], explained: boolean) => {
      this.observeAttempt(project, workerId, result.state === 'complete' || !explained ? undefined : { key, holders: recordHolders(holders) });
      return result;
    };
    persist('requested', worker.delegation.destroy?.remaining ?? ['process', 'worktree', 'branch']);
    try {
      persist('terminating', ['process', ...resources]);
      project.manager.requestWorkerStop(workerId);
      let result: WorkerDestroyResult;
      const terminated = await project.manager.awaitRunTermination(workerId, this.terminationTimeoutMs, { reapOrphans: true });
      assertAttached();
      key = observe();
      if (!terminated) {
        // #469: name what blocks a crashed generation; other causes keep the generic message.
        const taken = project.manager.takeWorkerTerminationBlocker(workerId);
        const reason = taken && (taken.blocker.kind === 'unreadable' ? 'worker process record is unreadable; termination cannot be proven'
          : taken.blocker.kind === 'controller' ? `the worker is still controlled by a live cezar (pid ${taken.blocker.pid})`
          : `${taken.blocker.pids.length === 1 ? 'process' : 'processes'} ${taken.blocker.pids.join(', ')} still ${taken.blocker.pids.length === 1 ? 'holds' : 'hold'} the worker's worktree or scratch`);
        if (taken?.changed) project.store.appendEvent(workerId, { type: 'lifecycle', message: `destroy blocked: ${reason}` });
        result = { workerId, state: 'incomplete', remaining: ['process', ...resources], error: !taken ? 'Worker termination is not proven; retry cleanup later'
          : taken.blocker.kind === 'unreadable' ? reason! : `Worker termination is not proven: ${reason}; retry cleanup later` };
        persist(result.state, result.remaining, result.error);
        return observed(result, taken?.blocker.kind === 'processes' ? taken.blocker.pids : taken?.blocker.kind === 'controller' ? [taken.blocker.pid] : [], !!taken);
      }
      persist('cleaning', resources);
      const snapshot = structuredClone(check());
      const proof = project.store.readWorkerExecution(workerId);
      const evidence = await collectWorkerEvidence(project.root, project.store, snapshot);
      assertAttached();
      const current = check();
      if (proof?.phase !== 'complete' || project.store.readWorkerExecution(workerId)?.generation !== proof.generation ||
        project.store.readWorkerExecution(workerId)?.phase !== 'complete' || current.status !== snapshot.status ||
        JSON.stringify(current.delegation) !== JSON.stringify(snapshot.delegation)) throw new Error('Worker changed before cleanup checkpoint');
      // This immutable parent payload must be durable before the first destructive operation. A
      // payload already on disk is durable, whatever cleanup phase it names (hearsay-tools/cezarion#879).
      project.store.commitWorkerResult(evidence.result.parentRunId, evidence.result, evidence.diffSnapshot, { ignoreCleanup: true });
      assertAttached();
      check();
      const release = project.manager.claimWorkerCleanup(workerId);
      const assertCurrent = () => {
        assertAttached();
        const current = check();
        if (!release || current.delegation?.role !== 'worker' ||
          JSON.stringify(current.delegation.workspace) !== JSON.stringify(workspace) ||
          project.store.readWorkerExecution(workerId)?.generation !== proof.generation ||
          project.store.readWorkerExecution(workerId)?.phase !== 'complete') {
          throw new Error('Worker resource ownership changed');
        }
      };
      const assertSafe = () => {
        assertCurrent();
        key = observe();
        const holders = project.store.workerResourceHolders(workerId, proof.generation, workspace.resourceId);
        if (holders === 'safe') return;
        throw holders.length ? new WorkspaceHeldError(holders) : new Error('Worker resources may still be held; cleanup will retry');
      };
      // The removal turns being held into an incomplete result; it reports the holders either of its
      // checks named, or that it stopped for a reason no key input explains, an unnamed holder
      // included (hearsay-tools/cezarion#879).
      let holders: readonly number[] = [];
      let explained = true;
      try {
        assertCurrent();
        // #781: release preview before the final fresh proof immediately preceding removal.
        result = await releaseThenRemoveOwnedWorkspace({ previewHost: project.manager.previewHost }, project.root, workspace,
          assertCurrent, assertSafe, { held: pids => { holders = pids; }, unexplained: () => { explained = false; } });
      } catch {
        explained = false;
        result = { workerId, state: 'incomplete', remaining: resources, error: 'Worker resources may still be held; cleanup will retry' };
      } finally { release?.(); }
      // An already-started checked Git operation may finish after detach. Its
      // checkpoint makes a new controller's retry safe; the old store must not
      // publish a result after ownership of the project has moved.
      assertAttached();
      persist(result.state, result.remaining, result.error);
      // Preserve the captured bytes even if Git removal was only partially successful.
      const removed = !result.remaining.includes('worktree');
      project.store.commitWorkerResult(evidence.result.parentRunId, { ...evidence.result, observedAt: new Date().toISOString(),
        cleanup: result.state, outcome: result.state === 'complete' ? 'destroyed' : evidence.result.lastExecutionOutcome,
        workspace: { ...workspace, state: removed ? 'deleted' : evidence.result.workspace.state },
        head: removed ? { state: 'deleted', reason: 'missing', ...('sha' in evidence.result.head ? { sha: evidence.result.head.sha } : {}) } : evidence.result.head,
        diff: evidence.result.diff.state === 'available' ? { ...evidence.result.diff, snapshotId: randomUUID() } : evidence.result.diff,
      }, evidence.diffSnapshot);
      project.manager.reconcileWorkerWaits(evidence.result.parentRunId);
      return observed(result, holders, explained);
    } catch (error) {
      // hearsay-tools/cezarion#879: an attempt that throws says why, instead of leaving an
      // in-progress phase with no error, as long as this is still the same pending destroy. A
      // throw explains nothing a tick could see clear, so the next tick attempts in full.
      this.observeAttempt(project, workerId, undefined);
      try {
        const current = this.projects.get(project.id) === project ? project.store.getRun(workerId) : undefined;
        if (current?.delegation?.role === 'worker' && current.delegation.destroy?.requestedAt === requestedAt && current.delegation.destroy.phase !== 'complete') {
          persist('incomplete', current.delegation.destroy.remaining, error instanceof Error ? error.message : String(error));
        }
      } catch { /* the attempt's own error is the one to report */ }
      throw error;
    }
  }
}
