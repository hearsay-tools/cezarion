/** Owns launch source selection. Call each narrow operation at its original phase boundary. */
import type { Home } from '../../home/home.ts';
import { existsSync, readFileSync } from 'node:fs';
import { isImageAttachmentName } from '@open-mercato/cezar-contract/attachments';
import { delegationStateSchema } from '@open-mercato/cezar-contract/delegation';
import { readAgentModelProvider } from '../../agent-config/models.ts';
import { loadConfig, readDisabledSkillsReposSync, type CezConfig } from '../../config.ts';
import { buildChildEnv } from '../../core/agent-env.ts';
import type { AgentRunner, ContentBlock, RunnerFactory, RunnerId } from '../../core/agent-runner.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../../core/agent-model-policy.ts';
import { ModelIdentityError, formatModelIdentity, normalizeModelForBackend } from '../../core/model-identity.ts';
import { RUNNER_FACTS } from '../../core/runner-facts.ts';
import { parseDelegationEffort } from '../../delegation/effort.ts';
import { boundWorkerAccountEnv, captureWorkerAccount, continuationDefStep, ownedWorkflow, workerIdentity, workerStepIdentity, WorkerIdentityError, type WorkerAccountBinding, type WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import { DelegationPolicyError } from '../../delegation/policy.ts';
import type { QueuedMessage, RunEvent, RunRecord, RunStore, StepState } from '../../runs/store.ts';
import { makeRunTitle } from '../../runs/run-title.ts';
import { discoverSkills, filterDisabledTeamSkills, filterDisabledTeamSources, readDisabledTeamSkills, type Skill } from '../../skills.ts';
import { getTeamSkillsCached } from '../../skills-remote.ts';
import { readProjectUiState, readProjectUiStateSync } from '../../ui-state.ts';
import { DEFAULT_AGENT_ACCOUNT_ID } from '../../workspace/agent-accounts.ts';
import { resolveProfileEnvForRoot } from '../../workspace/agent-profiles.ts';
import type { ActiveRun } from '../active-run.ts';
import { resolveAttachmentPath } from '../attachment-path.ts';
import { loadWorkflows } from '../load.ts';
import { contentBlocksOf, mediaTypeFor, type PastedContent, type PersistedAttachment } from '../pasted-content.ts';
import { executionAccount } from '../execution-account.ts';
import { accountHeldFor, queuedRecoveryInput, queuedStartAt } from '../run-scheduling.ts';
import { QUICK_TASK_WORKFLOW, chainStepNote, stepKind, stepToolGrant, type WorkflowDef, type WorkflowStepDef } from '../types.ts';
import { agentInputOutcomeText } from './input-batch.ts';
import type { LaunchContextHost } from './launch-context.ts';
import type { OpeningHost } from './opening.ts';
import { applyTemplate, resolveExtraSystemPrompt } from './prompts.ts';
import type { PendingJob } from './run-line.ts';
import type { QueuedRevivalHost } from './queued-revival.ts';
import type { ContinuationOpening, Execution, PendingContinuation, RunModuleContext, StartRunInput, StepModel } from './types.ts';

// This view adds no promise continuation before the caller's original post-config gate.
function readLaunchConfig(repoRoot: string, home: Home): Promise<LaunchConfig> {
  return loadConfig(repoRoot, home) as unknown as Promise<LaunchConfig>;
}

type LaunchContext = Pick<RunModuleContext, 'store' | 'repoRoot' | 'dataDir' | 'home'>;

async function configuredModelProvider(
  backend: RunnerId,
  repoRoot: string,
): Promise<string | undefined> {
  return readAgentModelProvider(backend, repoRoot).catch(() => undefined);
}

/** The model-identity gate shared by fresh steps and Continue. */
async function resolveLaunchModel(backend: RunnerId, model: string | undefined, cwd: string) {
  return normalizeModelForBackend(backend, model, { configuredProvider: await configuredModelProvider(backend, cwd) });
}

/**
 * The model a Continue runs with, or the model identity error's message.
 * Apply the SAME canonical-identity gate the first spawn applies.
 * A follow-up may switch both runner and model, so without this the record keeps
 * asserting the identity the run STARTED with while a different model serves the turn —
 * the exact defect that PR existed to remove — and the raw record string reaches the CLI
 * in the un-normalised wire form the first step already converted away (`anthropic/opus`
 * instead of `opus`). Fail loud here too rather than let the backend pick a default.
 */
async function continuationModel(
  store: RunStore,
  repoRoot: string,
  runId: string,
  state: ActiveRun,
  record: RunRecord | undefined,
  toolsStep: WorkflowStepDef | undefined,
  stepIdentity: WorkerStepIdentity | undefined,
  backend: RunnerId,
  home: Home,
): Promise<{ backendModel: string | undefined } | string> {
  // The owning step's authored `model` wins over the run-level pin, exactly as the first
  // spawn resolved `step.model ?? input.model`: a catalog worker keeps the
  // parent's inherited model at run level, so reading only the record silently switched a
  // step authored for another model on Continue.
  try {
    const normalized = await resolveLaunchModel(
      backend,
      agentModelsLocked(repoRoot, process.env, home) ? undefined : stepIdentity ? stepIdentity.model : toolsStep?.model ?? record?.model,
      state.liveSession.cwd,
    );
    store.updateRun(runId, {
      modelIdentity: normalized ? formatModelIdentity(normalized.identity) : undefined,
    });
    return { backendModel: normalized?.backendModel };
  } catch (err) {
    if (!(err instanceof ModelIdentityError)) throw err;
    return err.message;
  }
}

/** The effort a Continue runs at, or the message of the error that refuses it: an owned worker's
 *  pinned effort, else the continued step's authored one, else the run's; unset when the project
 *  locks agent models. */
function continuationEffort(
  repoRoot: string,
  record: RunRecord | undefined,
  toolsStep: WorkflowStepDef | undefined,
  stepIdentity: WorkerStepIdentity | undefined,
  home: Home,
): { effort: string | undefined } | string {
  try {
    const modelsLocked = agentModelsLocked(repoRoot, process.env, home);
    const authoredStepEffort = toolsStep?.effort !== undefined;
    if (modelsLocked && toolsStep?.effort?.trim()) throw new Error(AGENT_MODELS_LOCKED_ERROR);
    const stepEffort = parseDelegationEffort(toolsStep?.effort);
    return {
      effort: modelsLocked
        ? undefined
        : stepIdentity ? stepIdentity.effort : authoredStepEffort ? stepEffort : record?.effort,
    };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The Continue's runner, and whether it resumes into a thread that already holds the skill
 *  playbook. A resumed session keeps the transport its owning step recorded. The Cursor runner
 *  refuses a resume not recorded on print, untagged ones included (hearsay-tools/cezarion#1267). */
function continuationRunner(
  backend: RunnerId,
  sessionId: string | undefined,
  owningStep: RunRecord['steps'][number] | undefined,
  factory: RunnerFactory,
): { runner: AgentRunner; skipSkillOnResume: boolean } {
  const sessionTransport = sessionId !== undefined ? owningStep?.sessionTransport : undefined;
  const runner = factory(backend, sessionTransport ? { sessionTransport } : {});
  return { runner, skipSkillOnResume: sessionId !== undefined && runner.systemPromptOnResume === 'in-thread' };
}

/**
 * Canonical provider/model identity — the normalised `provider/model`
 * the task ran with, persisted for cost attribution / reproducible replay
 * beside the free-text `model`. Best-effort here (a per-step `runner`/`model`
 * can still override it); the authoritative fail-loud gate is at spawn.
 */
async function taskModelIdentity(repoRoot: string, taskBackend: RunnerId, source: SourceInput, home: Home): Promise<string | undefined> {
  const input = sourceInput(source);
  try {
    const normalized = await resolveLaunchModel(
      taskBackend,
      agentModelsLocked(repoRoot, process.env, home) ? undefined : input.model,
      repoRoot,
    );
    return normalized ? formatModelIdentity(normalized.identity) : undefined;
  } catch {
    // An unresolvable task-level model surfaces loudly at the step; the
    // metadata echo stays absent rather than guessing.
    return undefined;
  }
}

/**
 * The model and effort a fresh step runs with. Normalise the selected model to canonical
 * `provider/model` and back to the backend's own wire form via the ONE shared mapper.
 * Fail-loud: an unresolvable model (e.g. a bare id on opencode) returns the step error
 * instead of letting the backend silently substitute its default.
 */
async function stepModel(
  store: RunStore,
  repoRoot: string,
  runId: string,
  state: ActiveRun,
  step: WorkflowStepDef,
  source: SourceInput,
  stepBackend: RunnerId,
  stepIdentity: WorkerStepIdentity | undefined,
  home: Home,
): Promise<StepModel | string> {
  const input = sourceInput(source);
  try {
    const modelsLocked = agentModelsLocked(repoRoot, process.env, home);
    if (modelsLocked && step.effort?.trim()) return AGENT_MODELS_LOCKED_ERROR;
    const effectiveEffort = stepEffort(store, runId, step, input, stepIdentity, modelsLocked);
    const normalized = await resolveLaunchModel(
      stepBackend,
      modelsLocked ? undefined : stepIdentity ? stepIdentity.model : step.model ?? input.model,
      state.liveSession.cwd,
    );
    // Persist the identity of what ACTUALLY runs. The run-start echo
    // (line ~993) is best-effort from `taskBackend`/`input.model`; a per-step `runner`/`model`
    // override makes it assert a model that never ran. Re-write it here, from the resolved
    // step identity, so the record — the product of this PR — is always one that ran.
    store.updateRun(runId, {
      modelIdentity: normalized ? formatModelIdentity(normalized.identity) : undefined,
    });
    return { backendModel: normalized?.backendModel, effectiveEffort };
  } catch (err) {
    if (err instanceof ModelIdentityError || err instanceof DelegationPolicyError) return err.message;
    throw err;
  }
}

/** The effort a fresh step runs at: an owned worker's pinned effort, else the step's authored one,
 *  else the run's; unset when the project locks agent models. An invalid authored effort throws
 *  `DelegationPolicyError`. */
function stepEffort(
  store: RunStore,
  runId: string,
  step: WorkflowStepDef,
  input: StartRunInput,
  stepIdentity: WorkerStepIdentity | undefined,
  modelsLocked: boolean,
): string | undefined {
  const authoredStepEffort = step.effort !== undefined;
  const stepEffort = parseDelegationEffort(step.effort);
  return modelsLocked
    ? undefined
    : stepIdentity ? stepIdentity.effort : authoredStepEffort ? stepEffort : store.getRun(runId)?.effort ?? input.effort;
}

// The method name also preserves P1's catalog-reader guard. Registry storage stays in RunSkills.
const skillSourceReads = {
  enabledSkills(state: ActiveRun, repoRoot: string, disabled: ReturnType<typeof readDisabledTeamSkills>): Skill[] {
    const sources = filterDisabledTeamSources(state.skills.catalog ?? [], readDisabledSkillsReposSync(repoRoot));
    return filterDisabledTeamSkills(sources, disabled);
  },
};

export const atTaskHead = { executionPayload, queuedPayload, resumedPayload, acceptedWorkflowFields, recordedRunner, defaultRunner, runnerless, heldFor, accountFor, workerStep, executionInput, executionWorkflow, requeueJob, baseBranch, worktreeSetup: continuationWorktreeSetup, jobInput, jobWorkflow, resumedJob, storedWorkflow, interruptedIndex, interruptedDefinition, heldAccount, worktree: inputWorktree, workflowName, images: acceptedImages, task: acceptedTask, skillHint: acceptedSkillHint, ownedJob, verifyIdentity: verifyWorkerIdentity, autonomous: inputAutonomous, reviveWorkflow, queuedResumeSession, recoveryInput: queuedRecoveryInput, registry: discoverRunSkills, acceptedRunFields, acceptInput, modelIdentity: taskModelIdentity, config: readLaunchConfig, runner: taskRunner, systemPrompt: taskSystemPrompt, hydrateQueuedInput, attachments: readPersistedAttachments };
export const atStepOpen = { afterStepPayload, sessionPayload, sessionWaitPayload, retryIndex, workflowLength, workflowStep, workflowSlice, workflowChainNote, runner: stepRunner, prompt: stepPrompt, skill: stepSkill, toolGrant: continuationToolGrant, enabledSkills: skillSourceReads.enabledSkills, disabledSkills: readDisabledTeamSkills, projectUiState: readProjectUiState, projectUiStateSync: readProjectUiStateSync, teamSkills, filterSkills: filterDisabledTeamSkills, contextVariables, model: stepModel, effort: stepEffort, openingInputs, agentEnvForStep, workerStep };
export const atLiveInput = { disabledSkills: readDisabledTeamSkills, projectUiState: readProjectUiState, projectUiStateSync: readProjectUiStateSync, teamSkills, filterSkills: filterDisabledTeamSkills, queuedMessages: queuedMessageSource, taskAttachmentUrls, enabledSkills: skillSourceReads.enabledSkills };
export const atContinue = { task: retriedTask, heldStep: heldWorkflowStepId, heldRunner: heldStepRunner, resumedStep, storedWorkflow, workflowStep, workflowLength, agentEnvForStep, workerStep, registry: discoverRunSkills, enabledSkills: skillSourceReads.enabledSkills, disabledSkills: readDisabledTeamSkills, projectUiState: readProjectUiState, projectUiStateSync: readProjectUiStateSync, teamSkills, filterSkills: filterDisabledTeamSkills, isPrintTransport: printSessionTransport, skill: continuedSkill, checkpoint: continuedCheckpoint, prompt: continuedPrompt, rejoinLine: rejoinContinuationLine, verifyIdentity: verifyWorkerIdentity, waitingBeforeFinalWorkflowStep, waitingWorkflowStepIndex, continuationNextStep, ciWorkflowResumeStepIndex, resumableSessionId, continuedSessionId, isSyntheticContinuation, owningStep: continuationOwningStep, definitionStep: continuationDefStep, toolGrant: continuationToolGrant, extraSystemPrompt: continuedSystemPrompt, recordedProfile: continuedProfileId, definitionId: continuationStepId, model: continuationModel, effort: continuationEffort, runner: continuationRunner, hydrateQueuedContinuation, config: readLaunchConfig, worktreeSetup: continuationWorktreeSetup, opening: continuationOpening, openingImages: continuationImages };

function hydrateQueuedInput(context: RunModuleContext, readAttachments: AttachmentReader, runId: string, input: StartRunInput): StartRunInput {
    const run = context.store.getRun(runId);
    if (!run) return input;
    const stack = run.queuedMessages ?? [];

    const task = foldQueuedTask(run.task, stack);

    // Keep the original in-memory blocks for a live process (including the
    // best-effort case where persistence failed). Recovery has no such copy,
    // so rebuild it from the durable task-image URLs.
    const images = input.images?.length
      ? input.images
      : readAttachments(runId, run.taskImages ?? [], 'task').blocks;
    const stackedImages = readAttachments(
      runId,
      stack.flatMap((m) => m.images ?? []),
      'queued',
    ).blocks;

    return {
      ...input,
      task,
      ...(images.length ? { images } : { images: undefined }),
      ...(stackedImages.length ? { stackedImages } : { stackedImages: undefined }),
    };
  }

function hydrateQueuedContinuation(context: RunModuleContext, readAttachments: AttachmentReader, 
    runId: string,
    continuation: PendingContinuation,
  ): PendingContinuation & {
    persistedImages: ContentBlock[];
    persistedAttachments: PersistedAttachment[];
  } {
    const run = context.store.getRun(runId);
    if (!run) {
      return { ...continuation, persistedImages: [], persistedAttachments: [] };
    }
    const stack = run.queuedMessages ?? [];
    const amendedTask = foldQueuedTask(run.task, stack);
    const openingPrompt = run.continuationMessage?.text ?? continuation.prompt;
    const prompt = queuedContinuationPrompt(openingPrompt, amendedTask);
    const persisted = readAttachments(
      runId,
      stack.flatMap((message) => message.images ?? []),
      'queued',
    );
    return {
      ...continuation,
      prompt,
      persistedImages: persisted.blocks,
      persistedAttachments: persisted.attachments,
    };
  }

function readPersistedAttachments(context: RunModuleContext, 
    runId: string,
    urls: string[],
    kind: 'task' | 'queued' | 'continuation',
  ): PersistedAttachments {
    const blocks: ContentBlock[] = [];
    const attachments: PersistedAttachment[] = [];
    for (const url of urls) {
      const name = url.split('/').pop();
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
      const path = resolveAttachmentPath(context.dataDir, runId, name);
      try {
        if (!path) throw new Error('missing or unsafe attachment');
        if (isImageAttachmentName(name)) {
          const data = readFileSync(path);
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaTypeFor(name), data: data.toString('base64') },
          });
        } else if (!existsSync(path)) {
          throw new Error('missing');
        }
        attachments.push({ name, url, path });
      } catch {
        // Degrade, never fail the boot (AGENTS.md): the user deleted `.ai/cezar/`
        // or the file is unreadable — start with the text and say which attachment went.
        context.store.appendEvent(runId, {
          type: 'note',
          message: `${kind} attachment ${name} could not be read — starting without it`,
        });
      }
    }
    return { blocks, attachments };
  }

function foldQueuedTask(task: string, stack: QueuedMessage[]): string {
  return [task, ...stack.map(message => message.text)]
    .map(part => part.trim()).filter(part => part.length > 0).join('\n\n');
}

function queuedContinuationPrompt(openingPrompt: string, amendedTask: string): string {
  return amendedTask ? `${openingPrompt}\n\nCurrent task and queued updates:\n\n${amendedTask}` : openingPrompt;
}


interface PersistedAttachments { blocks: ContentBlock[]; attachments: PersistedAttachment[] }
type AttachmentReader = (runId: string, urls: string[], kind: 'task' | 'queued' | 'continuation') => PersistedAttachments;

/** A Continue's opening message: the checkpoint's agent input with its outcome, its images and
 *  attachments, and the `user-message` event that shows it. */
function continuationOpening(
  store: RunStore,
  host: OpeningHost,
  runId: string,
  stepId: string,
  state: ActiveRun,
  record: RunRecord | undefined,
  input: { prompt: string; images: PastedContent[]; persistedImages: ContentBlock[]; persistedAttachments: PersistedAttachment[] },
): ContinuationOpening {
  const checkpoint = record?.continuationMessage;
  state.inputState.selectOpeningInput(checkpoint?.agentInputId);
  const openingInput = record?.agentInputs?.find(input => input.id === checkpoint?.agentInputId);
  // Hydration has already included later human updates and task edits. Append
  // the current obligation outcome without replacing that composed prompt.
  // A parent's answer to a routed question is shown as its conversation reply, not
  // as a human message, and its own reply outcome is not news to the worker.
  const answerSource = openingInput ? host.answerSource(runId, openingInput) : undefined;
  let prompt = input.prompt;
  if (openingInput && !answerSource) prompt += agentInputOutcomeText(openingInput, store.getRun(openingInput.parentRunId));
  const { openingImages, attachments } = continuationImages(host, runId, stepId, checkpoint, input);
  if (checkpoint?.origin !== 'lifecycle' && !answerSource) store.appendEvent(runId, {
    type: 'user-message',
    stepId,
    text: prompt,
    imageCount: openingImages.filter((b) => b.type === 'image').length,
    ...(attachments.length ? { images: attachments.map((saved) => saved.url) } : {}),
  });
  return { prompt, checkpoint, ...(answerSource ? { answerSource } : {}), openingImages, attachments };
}

/** A Continue's opening images and attachments. */
function continuationImages(
  host: OpeningHost,
  runId: string,
  stepId: string,
  checkpoint: RunRecord['continuationMessage'],
  input: { images: PastedContent[]; persistedImages: ContentBlock[]; persistedAttachments: PersistedAttachment[] },
): { openingImages: ContentBlock[]; attachments: PersistedAttachment[] } {
  // Attachments pasted into the follow-up composer, on the same terms as a live-session
  // message: persisted to the run's own attachment store so the thread renders the
  // bubble's images rather than a bare count, and handed to the agent as absolute paths
  // appended to the prompt (so it can operate on them — and because codex/opencode drop image
  // blocks before they reach the model). An image ALSO rides along as a base64 block so the
  // model can view it; a file has nothing to view and travels as its path alone.
  const saved = host.readPersistedAttachments(
    runId, checkpoint?.id === stepId ? checkpoint.images ?? [] : [], 'continuation',
  );
  const openingImages = [...(input.images.length ? contentBlocksOf(input.images) : saved.blocks), ...input.persistedImages];
  const attachments = [...saved.attachments, ...input.persistedAttachments];
  return { openingImages, attachments };
}

/**
 * The task's attachments for the first agent step's opening message, and its image blocks.
 * Both are empty once an agent step of this workflow has run.
 */
function openingInputs(store: RunStore, dataDir: string, execution: Execution): { attachments: PersistedAttachment[]; images: ContentBlock[] | undefined } {
  const { runId, workflow } = execution;
  const input = inputValue(execution.input);
  // `startRun` already persisted the task's attachments so a queued bubble can render them
  //. Reuse those files for the agent-facing path note instead of minting
  // duplicate pasted files when execution finally begins.
  //
  // The STACK's attachments are listed here too: they were persisted when they were
  // enqueued, and their paths are the only thing an agent ever gets for a non-image one — a
  // note that covered the initial prompt alone would hand it a task about a file it was never
  // told the path of.
  const startRecord = store.getRun(runId);
  const openingAlreadyDelivered = workflow.steps.some(definition =>
    stepKind(definition) === 'agent' &&
    (startRecord?.steps.find(step => step.id === definition.id)?.iterations ?? 0) > 0,
  );
  const attachments: PersistedAttachment[] = openingAlreadyDelivered ? [] : [
    ...(startRecord?.taskImages ?? []),
    ...(startRecord?.queuedMessages ?? []).flatMap((m) => m.images ?? []),
  ]
    .map((url): PersistedAttachment | null => {
      const name = url.split('/').pop();
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
      const path = resolveAttachmentPath(dataDir, runId, name);
      if (!path) {
        store.appendEvent(runId, {
          type: 'note',
          message: `task attachment ${name} could not be read — starting without it`,
        });
        return null;
      }
      return { name, url, path };
    })
    .filter((saved): saved is PersistedAttachment => saved !== null);
  // Task screenshots go with the FIRST agent step's opening message only —
  // later steps and retry loops run in fresh sessions without them. Stacked
  // attachments ride along too, but are NOT re-persisted above: they
  // already live on disk, and adding them to `taskImages` would both duplicate
  // the files and make the task bubble claim the stack's images as its own.
  // File blocks are dropped here — a session only ever sees viewable blocks. An empty
  // result stays `undefined` rather than `[]`, so a task carrying only files hands the runner
  // seam exactly the shape a task carrying nothing always did.
  const blocks = openingAlreadyDelivered
    ? []
    : contentBlocksOf([...(input.images ?? []), ...(input.stackedImages ?? [])]);
  return { attachments, images: blocks.length ? blocks : undefined };
}

async function agentEnvForStep(
  { store, repoRoot, home }: LaunchContext,
  host: LaunchContextHost,
  runId: string,
  backend: RunnerId,
  options: { recordedProfileId?: string | undefined; stepId?: string | undefined; phase?: 'step-open' | 'continue' } = {},
): Promise<{ env: Record<string, string>; profileId: string; accountBinding?: WorkerAccountBinding | undefined }> {
  // An owned worker binds the account its identity pinned for THIS step; a legacy identity
  // answers every step with its single run-level account, so the one-provider rule still holds there.
  const step = host.workerStep(runId, options.stepId);
  if (step) {
    if (backend !== step.account.provider) throw new WorkerIdentityError('Accepted worker provider identity cannot change');
    const env = host.agentEnv(runId);
    return { env: { ...env, ...boundWorkerAccountEnv(step.account, buildChildEnv({ backend, extraEnv: env })) },
      profileId: step.account.profileId, accountBinding: step.account };
  }
  const run = store.getRun(runId);
  const profileId = options.recordedProfileId
    ?? (backend === (run?.runner ?? 'claude') ? run?.agentProfile : undefined);
  const resolved = await resolveProfileEnvForRoot(repoRoot, backend, profileId, process.env, home);
  const env = { ...host.agentEnv(runId), ...resolved.env };
  return {
    env,
    profileId: resolved.profile.id,
    accountBinding: captureWorkerAccount(resolved.profile, buildChildEnv({ backend, extraEnv: env })),
  };
}

function workerStep({ store, repoRoot, home }: LaunchContext, runId: string, stepId: string | undefined): WorkerStepIdentity | undefined {
  const identity = workerIdentity(store, repoRoot, runId, stepId, home);
  if (!identity) return undefined;
  return stepId === undefined
    ? { account: identity.account, grants: identity.grants, ...(identity.model === undefined ? {} : { model: identity.model }), ...(identity.effort === undefined ? {} : { effort: identity.effort }) }
    : workerStepIdentity(identity, stepId);
}

/** Non-launch readers receive only the setting their operation consumes. */
export function narrowTitleConfig(repoRoot: string, home: Home): Promise<Pick<CezConfig, 'liveTitleUpdates'>> { return loadConfig(repoRoot, home); }
export function narrowReviewConfig(repoRoot: string, home: Home): Promise<Pick<CezConfig, 'reviewGate'>> { return loadConfig(repoRoot, home); }
function continuationWorktreeSetup(handle: LaunchConfig): unknown {
  return configValue(handle).worktreeSetup;
}

/** Opaque handles capture source references. Binding performs no source-field reads. */
class InputToken {
  #identity = true;
  constructor() { void this.#identity; Object.freeze(this); }
}
declare const configIdentity: unique symbol;
/** A type-only view keeps loadConfig's original promise and object identity. */
export type LaunchConfig = { readonly [configIdentity]: never };
export type LaunchSource = InputToken;
const launchInputs = new WeakMap<LaunchSource, StartRunInput>();
export function bindLaunchSource(input: StartRunInput): LaunchSource {
  const handle = new InputToken();
  launchInputs.set(handle, input);
  return handle;
}
function inputValue(handle: LaunchSource): StartRunInput {
  const input = launchInputs.get(handle);
  if (!input) throw new TypeError('Invalid launch source handle');
  return input;
}
function configValue(handle: LaunchConfig): CezConfig {
  return handle as unknown as CezConfig;
}
function taskRunner(source: LaunchSource, config: LaunchConfig): RunnerId {
  return inputValue(source).runner ?? configValue(config).defaultRunner;
}
function taskSystemPrompt(store: RunStore, runId: string, source: LaunchSource, config: LaunchConfig): string | undefined {
  return store.getRun(runId)?.delegation?.role === 'worker'
    ? inputValue(source).systemPrompt
    : resolveExtraSystemPrompt(inputValue(source).systemPrompt, configValue(config).systemPrompt);
}

function acceptedRunFields(input: StartRunInput, workflow: WorkflowDef, effectiveInput: StartRunInput, clientRequest?: { id: string; hash: string }): Parameters<RunStore['createRun']>[0] {
  return {
      title: makeRunTitle(input.task, workflow),
      workflow: workflow.name,
      task: input.task,
      systemPrompt: input.systemPrompt,
      model: effectiveInput.model,
      effort: effectiveInput.effort,
      runner: input.runner,
      // The composer's per-task account (spec 2026-07-29-agent-profiles). Persisted at creation
      // so a queued run picks it up at dequeue and every later resume reads the same answer.
      agentProfile: input.agentProfile,
      // Persist autonomy on the record so the terminal review gate
      // (`settleSuccess`) can honor it — mid-run
      // auto-nudge reads `input.autonomous` (`execute`), but the record is the
      // only source those after-the-fact consumers have.
      autonomous: input.autonomous === true,
      archiveWhenDone: input.archiveWhenDone,
      autoMergePr: input.autoMergePr,
      // Stored explicitly, so a later change of the default never widens an existing task.
      allowWorkers: input.allowWorkers !== false,
      allowMessaging: input.allowMessaging !== false,
      notify: input.notify === true,
      // Persist the explicit opt-out so queued-run restart recovery and the
      // session Git routes can distinguish it from a removed isolated worktree.
      worktree: input.worktree === false ? false : undefined,
      clientRequestId: clientRequest?.id,
      clientRequestHash: clientRequest?.hash,
      automation: input.automation,
      automationTrigger: input.automationTrigger,
      steps: workflow.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, kind: stepKind(s) })),
    };
}

