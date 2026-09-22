import { reconcileConversationState, projectConversationEvents } from './conversations.ts';
import { collectWorkerEvidence, revalidateRetainedWorkerResult, workerRevision } from './results.ts';
import { join } from 'node:path';
import { prepareWorkerContext, workerContextTask } from './context.ts';
import { acceptedWorkerIdentitySchema, workerContextHash, workerWorkflowHash } from './execution-identity.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  conversationSendRequestSchema, conversationInspectRequestSchema, conversationCancelRequestSchema, requestWaitRequestSchema,
  type ConversationSendRequest, type ConversationSendResult, type ConversationInspectRequest, type ConversationCancelRequest, type ConversationState, type RequestWaitRequest, type RequestOutcome,
  workerSpawnRequestSchema, workerSteerRequestSchema, workerWaitRequestSchema, workerParamsSchema, workerCancelWaitRequestSchema, type WorkerCancelWaitRequest,
  type WorkerCollectedResult, type WorkerDestroy, type WorkerDestroyResult, type WorkerInspection, type WorkerOperation,
  type WorkerParams, type WorkerSpawnRequest, type WorkerSteerRequest, type WorkerWaitRequest,
} from '@open-mercato/cezar-contract';
import type { RunStore, RunRecord } from '../runs/store.ts';
import { workerOutcome } from '../runs/delegation-state.ts';
import type { DelegationExecutionSettings, RunManager } from '../workflows/run.ts';
import { QUICK_TASK_WORKFLOW, allowedToolsForStep, stepKind, type WorkflowDef, type WorkflowStepDef } from '../workflows/types.ts';
import { findWorkflow } from '../workflows/load.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import type { Caller } from './credentials.ts';
import { isAuthenticatedCaller } from './credentials.ts';
import { parseDelegationEffort } from './effort.ts';
import { authorizeSpawn, authorizeSpawnReplay, authorizeWorker, authorizeCancelWait, authorizeRetainedResult, DelegationPolicyError } from './policy.ts';
import { planOwnedWorkspace, readOwnedDiff, removeOwnedWorkspace, resolveWorkerBaseline } from './workspace.ts';

export type DelegationProject = { id: string; root: string; store: RunStore; manager: RunManager };

/**
 * The catalog definition a spawn runs (#451): the built-in quick-task constant when the request
 * names none — never the catalog's `quick-task` entry, so a repo file cannot change the default
 * path — else the named entry. Every agent step resolves its own runner and account (#452), so a
 * chain may mix providers; a chain with no agent step has nothing for a worker to run.
 */
async function resolveSpawnWorkflow(root: string, request: WorkerSpawnRequest): Promise<WorkflowDef> {
  if (request.workflow === undefined) return QUICK_TASK_WORKFLOW;
  const workflow = await findWorkflow(root, request.workflow);
  if (!workflow) throw new DelegationPolicyError('invalid_input', `Unknown workflow "${request.workflow}"; the catalog holds the built-in quick-task and .ai/cezar/workflows/*.yaml`);
  if (!workflow.steps.some(step => stepKind(step) === 'agent')) throw new DelegationPolicyError('invalid_input', `Workflow "${request.workflow}" has no agent step for a worker to run`);
  return workflow;
}

type WorkerGrants = { allowedTools?: string[]; bashAllowlist?: string[] };
/**
 * A step's authored tools narrow the parent's grants and never widen them: the parent's
 * permissions bound every worker session (#430). A step that authors nothing inherits the
 * parent's grants exactly; an authored list keeps only what the parent may use, where an absent
 * parent `allowedTools` means the backend's default set and an absent `bashAllowlist` means
 * unrestricted Bash, which any authored allowlist is narrower than.
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
 * Resolve every agent step of the chain once, before acceptance (#452). The spawn selection fills
 * only what a step leaves unset; a step's own runner, model, effort and account win. Equal
 * selections share one resolution so a ten-step single-runner chain reads the registry once.
 */
