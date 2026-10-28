import type { RunnerId } from '../../core/agent-runner.ts';
import { createRunner } from '../../core/runner-factory.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../../core/agent-model-policy.ts';
import { ModelIdentityError, formatModelIdentity, normalizeModelForBackend } from '../../core/model-identity.ts';
import { readAgentModelProvider } from '../../agent-config/models.ts';
import type { WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import { parseDelegationEffort } from '../../delegation/effort.ts';
import { DelegationPolicyError } from '../../delegation/policy.ts';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import type { WorkflowStepDef } from '../types.ts';
import type { StartRunInput, StepModel } from './types.ts';

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
 * Apply the SAME canonical-identity gate the first spawn applies (#405, review M1).
 * A follow-up may switch both runner and model (#401), so without this the record keeps
 * asserting the identity the run STARTED with while a different model serves the turn —
 * the exact defect that PR existed to remove — and the raw record string reaches the CLI
 * in the un-normalised wire form the first step already converted away (`anthropic/opus`
 * instead of `opus`). Fail loud here too rather than let the backend pick a default.
 */
export async function continuationModel(
  store: RunStore,
  repoRoot: string,
  runId: string,
  state: ActiveRun,
  record: RunRecord | undefined,
  toolsStep: WorkflowStepDef | undefined,
  stepIdentity: WorkerStepIdentity | undefined,
  backend: RunnerId,
): Promise<{ backendModel: string | undefined } | string> {
  // The owning step's authored `model` wins over the run-level pin, exactly as the first
  // spawn resolved `step.model ?? input.model` (#464 review): a catalog worker keeps the
  // parent's inherited model at run level, so reading only the record silently switched a
  // step authored for another model on Continue.
  try {
    const normalized = await resolveLaunchModel(
      backend,
      agentModelsLocked(repoRoot) ? undefined : stepIdentity ? stepIdentity.model : toolsStep?.model ?? record?.model,
      state.cwd,
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
export function continuationEffort(
  repoRoot: string,
  record: RunRecord | undefined,
  toolsStep: WorkflowStepDef | undefined,
  stepIdentity: WorkerStepIdentity | undefined,
): { effort: string | undefined } | string {
  try {
    const modelsLocked = agentModelsLocked(repoRoot);
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
 *  playbook. A resumed Cursor session keeps the transport it was opened with. */
export function continuationRunner(
  backend: RunnerId,
  sessionId: string | undefined,
  owningStep: RunRecord['steps'][number] | undefined,
): { runner: ReturnType<typeof createRunner>; skipSkillOnResume: boolean } {
  const sessionTransport = sessionId !== undefined && backend === 'cursor'
    ? owningStep?.sessionTransport ?? 'cursor-acp'
    : undefined;
  const runner = createRunner(backend, sessionTransport ? { sessionTransport } : {});
  return { runner, skipSkillOnResume: sessionId !== undefined && runner.systemPromptOnResume === 'in-thread' };
}

/**
 * Canonical provider/model identity (#405) — the normalised `provider/model`
 * the task ran with, persisted for cost attribution / reproducible replay
 * beside the free-text `model`. Best-effort here (a per-step `runner`/`model`
 * can still override it); the authoritative fail-loud gate is at spawn.
 */
export async function taskModelIdentity(repoRoot: string, taskBackend: RunnerId, input: StartRunInput): Promise<string | undefined> {
  try {
    const normalized = await resolveLaunchModel(
      taskBackend,
      agentModelsLocked(repoRoot) ? undefined : input.model,
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
 * `provider/model` and back to the backend's own wire form via the ONE shared mapper (#405).
 * Fail-loud: an unresolvable model (e.g. a bare id on opencode) returns the step error
 * instead of letting the backend silently substitute its default.
 */
export async function stepModel(
  store: RunStore,
  repoRoot: string,
  runId: string,
  state: ActiveRun,
  step: WorkflowStepDef,
  input: StartRunInput,
  stepBackend: RunnerId,
  stepIdentity: WorkerStepIdentity | undefined,
): Promise<StepModel | string> {
  try {
    const modelsLocked = agentModelsLocked(repoRoot);
    if (modelsLocked && step.effort?.trim()) return AGENT_MODELS_LOCKED_ERROR;
    const effectiveEffort = stepEffort(store, runId, step, input, stepIdentity, modelsLocked);
    const normalized = await resolveLaunchModel(
      stepBackend,
      modelsLocked ? undefined : stepIdentity ? stepIdentity.model : step.model ?? input.model,
      state.cwd,
    );
    // Persist the identity of what ACTUALLY runs (#405, review M1). The run-start echo
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
export function stepEffort(
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