function acceptInput(repoRoot: string, input: StartRunInput, home: Home): StartRunInput {
  return agentModelsLocked(repoRoot, process.env, home) ? { ...input, model: undefined, effort: undefined } : input;
}

function discoverRunSkills(repoRoot: string, builtin: Skill[], home: Home): Promise<Skill[]> {
  return discoverSkills(repoRoot, { builtin }, home);
}
function teamSkills(repoRoot: string, home: Home): Skill[] {
  return filterDisabledTeamSources(getTeamSkillsCached(repoRoot, home), readDisabledSkillsReposSync(repoRoot));
}

function continuationOwningStep(record: RunRecord | undefined, sessionId: string | undefined): RunRecord['steps'][number] | undefined {
  return sessionId === undefined ? undefined : record?.steps.find(candidate => candidate.sessionId === sessionId);
}
function continuationToolGrant(identity: WorkerStepIdentity | undefined, definition: WorkflowStepDef | undefined, backend: RunnerId) {
  return stepToolGrant(identity?.grants, definition, backend);
}
function continuedSystemPrompt(record: RunRecord | undefined): string | undefined { return record?.systemPrompt; }
function continuedProfileId(owningStep: RunRecord['steps'][number] | undefined): string | undefined { return owningStep?.profileId; }
function continuationStepId(toolsStep: WorkflowStepDef | undefined): string | undefined { return toolsStep?.id; }