async function resolveSpawnSteps(manager: RunManager, parentId: string, request: WorkerSpawnRequest, workflow: WorkflowDef): Promise<ResolvedSpawnStep[]> {
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
    if (!pending) { pending = manager.selectDelegationExecutionSettings(parentId, selection); cache.set(key, pending); }
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

/** A single controller's shared policy adapter; managers retain scheduling and lifecycle ownership. */
export class DelegationService {
  private projects = new Map<string, DelegationProject>();
  private serial = new Map<string, Promise<unknown>>();
  registerProject(project: DelegationProject): () => void {
    const existing = this.projects.get(project.id);
    if (existing?.store === project.store && existing.manager === project.manager) return () => {};
    this.projects.set(project.id, project);
    return () => { if (this.projects.get(project.id) === project) this.projects.delete(project.id); };
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
  private conversationPair(caller: Caller, recipientRunId: string, send = false) {
    const project = this.context(caller);
    const sender = project.store.getRun(caller.runId);
    const recipient = project.store.getRun(recipientRunId);
    const root = sender?.delegation?.role === 'root' ? sender : recipient;
    const worker = sender?.delegation?.role === 'worker' ? sender : recipient;
    if (!sender || !recipient || sender.id === recipient.id || root?.delegation?.role !== 'root' || worker?.delegation?.role !== 'worker' ||
      worker.delegation.parentRunId !== root.id || worker.delegation.workspace.ownerRunId !== worker.id ||
      !root.delegation.receipts.some(receipt => receipt.workerId === worker.id && !receipt.deletion) || root.delegation.historyDeletion) {
      throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    }
    if (send && sender.id === root.id && !root.delegation.permissions.includes('steer')) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    if (send && (!['running', 'waiting'].includes(sender.status) || (sender.id === root.id && root.delegation.finishRequestedAt) ||
      (sender.delegation?.role === 'worker' && sender.delegation.destroy))) throw new DelegationPolicyError('incompatible_state', 'Sender session is not active');
    return { project, sender, recipient, root, worker };
  }
  private currentConversation(project: DelegationProject, root: RunRecord): ConversationState {
    const state = reconcileConversationState(root, project.store.listRuns(), new Date().toISOString(), run => run.delegation?.role === 'worker'
      ? project.store.readWorkerExecution(run.id)?.phase === 'complete' : !project.manager.isActive(run.id));
    if (root.delegation?.role === 'root' && state && state !== root.delegation.conversation) project.store.commitConversation(root.id, state);
    return state ?? { messages: [], outcomes: [] };
  }
  private conversationReceipt(project: DelegationProject, root: RunRecord, message: ConversationSendResult['message']): ConversationSendResult {
    const recipient = project.store.getRun(message.recipientRunId);
    const input = recipient?.agentInputs?.find(input => input.id === message.id);
    const state = root.delegation?.role === 'root' ? root.delegation.conversation : undefined;
    const outcome = state?.outcomes.find(outcome => outcome.requestId === (message.requestId ?? message.id));
    return { message, delivery: input?.deliveredAt ? 'delivered' : input ? 'queued' : 'not-delivered', ...(outcome ? { outcome } : {}) };
  }
  async send(caller: Caller, value: ConversationSendRequest): Promise<ConversationSendResult> {
    const request = conversationSendRequestSchema.parse(value);
    const initial = this.conversationPair(caller, request.recipientRunId, true);
    return this.serialized(`conversation:${initial.project.id}:${initial.root.id}`, async () => {
      const { project, root, sender, recipient } = this.conversationPair(caller, request.recipientRunId, true);
      if (request.resume && (sender.id !== root.id || recipient.delegation?.role !== 'worker')) {
        throw new DelegationPolicyError('denied_scope', 'Only an active parent may use --resume for its owned worker');
      }
      if (project.store.containsSessionSecret(JSON.stringify(request))) throw new DelegationPolicyError('invalid_input', 'Credentials cannot be included in delegated input');
      const requestHash = createHash('sha256').update(JSON.stringify({ senderRunId: sender.id, ...request })).digest('hex');
      const state = this.currentConversation(project, root);
      const existing = state.messages.find(message => message.id === request.id);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new DelegationPolicyError('invalid_input', 'Message ID payload conflict');
        projectConversationEvents(project.store, root);
        project.manager.reconcileWorkerWaits();
        if (recipient.agentInputs?.some(input => input.id === existing.id && !input.deliveredAt)) project.manager.deliverConversationInput(recipient.id);
        return this.conversationReceipt(project, root, existing);
      }
      const original = request.requestId ? state.messages.find(message => message.id === request.requestId && message.kind === 'request' && message.state === 'accepted') : undefined;
      if (request.requestId && (!original || (request.kind === 'reply'
        ? original.recipientRunId !== sender.id || original.senderRunId !== recipient.id
        : original.senderRunId !== sender.id || original.recipientRunId !== recipient.id))) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
      const settled = state.outcomes.find(outcome => outcome.requestId === request.requestId);
      const now = new Date().toISOString();
      const destroyed = recipient.delegation?.role === 'worker' && recipient.delegation.destroy?.phase === 'complete';
      const resumable = !['queued', 'running', 'waiting'].includes(recipient.status) || !!recipient.stopping || (recipient.delegation?.role === 'worker' && !!recipient.delegation.destroy);
      const resume = !!request.resume && resumable;
      if (resume && (destroyed || recipient.delegation?.role !== 'worker' || recipient.delegation.destroy ||
        recipient.status === 'cancelled' || recipient.stopping)) throw new DelegationPolicyError('incompatible_state',
          `Worker is ${destroyed ? 'destroyed' : 'stopped or being destroyed'}; --resume cannot restart it. Spawn a new worker with the follow-up instruction`);
      const stopped = recipient.delegation?.role === 'worker' && (recipient.status === 'cancelled' || recipient.stopping || recipient.delegation.destroy);
      const instruction = destroyed ? 'Not delivered: this worker was destroyed. Spawn a new worker for further work.'
        : stopped ? 'Not delivered: this worker was stopped or is being destroyed. Spawn a new worker for further work.'
        : resumable && !resume ? sender.id === root.id
          ? `Not delivered: worker is ${recipient.status}. To resume it with a new instruction, run worker send ${recipient.id} "<instruction>" --kind request --resume --id <new-message-UUID>; use a new message ID. Retrying this rejected ID will not deliver it.`
          : `Not delivered: parent is ${recipient.status}. A worker cannot resume its parent; the parent must be continued by its owner.`
        : undefined;
      const message: ConversationSendResult['message'] = { id: request.id, senderRunId: sender.id, recipientRunId: recipient.id,
        kind: request.kind, ...(request.requestId ? { requestId: request.requestId } : {}), text: project.store.redactText(request.text), createdAt: now, requestHash,
        ...(request.kind === 'request' && !destroyed && (!resumable || resume) ? { deadline: new Date(Date.parse(now) + request.timeoutSeconds * 1000).toISOString() } : {}),
        ...(resume ? { resumed: true as const } : {}), ...(instruction ? { instruction } : {}),
        state: request.kind === 'reply' && settled ? 'late' : destroyed ? 'destroyed' : resumable && !resume ? 'continuation-required' : 'accepted' };
      const enqueue = !destroyed && (!resumable || resume);
      if (state.messages.length >= 1024 || (enqueue && request.kind === 'request' && state.messages.filter(message => message.kind === 'request' && message.state === 'accepted' && !state.outcomes.some(outcome => outcome.requestId === message.id)).length >= 32) ||
        (enqueue && (recipient.agentInputs ?? []).filter(input => !input.deliveredAt).length >= 32)) throw new DelegationPolicyError('capacity_limit', 'Conversation capacity limit reached');
      const outcomes = [...state.outcomes];
      if (request.kind === 'reply' && !settled) outcomes.push({ requestId: request.requestId!, status: 'replied', observedAt: now, replyId: request.id });
      const input = { id: message.id, source: 'agent' as const, parentRunId: root.id, text: message.text, createdAt: now,
        conversation: { senderRunId: sender.id, recipientRunId: recipient.id, kind: message.kind, ...(message.requestId ? { requestId: message.requestId } : {}) } };
      const next = { messages: [...state.messages, message], outcomes };
      if (resume) {
        const result = project.manager.continueRun(recipient.id, {
          text: `Your parent resumed this worker with a new instruction.\nAgent conversation ${JSON.stringify({ id: input.id, ...input.conversation })}\n${input.text}`,
        }, true, { rootId: root.id, state: next, input });
        if (!result.ok) throw new DelegationPolicyError('incompatible_state', `Worker was not resumed: ${result.error}. No message was accepted; resolve this condition and retry the same command`);
      } else project.store.commitConversation(root.id, next, enqueue ? { recipientRunId: recipient.id, input } : undefined);
      projectConversationEvents(project.store, root);
      project.manager.reconcileWorkerWaits();
      if (enqueue) project.manager.deliverConversationInput(recipient.id);
      return this.conversationReceipt(project, root, message);
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
  async conversation(caller: Caller, value: ConversationInspectRequest): Promise<ConversationState> {
    const request = conversationInspectRequestSchema.parse(value);
    const { project, root, sender, recipient } = this.conversationPair(caller, request.recipientRunId);
    const state = this.currentConversation(project, root);
    projectConversationEvents(project.store, root);
    const messages = state.messages.filter(message => (message.senderRunId === sender.id && message.recipientRunId === recipient.id) || (message.senderRunId === recipient.id && message.recipientRunId === sender.id));
    return { messages, outcomes: state.outcomes.filter(outcome => messages.some(message => message.id === outcome.requestId)) };
  }
  private ownRequest(caller: Caller, requestId: string) {
    const project = this.context(caller); const sender = project.store.getRun(caller.runId);
    const root = sender?.delegation?.role === 'root' ? sender : sender?.delegation?.role === 'worker' ? project.store.getRun(sender.delegation.parentRunId) : undefined;
    const message = root?.delegation?.role === 'root' ? root.delegation.conversation?.messages.find(message => message.id === requestId && message.kind === 'request' && message.state === 'accepted' && message.senderRunId === caller.runId) : undefined;
    if (!message) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    return { ...this.conversationPair(caller, message.recipientRunId), message };
  }
  async cancelRequest(caller: Caller, value: ConversationCancelRequest): Promise<RequestOutcome> {
    const { requestId } = conversationCancelRequestSchema.parse(value);
    const { project, root } = this.ownRequest(caller, requestId);
    const state = this.currentConversation(project, root);
    const existing = state.outcomes.find(outcome => outcome.requestId === requestId);
    if (existing) {
      projectConversationEvents(project.store, root); project.manager.reconcileWorkerWaits();
      return existing;
    }
    const outcome: RequestOutcome = { requestId, status: 'cancelled', observedAt: new Date().toISOString() };
    project.store.commitConversation(root.id, { ...state, outcomes: [...state.outcomes, outcome] });
    projectConversationEvents(project.store, root); project.manager.reconcileWorkerWaits();
    return outcome;
  }
  async waitRequests(caller: Caller, value: RequestWaitRequest) {
    const request = requestWaitRequestSchema.parse(value);
    for (const id of request.requestIds) this.ownRequest(caller, id);
    const project = this.context(caller);
    const wait = project.manager.registerRequestWait(caller.runId, request);
    return { wait, instruction: `Wait registered until ${wait.deadline}. End your turn now to release capacity. Cezar resumes you on request settlement, incoming messages, deadline or cancellation; no automatic re-wait.` };
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
      })).digest('hex');
      const receipt = parent.delegation.receipts.find(r => r.requestId === request.requestId);
      if (receipt) {
        if (receipt.requestHash !== requestHash) throw new DelegationPolicyError('invalid_input', 'Request ID payload conflict');
        const worker = project.store.getRun(receipt.workerId);
        if (worker?.delegation?.role !== 'worker' || worker.delegation.parentRunId !== parent.id || worker.delegation.workspace.ownerRunId !== worker.id) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
        return { workerId: worker.id, baselineSha: worker.delegation.workspace.baselineSha };
      }
      authorizeSpawn(caller, parent, project.id);
      const catalog = await resolveSpawnWorkflow(project.root, request);
      const resolvedSteps = await resolveSpawnSteps(project.manager, parent.id, request, catalog);
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
        context: request.context, containsSecret: text => project.store.containsSessionSecret(text),
      });
      const context = prepared?.recipe;
      let accepted = false;
      try {
        // Ref resolution yields to Finish, revocation and project disposal; recheck before acceptance.
        const current = this.context(caller);
        if (current !== project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
        authorizeSpawn(caller, project.store.getRun(parent.id), project.id);
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
          autonomous: parent.autonomous, generateFollowups: parent.generateFollowups,
          steps: workflowDef.steps.map(step => ({ id: step.id, name: step.name ?? step.id, kind: stepKind(step) })),
        }, parent.id, request.requestId, { role: 'worker', permissions: [], parentRunId: parent.id, workspace, ...(context ? { context } : {}) }, requestHash, {
          ...identity, ...(context ? { contextHash: workerContextHash(context) } : {}),
          // A named catalog chain is bound like the context recipe; the default quick-task leaves the identity as before.
          ...(request.workflow === undefined ? {} : { workflowHash: workerWorkflowHash(workflowDef) }),
        });
        accepted = true;
        project.manager.enqueueOwnedRun(worker.id);
        return { workerId: worker.id, baselineSha };
      } finally { if (!accepted) await prepared?.discard(); }
    });
  }
  async inspect(caller: Caller, params: WorkerParams): Promise<WorkerInspection> {
    const { worker, parent } = this.target(caller, params, 'inspect');
    if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const outcome = workerOutcome(worker, new Date().toISOString());
    const wait = parent.delegation?.role === 'root' ? parent.delegation.wait : undefined;
    return { workerId: worker.id, parentRunId: parent.id, status: worker.status, workspace: worker.delegation.workspace,
      ...(worker.runner === undefined ? {} : { backend: worker.runner }), ...(worker.model === undefined ? {} : { model: worker.model }),
      ...(worker.delegation.context === undefined ? {} : { inputs: worker.delegation.context.inputs }),
      ...(worker.currentStepId === undefined ? {} : { currentStepId: worker.currentStepId }),
      ...(worker.activity === undefined ? {} : { activity: worker.activity }),
      ...(wait ? { wait } : {}), ...(worker.delegation.destroy ? { destroy: worker.delegation.destroy } : {}), ...(outcome ? { outcome } : {}) };
  }
  async collect(caller: Caller, params: WorkerParams): Promise<WorkerCollectedResult> {
    const project = this.context(caller);
    const { workerId } = workerParamsSchema.parse(params);
    const parent = project.store.getRun(caller.runId);
    const worker = project.store.getRun(workerId);
    if (!worker) {
      const retained = project.store.readDeletedWorkerResult(caller.runId, workerId);
      authorizeRetainedResult(caller, parent, project.id, workerId, retained);
      return project.store.commitWorkerResult(caller.runId, revalidateRetainedWorkerResult(project.root, retained!), project.store.readWorkerResultDiff(caller.runId, workerId));
    }
    authorizeWorker(caller, worker, 'inspect', parent, project.id);
    if (parent?.delegation?.role === 'root' && parent.delegation.receipts.some(receipt => receipt.workerId === workerId && receipt.deletion?.phase === 'pending')) {
      const retained = project.store.readWorkerResult(parent.id, workerId);
      if (!retained || !project.store.canDeleteRun(workerId)) throw new DelegationPolicyError('incompatible_state', 'Worker history deletion evidence is unavailable');
      return project.store.commitWorkerResult(parent.id, revalidateRetainedWorkerResult(project.root, retained), project.store.readWorkerResultDiff(parent.id, workerId));
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
    return { wait, instruction: `Wait registered until ${wait.deadline}. End your turn now to release capacity. Cezar will resume you when ${wait.mode === 'all' ? 'all selected workers settle' : 'a selected worker settles'}, or on the deadline/cancellation; no automatic re-wait.` };
  }
  async cancelWait(caller: Caller, value: WorkerCancelWaitRequest) {
    const { waitId } = workerCancelWaitRequestSchema.parse(value);
    const project = this.context(caller);
    const sender = project.store.getRun(caller.runId);
    if (sender?.delegation?.role === 'worker') {
      this.conversationPair(caller, sender.delegation.parentRunId);
      const wait = sender.delegation.wait?.id === waitId ? sender.delegation.wait : sender.delegation.lastWait?.id === waitId ? sender.delegation.lastWait : undefined;
      if (!wait?.requestIds?.length) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
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
  private destroySerialized(project: DelegationProject, workerId: string, check: () => RunRecord) {
    return this.serialized(`worker:${project.id}:${workerId}`, async (): Promise<WorkerDestroyResult> => {
      let worker = check();
      if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
      const parent = project.store.getRun(worker.delegation.parentRunId);
      if (parent?.delegation?.role === 'root' && parent.delegation.receipts.some(receipt => receipt.workerId === workerId && receipt.deletion)) {
        throw new DelegationPolicyError('incompatible_state', 'Worker history deletion has begun; retry history deletion');
      }
      const workspace = worker.delegation.workspace;
      const requestedAt = worker.delegation.destroy?.requestedAt ?? new Date().toISOString();
      const resources = (worker.delegation.destroy?.remaining ?? ['worktree', 'branch']).filter((resource): resource is 'worktree' | 'branch' => resource !== 'process');
      const persist = (phase: WorkerDestroy['phase'], remaining: WorkerDestroy['remaining'], error?: string) => {
        worker = project.store.getRun(workerId)!;
        if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
        project.store.commitDelegation([{ id: workerId, delegation: { ...worker.delegation, destroy: { requestedAt, phase, remaining, ...(error ? { error: error.slice(0, 2_000) } : {}) } } }]);
      };
      persist('requested', worker.delegation.destroy?.remaining ?? ['process', 'worktree', 'branch']);
      persist('terminating', ['process', ...resources]);
      project.manager.requestWorkerStop(workerId);
      let result: WorkerDestroyResult;
      if (!await project.manager.awaitRunTermination(workerId, 30_000)) {
        result = { workerId, state: 'incomplete', remaining: ['process', ...resources], error: 'Worker termination is not proven; retry cleanup later' };
      } else {
        persist('cleaning', resources);
        const snapshot = structuredClone(check());
        const proof = project.store.readWorkerExecution(workerId);
        const evidence = await collectWorkerEvidence(project.root, project.store, snapshot);
        const current = check();
        if (proof?.phase !== 'complete' || project.store.readWorkerExecution(workerId)?.generation !== proof.generation ||
          project.store.readWorkerExecution(workerId)?.phase !== 'complete' || current.status !== snapshot.status ||
          JSON.stringify(current.delegation) !== JSON.stringify(snapshot.delegation)) throw new Error('Worker changed before cleanup checkpoint');
        // This immutable parent payload must be durable before the first destructive operation.
        project.store.commitWorkerResult(evidence.result.parentRunId, evidence.result, evidence.diffSnapshot);
        result = await removeOwnedWorkspace(project.root, workspace, project.manager.getWorkerNoMaterializationProof(workerId));
        persist(result.state, result.remaining, result.error);
        // Preserve the captured bytes even if Git removal was only partially successful.
        const removed = !result.remaining.includes('worktree');
        project.store.commitWorkerResult(evidence.result.parentRunId, { ...evidence.result, observedAt: new Date().toISOString(),
          cleanup: result.state, outcome: result.state === 'complete' ? 'destroyed' : evidence.result.lastExecutionOutcome,
          workspace: { ...workspace, state: removed ? 'deleted' : evidence.result.workspace.state },
          head: removed ? { state: 'deleted', reason: 'missing', ...('sha' in evidence.result.head ? { sha: evidence.result.head.sha } : {}) } : evidence.result.head,
          diff: evidence.result.diff.state === 'available' ? { ...evidence.result.diff, snapshotId: randomUUID() } : evidence.result.diff,
        }, evidence.diffSnapshot);
        return result;
      }
      persist(result.state, result.remaining, result.error);
      return result;
    });
  }
}
