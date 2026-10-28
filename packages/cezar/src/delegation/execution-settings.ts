import type { RunnerId } from '../core/agent-runner.ts';
import type { ActiveRun } from '../workflows/active-run.ts';
import type { DelegationExecutionSettings } from '../workflows/run/types.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import { buildChildEnv } from '../core/agent-env.ts';
import { readAgentModelSettings } from '../agent-config/models.ts';
import { formatModelIdentity, normalizeModelForBackend } from '../core/model-identity.ts';
import { modelConflictsWithRunner } from '../core/model-presets.ts';
import { resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { boundWorkerAccountEnv, captureWorkerAccount, type WorkerAccountBinding } from './execution-identity.ts';
import { parseDelegationEffort } from './effort.ts';
import { DelegationPolicyError } from './policy.ts';

type ExecutionSelection = { backend?: RunnerId | undefined; model?: string | undefined; effort?: string | undefined; agentProfile?: string };

export function delegationExecutionSettings(state: Pick<ActiveRun, 'session' | 'delegationSettings'> | undefined): DelegationExecutionSettings {
  if (!state?.session?.open || !state.delegationSettings) throw new DelegationPolicyError('incompatible_state', 'Parent session settings unavailable');
  return structuredClone(state.delegationSettings);
}

export async function selectDelegationExecutionSettings(repoRoot: string, parent: DelegationExecutionSettings, selection: { backend?: RunnerId | undefined; model?: string | undefined; effort?: string | undefined; agentProfile?: string }, validateModel?: (settings: DelegationExecutionSettings) => Promise<void>): Promise<DelegationExecutionSettings> {
  const runner = selection.backend ?? parent.runner;
  const sameBackend = runner === parent.runner;
  try {
    const { effortPin, locked } = refuseModelLock(repoRoot, parent, selection, sameBackend);
    const { accountBinding, env } = await bindAccount(repoRoot, parent, selection, runner, sameBackend);
    return await chooseModel(repoRoot, parent, selection, runner, sameBackend, effortPin, locked, accountBinding, env, validateModel);
  } catch (error) {
    if (error instanceof DelegationPolicyError) throw error;
    throw new DelegationPolicyError('invalid_input', error instanceof Error ? error.message : 'Worker execution selection is unavailable');
  }
}

function refuseModelLock(repoRoot: string, parent: DelegationExecutionSettings, selection: ExecutionSelection, sameBackend: boolean) {
  const effortPin = parseDelegationEffort(selection.effort);
  const locked = agentModelsLocked(repoRoot);
  if (locked && (selection.model !== undefined || effortPin !== undefined || (sameBackend && (parent.model !== undefined || parent.effort !== undefined)))) {
    throw new Error(AGENT_MODELS_LOCKED_ERROR);
  }
  return { effortPin, locked };
}

async function bindAccount(repoRoot: string, parent: DelegationExecutionSettings, selection: ExecutionSelection, runner: RunnerId, sameBackend: boolean) {
  let accountBinding = parent.accountBinding;
  let env = buildChildEnv({ backend: runner });
  if (!sameBackend || selection.agentProfile !== undefined) {
    const resolved = await resolveProfileEnvForRoot(repoRoot, runner, selection.agentProfile);
    if (selection.agentProfile !== undefined && resolved.profile.id !== selection.agentProfile) {
      throw new Error(`Unknown ${runner} account "${selection.agentProfile}"`);
    }
    env = buildChildEnv({ backend: runner, extraEnv: resolved.env });
    accountBinding = captureWorkerAccount(resolved.profile, env);
  }
  if (!accountBinding || accountBinding.provider !== runner) throw new Error('Accepted worker account identity is unavailable');
  env = { ...env, ...boundWorkerAccountEnv(accountBinding, env) };
  return { accountBinding, env };
}

async function chooseModel(repoRoot: string, parent: DelegationExecutionSettings, selection: ExecutionSelection, runner: RunnerId, sameBackend: boolean, effortPin: string | undefined, locked: boolean, accountBinding: WorkerAccountBinding, env: NodeJS.ProcessEnv, validateModel?: (settings: DelegationExecutionSettings) => Promise<void>): Promise<DelegationExecutionSettings> {
  const native = await readAgentModelSettings(runner, repoRoot, env);
  const chosen = selection.model ?? (sameBackend ? parent.model : locked ? undefined : native.model);
  const normalized = normalizeModelForBackend(runner, chosen, { configuredProvider: native.provider });
  const settings = { ...parent, runner, model: normalized?.backendModel, modelIdentity: normalized ? formatModelIdentity(normalized.identity) : undefined, effort: effortPin ?? (sameBackend ? parent.effort : undefined),
    agentProfile: accountBinding.profileId, accountBinding };
  // A populated catalog gives a useful choice list before the legacy preset fallback rejects.
  await validateModel?.(settings);
  if (chosen && modelConflictsWithRunner(chosen, runner)) throw new Error('Model is incompatible with the selected backend');
  return settings;
}