function contextVariables(run: RunRecord): { task: string; 'workflow.name': string } {
  return { task: run.task, 'workflow.name': run.workflow };
}

async function reviveWorkflow(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord): Promise<WorkflowDef | null> {
  // "Looks sane" is the STORE's job now: it parses `workflowDef` against the definition schema
  // and `.catch`es a def that no longer fits to `undefined`, so anything present here already
  // has the `steps` array the old inline `Array.isArray` check was asking for.
  const def = run.workflowDef;
  if (def) return def;
  const { workflows } = await loadWorkflows(context.repoRoot);
  return workflows.find((w) => w.name === run.workflow) ?? null;
}

function queuedResumeSession(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, sessionStep: RunRecord['steps'][number]) {
  // An accepted worker's continuation extends the step owning the resumed session, so its
  // runner and account come from that step's pinned identity, never the run-level
  // first-step fields — those would re-queue a claude review's Continue as a codex turn with
  // no session to resume. Broken identity evidence is left for the launch to report.
  let resumeIdentity: WorkerStepIdentity | undefined;
  try { resumeIdentity = host.workerStep(run.id, continuationDefStep(context.store, run, sessionStep.sessionId)?.id); }
  catch (error) { if (!(error instanceof WorkerIdentityError)) throw error; }
  const backend = resumeIdentity?.account.provider ?? retryInFlightRunner(run) ?? run.runner ?? 'claude';
  const sessionBackend = sessionStep.backend ?? backend;
  const sessionAccount = sessionStep.profileId ?? DEFAULT_AGENT_ACCOUNT_ID;
  // A provider retry keeps the held step's account, resolved as `sessionAccount` is (hearsay-tools/squawk#3337).
  const agentProfile = resumeIdentity?.account.profileId ?? (retryInFlightRunner(run) ? sessionAccount : run.agentProfile);
  const sameAccount = agentProfile === undefined || agentProfile === sessionAccount;
  const recoveredSessionId = sessionBackend === backend && sameAccount
    ? host.resumableSessionId(run.id, sessionStep) : undefined;
  return { backend, sessionBackend, sameAccount, recoveredSessionId };
}

type SyntheticContinuationRead = (run: RunRecord, step: StepState) => boolean;

/** A synthetic continuation can settle only the resumed agent turn. If the
 * original workflow still has steps after the waiting one, that would skip
 * those steps rather than resume the workflow engine. */
function waitingBeforeFinalWorkflowStep(run: RunRecord, isSyntheticContinuation: SyntheticContinuationRead, waitingWorkflowStepIndex: (run: RunRecord) => number): boolean {
  const steps = run.workflowDef?.steps ?? run.steps.filter(step => !isSyntheticContinuation(run, step));
  if (!steps.length || !run.currentStepId) return true;
  const currentStep = run.steps.find(step => step.id === run.currentStepId);
  if (currentStep && isSyntheticContinuation(run, currentStep)) {
    const waiting = waitingWorkflowStepIndex(run);
    return waiting >= 0 && waiting < steps.length - 1;
  }
  const current = steps.findIndex((step) => step.id === run.currentStepId);
  return current < 0 || current < steps.length - 1;
}

/** Locate the original workflow step whose closed session a synthetic Continue is resuming. */
function waitingWorkflowStepIndex(run: RunRecord, isSyntheticContinuation: SyntheticContinuationRead, ciWorkflowResumeStepIndex: (run: RunRecord) => number): number {
  const steps = run.workflowDef?.steps ?? run.steps.filter(step => !isSyntheticContinuation(run, step));
  if (!steps.length) return -1;
  // CI recovery can resume a failed attempt. Its cursor must survive both the
  // synthetic continuation replacing currentStepId and wait delivery retiring the wait.
  const ciSource = ciWorkflowResumeStepIndex(run);
  if (ciSource >= 0) return ciSource;
  const interrupted = steps.findIndex((step) => {
    const persisted = run.steps.find((candidate) => candidate.id === step.id);
    return stepKind(step) === 'agent' && persisted?.status === 'failed' && persisted.error === 'interrupted — cezar process exited during the run';
  });
  if (interrupted >= 0) return interrupted;
  for (let index = steps.length - 1; index >= 0; index--) {
    const persisted = run.steps.find((step) => step.id === steps[index]!.id);
    // Startup recovery records an interrupted live step as failed before it
    // constructs the synthetic continuation. Later workflow steps are still
    // pending, so that failed step remains the continuation's source.
    if (persisted?.status === 'waiting' || persisted?.status === 'running') return index;
  }
  return -1;
}

function continuationNextStep(store: Pick<RunStore, 'getRun'>, runId: string, waitingWorkflowStepIndex: (run: RunRecord) => number): WorkflowStepDef | undefined {
  const run = store.getRun(runId);
  const index = run?.workflowDef ? waitingWorkflowStepIndex(run) : -1;
  return index >= 0 ? run!.workflowDef!.steps[index + 1] : undefined;
}

/** The workflow agent step a provider-error hold resumes (hearsay-tools/squawk#3337): the failed one,
 *  so a successful retry runs the steps after it instead of settling the run. */
function heldWorkflowStepId(run: RunRecord): string | undefined {
  if (run.workflowResumeStepId) return run.workflowResumeStepId;
  // Only the workflow step the run is on, and only when it failed. An earlier step a retry already
  // recovered keeps its failed status (`settleResumedWorkflowStep`), and a later Continue's own
  // failure is no workflow step's, so neither becomes the cursor.
  const current = run.workflowDef?.steps.find(step => step.id === run.currentStepId && stepKind(step) === 'agent');
  return current && run.steps.find(persisted => persisted.id === current.id)?.status === 'failed' ? current.id : undefined;
}

/** The runner the held workflow step ran on, which its retry keeps (hearsay-tools/squawk#3337). */
function heldStepRunner(run: RunRecord): RunnerId | undefined {
  return run.steps.find(step => step.id === run.workflowResumeStepId)?.backend;
}

/** A provider-error retry keeps the held step's runner across a restart, as its admission chose
 *  (hearsay-tools/squawk#3337). The reason and the held step are on the record from the hold's own
 *  write, so a crash right after admission cannot lose them. */
function retryInFlightRunner(run: RunRecord): RunnerId | undefined {
  return run.autoResumeReason === 'provider-error' ? heldStepRunner(run) : undefined;
}

function ciWorkflowResumeStepIndex(run: RunRecord): number {
  if (!run.workflowResumeStepId) return -1;
  return run.workflowDef?.steps.findIndex(step => step.id === run.workflowResumeStepId &&
    stepKind(step) === 'agent' && run.steps.find(persisted => persisted.id === step.id)?.status === 'failed') ?? -1;
}

/**
 * The saved session id a Continue can resume, or undefined when it opens a fresh session. A
 * `launch` runner opened its session under the saved id. A `native` runner replaces Squawk's launch
 * UUID only with its `session` event (hearsay-tools/cezarion#583, hearsay-tools/cezarion#2991), so
 * its saved id resumes when a recorded `session` event names it, or when the event history does
 * not show the launch of the step that first holds the id. Older or salvaged run data can keep a
 * step without its history; that id keeps its conversation, and a runner that never knew it
 * refuses the resume. A shown launch with no matching `session` event ended before the runner
 * reported its id. A `cursor-print` id always needs its print `session` event.
 */
function resumableSessionId(store: Pick<RunStore, 'getRun' | 'readEvents'>, runId: string, sessionStep: StepState | undefined): string | undefined {
  const sessionId = sessionStep?.sessionId;
  if (!sessionId) return undefined;
  const run = store.getRun(runId);
  if (RUNNER_FACTS[sessionStep.backend ?? run?.runner ?? 'claude'].sessionIdSource === 'launch') return sessionId;
  const events = store.readEvents(runId);
  if (sessionStep.sessionTransport === 'cursor-print') return printSessionConfirmed(run, events, sessionStep) ? sessionId : undefined;
  if (events.some(event => event.type === 'session' && event.sessionId === sessionId)) return sessionId;
  const owner = run?.steps.find(step => step.sessionId === sessionId) ?? sessionStep;
  return events.some(event => event.type === 'step-start' && event.stepId === owner.id) ? undefined : sessionId;
}

/** A Continue records the existing id before the resumed process emits its own session event.
 *  After a crash, its original owning step still holds the print-session proof; later steps
 *  cannot establish that proof. */
function printSessionConfirmed(run: RunRecord | undefined, events: RunEvent[], sessionStep: StepState): boolean {
  const sessionStepIndex = run?.steps.findIndex((step) => step.id === sessionStep.id) ?? -1;
  const printEvidenceSteps = new Set(run?.steps.slice(0, sessionStepIndex + 1)
    .filter((step) => step.sessionId === sessionStep.sessionId && step.sessionTransport === 'cursor-print')
    .map((step) => step.id));
  return events.some((event) => event.type === 'session' && event.sessionId === sessionStep.sessionId &&
    event.stepId !== undefined && printEvidenceSteps.has(event.stepId) && event.sessionTransport === 'cursor-print');
}

/** The recorded session a Continue continues: the one it resumes, else the run's latest recorded
 *  session from before this Continue's own step. Its owning step names the skill, grants, model,
 *  effort and worker identity the Continue runs with, also when the Continue opens a fresh session
 *  (hearsay-tools/cezarion#2991). Undefined when no earlier step recorded a session. */
function continuedSessionId(record: RunRecord | undefined, continuationStepId: string, resumeSessionId: string | undefined): string | undefined {
  return resumeSessionId ?? [...record?.steps ?? []].reverse().find(step => step.id !== continuationStepId && step.sessionId)?.sessionId;
}

function isSyntheticContinuation(run: RunRecord, step: StepState): boolean {
  if (step.synthetic === 'continuation') return true;
  // Legacy records predate explicit provenance. Only an accepted continuation's
  // durable message links its generated step; an ID prefix alone is never identity.
  return (run.continuationMessage?.id === step.id ||
    (!!run.workflowDef && !run.workflowDef.steps.some(candidate => candidate.id === step.id) &&
      step.kind === 'agent' && step.name === 'Continue')) && /^continue-\d+$/.test(step.id);
}

function verifyWorkerIdentity(store: RunStore, repoRoot: string, runId: string, home: Home): void {
  workerIdentity(store, repoRoot, runId, undefined, home);
}
function inputAutonomous(input: StartRunInput): boolean { return input.autonomous === true; }

function ownedJob(context: RunModuleContext, host: { historyDeletionPending(runId: string): boolean }, run: RunRecord): { workflow: WorkflowDef; input: StartRunInput } {
    const delegation = delegationStateSchema.safeParse(run.delegation);
    if (host.historyDeletionPending(run.id) || run.status !== 'queued' || !delegation.success || delegation.data.role !== 'worker' ||
        delegation.data.workspace.ownerRunId !== run.id || delegation.data.destroy) {
      throw new DelegationPolicyError('incompatible_state', 'Run is not an executable owned creation');
    }
    // Accepted permissions are private immutable evidence. Only explicit internal
    // primitive records retain the public-definition compatibility path.
    const grants = workerIdentity(context.store, context.repoRoot, run.id, undefined, context.home)?.grants
      ?? run.workflowDef?.steps.find(step => step.id === QUICK_TASK_WORKFLOW.steps[0]!.id);
    return {
      workflow: ownedWorkflow(run, context.store.readWorkerIdentity(run.id)) ?? { ...QUICK_TASK_WORKFLOW, steps: [{ ...QUICK_TASK_WORKFLOW.steps[0]!,
        ...(grants?.allowedTools === undefined ? {} : { allowedTools: [...grants.allowedTools] }),
        ...(grants?.bashAllowlist === undefined ? {} : { bashAllowlist: [...grants.bashAllowlist] }),
      }] },
      input: { ...queuedRecoveryInput(run), worktree: true },
    };
  }

function acceptedImages(input: StartRunInput): PastedContent[] | undefined { return input.images; }
function acceptedTask(input: StartRunInput): string { return input.task; }
/** A provider-error retry that starts the first session carries what that step was asked
 *  (hearsay-tools/squawk#3337): the held workflow step's own prompt, rendered with the task. */
function retriedTask(run: RunRecord): string {
  const step = run.workflowDef?.steps.find(candidate => candidate.id === run.workflowResumeStepId);
  return step ? applyTemplate(step.prompt ?? '{{task}}', run.task) : run.task;
}
function acceptedSkillHint(workflow: WorkflowDef): string | undefined {
  return workflow.steps.find(candidate => stepKind(candidate) === 'agent' && candidate.skill)?.skill?.trim();
}

function stepRunner(step: WorkflowStepDef, taskBackend: RunnerId): RunnerId { return step.runner ?? taskBackend; }
function stepPrompt(step: WorkflowStepDef, source: SourceInput): string { return applyTemplate(step.prompt ?? '{{task}}', sourceInput(source).task); }
function stepSkill(step: WorkflowStepDef): string | undefined { return step.skill; }

export function namingTask(run: RunRecord): string { return run.task; }
export function namingSkillHint(workflow: WorkflowDef | null): string | undefined {
  return workflow?.steps.find(candidate => stepKind(candidate) === 'agent' && candidate.skill)?.skill?.trim();
}

function queuedMessageSource(run: RunRecord | undefined): QueuedMessage[] | undefined { return run?.queuedMessages; }
function taskAttachmentUrls(run: RunRecord | undefined): string[] | undefined { return run?.taskImages; }

function continuedSkill(step: WorkflowStepDef | undefined): string | undefined { return step?.skill; }
function continuedCheckpoint(run: RunRecord | undefined): RunRecord['continuationMessage'] { return run?.continuationMessage; }
function continuedPrompt(run: RunRecord, fallback: string): string { return run.continuationMessage?.text ?? fallback; }
function rejoinContinuationLine(held: Omit<PendingContinuation, 'lineJoinedAt'>): PendingContinuation { return { ...held, lineJoinedAt: Date.now() }; }

function printSessionTransport(sessionStep: RunRecord['steps'][number]): boolean { return sessionStep.sessionTransport === 'cursor-print'; }

function inputWorktree(source: SourceInput): boolean | undefined { return sourceInput(source).worktree; }
function executionPayload<T extends object>(runId: string, workflow: WorkflowDef, fields: T) { return { runId, workflow, ...fields }; }
function queuedPayload(workflow: WorkflowDef, input: StartRunInput) { return { workflow, input }; }
function resumedPayload(workflow: WorkflowDef, startAt: number, input: StartRunInput) { return { workflow, startAt, input }; }
function afterStepPayload<T extends object>(index: number, step: WorkflowStepDef, nextStep: WorkflowStepDef | undefined, fields: T) { return { index, step, nextStep, ...fields }; }
function sessionPayload<T extends object>(step: WorkflowStepDef, fields: T) { return { step, ...fields }; }
function sessionWaitPayload<T extends object>(stepId: string, nextStep: WorkflowStepDef | undefined, fields: T) { return { stepId, nextStep, ...fields }; }
function acceptedWorkflowFields(workflow: WorkflowDef): Pick<RunRecord, 'workflowDef'> { return { workflowDef: workflow }; }
function workflowName(workflow: WorkflowDef): string { return workflow.name; }
function workflowLength(workflow: WorkflowDef): number { return workflow.steps.length; }
function workflowStep(workflow: WorkflowDef, index: number): WorkflowStepDef | undefined { return workflow.steps[index]; }
function workflowSlice(workflow: WorkflowDef, start: number, end: number): WorkflowStepDef[] { return workflow.steps.slice(start, end); }
function workflowChainNote(workflow: WorkflowDef, index: number): string | undefined { return chainStepNote(workflow.steps, index); }

function jobInput(job: PendingJob): StartRunInput { return job.input; }
function jobWorkflow(job: PendingJob): WorkflowDef { return job.workflow; }
function resumedJob(run: RunRecord, job: PendingJob): PendingJob { return { ...job, startAt: queuedStartAt(run, job.workflow) }; }
function storedWorkflow(run: RunRecord): WorkflowDef | undefined { return run.workflowDef; }
function interruptedIndex(run: RunRecord, stepId: string | undefined): number { return run.workflowDef?.steps.findIndex(step => step.id === stepId) ?? -1; }
function interruptedDefinition(run: RunRecord, index: number): WorkflowStepDef | undefined { return index >= 0 ? run.workflowDef?.steps[index] : undefined; }
function heldAccount(run: RunRecord, runner: RunnerId, readHolds: () => Parameters<typeof accountHeldFor>[1]): boolean {
  const selected = { ...run, runner };
  return accountHeldFor(selected, readHolds(), runner);
}
function resumedStep(run: RunRecord, waitingIndex: () => number): WorkflowStepDef | undefined {
  return run.workflowDef?.steps[waitingIndex()];
}

function executionInput(execution: Execution): LaunchSource { return execution.input; }
function executionWorkflow(execution: Execution): WorkflowDef { return execution.workflow; }
function baseBranch(handle: LaunchConfig): string | undefined { return configValue(handle).baseBranch; }
function retryIndex(workflow: WorkflowDef, step: WorkflowStepDef): number { return workflow.steps.findIndex(candidate => candidate.id === step.onFail?.retry); }
function requeueJob(workflow: WorkflowDef, source: SourceInput, startAt: number | undefined): PendingJob { return { workflow, input: sourceInput(source), startAt }; }
type SourceInput = StartRunInput | LaunchSource;
function sourceInput(source: SourceInput): StartRunInput { return source instanceof InputToken ? inputValue(source) : source; }

function recordedRunner(run: RunRecord): RunnerId | undefined { return run.runner; }
function defaultRunner(config: LaunchConfig): RunnerId { return configValue(config).defaultRunner; }
function runnerless(store: Pick<RunStore, 'getRun'>, id: string): boolean { return store.getRun(id)?.runner === undefined; }
function heldFor(...args: Parameters<typeof accountHeldFor>): boolean { return accountHeldFor(...args); }
function accountFor(...args: Parameters<typeof executionAccount>): ReturnType<typeof executionAccount> { return executionAccount(...args); }
