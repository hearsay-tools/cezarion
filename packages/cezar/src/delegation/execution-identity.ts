import { createHash } from 'node:crypto';
import { workerInputRecipeSchema, type WorkerInputRecipe } from '@open-mercato/cezar-contract/delegation';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { profileEnv, supportsProfiles } from '../core/agent-profiles.ts';
import { namedAccountUnavailable, type ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { agentHomePaths, claudeStateFilePath } from '../paths.ts';
import { workflowDefSchema, QUICK_TASK_WORKFLOW, stepKind, type WorkflowDef, type WorkflowStepDef } from '../workflows/types.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import { buildChildEnv } from '../core/agent-env.ts';

/**
 * Providers whose DEFAULT account binds no home: it spawns bare and follows the host env, as it did
 * before pi and omp carried accounts (hearsay-tools/cezarion#1283). Pinning a home requires the
 * folder to exist at launch, and a machine where the agent has never run has none, so pinning would
 * turn a working zero-config worker into "identity is unavailable". Evidence accepted before #1283
 * has this same shape. Named accounts always pin their folder.
 */
const HOMELESS_DEFAULT_PROVIDERS: ReadonlySet<string> = new Set(['pi', 'omp']);

const absolutePathSchema = z.string().min(1).max(4096).refine(isAbsolute).refine(path => !/[\u0000-\u001f\u007f]/.test(path));

/** Internal durable evidence, never a public environment override or credential snapshot. */
export const workerAccountBindingSchema = z.object({
  provider: z.enum(['claude', 'codex', 'opencode', 'pi', 'cursor', 'omp']),
  profileId: z.string().min(1).max(64),
  homePath: absolutePathSchema.optional(),
  // Identical config directories can have different state/login files depending on invocation.
  claudeLayout: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('native'), statePath: absolutePathSchema }).strict(),
    z.object({ kind: z.literal('relocated') }).strict(),
  ]).optional(),
}).strict().refine(binding => binding.homePath !== undefined
  ? supportsProfiles(binding.provider)
  : binding.profileId === 'default' && (!supportsProfiles(binding.provider) || HOMELESS_DEFAULT_PROVIDERS.has(binding.provider)))
  .refine(binding => binding.provider === 'claude'
    ? binding.claudeLayout !== undefined && (binding.claudeLayout.kind !== 'native' || binding.profileId === 'default')
    : binding.claudeLayout === undefined);
export type WorkerAccountBinding = z.infer<typeof workerAccountBindingSchema>;

// Required private evidence; absent properties and explicit empty grants differ.
const workerGrantsSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  bashAllowlist: z.array(z.string()).optional(),
}).strict();
/** What one agent step of an owned worker may run under: pinned at acceptance, read at every launch. */
const workerStepIdentityFieldsSchema = z.object({
  account: workerAccountBindingSchema,
  grants: workerGrantsSchema,
  model: z.string().min(1).max(512).optional(),
  effort: z.string().min(1).max(128).optional(),
});
export type WorkerStepIdentity = z.infer<typeof workerStepIdentityFieldsSchema>;

export const acceptedWorkerIdentitySchema = workerStepIdentityFieldsSchema.extend({
  kind: z.literal('accepted'),
  /** Binds new input recipes; absence retains compatibility with pre-context identities. */
  contextHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Binds the public `workflowDef` a catalog worker runs (#451); absent means the built-in quick-task. */
  workflowHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /**
   * One entry per agent step of the accepted chain (#452), so a codex step and a claude step
   * each run under their own account, model, effort and grants. The run-level fields above
   * hold the FIRST agent step's values: evidence written before this list existed has only
   * those, and `workerStepIdentity` answers every step from them.
   */
  steps: z.array(workerStepIdentityFieldsSchema.extend({ stepId: z.string().min(1) }).strict()).min(1).optional(),
}).strict();
export type AcceptedWorkerIdentity = z.infer<typeof acceptedWorkerIdentitySchema>;

/** The identity one agent step runs under. Explicit entries are authority; a legacy identity answers with its run-level view. */
export function workerStepIdentity(identity: AcceptedWorkerIdentity, stepId: string): WorkerStepIdentity {
  if (identity.steps === undefined) {
    return { account: identity.account, grants: identity.grants,
      ...(identity.model === undefined ? {} : { model: identity.model }), ...(identity.effort === undefined ? {} : { effort: identity.effort }) };
  }
  const entry = identity.steps.find(step => step.stepId === stepId);
  if (!entry) throw new WorkerIdentityError(`Accepted worker step identity is unavailable for "${stepId}"`);
  const { stepId: _stepId, ...fields } = entry;
  return fields;
}
export const workerExecutionIdentitySchema = z.union([
  acceptedWorkerIdentitySchema,
  // Only explicitly written by the internal owned-creation primitive. Absence never means legacy.
  z.object({ kind: z.literal('internal'), workflowHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
]);
export type WorkerExecutionIdentity = z.infer<typeof workerExecutionIdentitySchema>;
export class WorkerIdentityError extends Error {}

export function captureWorkerAccount(profile: ResolvedAgentProfile, env: NodeJS.ProcessEnv = process.env): WorkerAccountBinding | undefined {
  if (!supportsProfiles(profile.provider) || (profile.isDefault && HOMELESS_DEFAULT_PROVIDERS.has(profile.provider))) {
    return { provider: profile.provider, profileId: 'default' };
  }
  // Bind an existing symlink to its actual home. A native first-run home may not exist yet.
  const claudeHome = agentHomePaths(env).claude;
  let homePath = profile.provider === 'claude' ? claudeHome : profile.path;
  try {
    // A named omp account is selected by its profile entry's NAME, and the entry may be a symlink
    // omp follows itself: resolving it would leave a path that names no profile. Pin the parent.
    homePath = isOmpProfileBinding(profile.provider, profile.id)
      ? join(realpathSync(dirname(homePath)), basename(homePath))
      : realpathSync(homePath);
  } catch { /* The owned consumer still requires it to exist. */ }
  const claudeLayout = profile.provider !== 'claude' ? undefined
    : env.CLAUDE_CONFIG_DIR?.trim() ? { kind: 'relocated' as const }
    : { kind: 'native' as const, statePath: claudeStateFilePath(claudeHome, env) };
  const parsed = workerAccountBindingSchema.safeParse({ provider: profile.provider, profileId: profile.id, homePath,
    ...(claudeLayout === undefined ? {} : { claudeLayout }) });
  return parsed.success ? parsed.data : undefined;
}

export function boundWorkerAccountEnv(binding: WorkerAccountBinding, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (binding.homePath === undefined) return {};
  const ompProfile = isOmpProfileBinding(binding.provider, binding.profileId);
  const pinned = ompProfile ? dirname(binding.homePath) : binding.homePath;
  try {
    if (!statSync(binding.homePath).isDirectory() || realpathSync(pinned) !== pinned) throw new Error();
  } catch { throw new WorkerIdentityError('Accepted worker account identity is unavailable'); }
  if (binding.provider === 'omp') {
    // The discovered omp account is spawned bare, so it keeps whatever profile the host selects.
    if (!ompProfile) return {};
    const selected = profileEnv('omp', binding.homePath);
    if (Object.keys(selected).length === 0) throw new WorkerIdentityError('Accepted omp account names no omp profile');
    // omp resolves the name under the root it computes from the CHILD's HOME and PI_CONFIG_DIR,
    // which may have changed since acceptance; a moved root would select another profile.
    const unavailable = namedAccountUnavailable('omp', binding.homePath, env);
    if (unavailable !== null) throw new WorkerIdentityError(unavailable);
    return selected;
  }
  if (binding.claudeLayout?.kind === 'native') {
    const nativeHome = agentHomePaths(env).claude;
    try {
      if (env.CLAUDE_CONFIG_DIR?.trim() || claudeStateFilePath(nativeHome, env) !== binding.claudeLayout.statePath ||
          realpathSync(nativeHome) !== binding.homePath) throw new Error();
    } catch { throw new WorkerIdentityError('Accepted native Claude account layout is unavailable'); }
    return {};
  }
  return profileEnv(binding.provider, binding.homePath);
}

/** A named omp account: an omp profile, selected by name rather than by folder. */
function isOmpProfileBinding(provider: string, profileId: string): boolean {
  return provider === 'omp' && profileId !== 'default';
}

/** Canonical schema order makes equivalent persisted object ordering immaterial. */
export function workerContextHash(context: WorkerInputRecipe): string {
  return createHash('sha256').update(JSON.stringify(workerInputRecipeSchema.parse(context))).digest('hex');
}

/** Canonical schema order, as for the context recipe: key order in the persisted record is immaterial. */
export function workerWorkflowHash(workflow: WorkflowDef): string {
  return createHash('sha256').update(JSON.stringify(workflowDefSchema.parse(workflow))).digest('hex');
}

/**
 * Resolve this step’s account environment from agent-accounts.json and record its id. Ordinary
 * steps prefer the recorded account, then a matching run override, then project selection and
 * default. Keep account and session ids paired; owned workers use pinned identity.
 */
/**
 * Ordinary runs retain mutable discovery; owned runs require explicit durable evidence. With a
 * `stepId`, the step's own pinned entry is checked too (#452): its account must still be
 * available and its model/effort must clear the lock, exactly as the run-level fields must.
 */
export function workerIdentity(store: RunStore, repoRoot: string, runId: string, stepId?: string) {
  const run = store.getRun(runId);
  if (run?.delegation?.role !== 'worker') return undefined;
  const identity = store.readWorkerIdentity(runId);
  if (!identity) throw new WorkerIdentityError('Worker execution identity evidence is unavailable');
  if (identity.kind === 'internal') return undefined;
  validateWorkerIdentity(repoRoot, run, identity, run.delegation.context);
  // Availability is checked for the account about to be USED: the selected step's entry when
  // there is one, and the single run-level account only for a legacy identity that has no
  // per-step list. A per-step identity checked without a step (the evidence-only calls in
  // `execute`, `runContinuation` and `ownedJob`) binds nothing here — the launch resolves its
  // step and binds that account — so a first-step login removed after its step finished never
  // stops a later step, a Continue or a recovery whose own account is intact (#465).
  const step = stepId === undefined ? undefined : workerStepIdentity(identity, stepId);
  if (step && agentModelsLocked(repoRoot) && (step.model !== undefined || step.effort !== undefined)) {
    throw new WorkerIdentityError(`Accepted worker settings cannot run: ${AGENT_MODELS_LOCKED_ERROR}`);
  }
  const account = step?.account ?? (identity.steps === undefined ? identity.account : undefined);
  if (account) boundWorkerAccountEnv(account, buildChildEnv({ backend: account.provider }));
  return identity;
}

function validateWorkerIdentity(repoRoot: string, run: RunRecord, identity: AcceptedWorkerIdentity, context: WorkerInputRecipe | undefined): void {
  if (identity.contextHash !== undefined && (!context || workerContextHash(context) !== identity.contextHash)) {
    throw new WorkerIdentityError('Accepted worker context recipe is unavailable or changed');
  }
  ownedWorkflow(run, identity);
  if (agentModelsLocked(repoRoot) && (identity.model !== undefined || identity.effort !== undefined)) {
    throw new WorkerIdentityError(`Accepted worker settings cannot run: ${AGENT_MODELS_LOCKED_ERROR}`);
  }
  if (run.runner !== identity.account.provider || run.agentProfile !== identity.account.profileId ||
      run.model !== identity.model || run.effort !== identity.effort) {
    throw new WorkerIdentityError('Accepted worker execution identity does not match its run');
  }
}

/**
 * The steps a continuation may extend. An accepted worker's public `workflowDef` is authority
 * only while its identity binds it: a catalog chain through `ownedWorkflow`, and the default
 * quick-task from the built-in constant, exactly the definition `ownedJob` launches — a salvaged
 * or edited public record never picks which pinned identity a turn runs under.
 */
export function continuationDefSteps(store: RunStore, record: RunRecord | undefined): WorkflowStepDef[] | undefined {
  if (record?.delegation?.role === 'worker') {
    const identity = store.readWorkerIdentity(record.id);
    if (identity?.kind === 'accepted') return (ownedWorkflow(record, identity) ?? QUICK_TASK_WORKFLOW).steps;
  }
  return record?.workflowDef?.steps;
}

/**
 * The definition step a continuation extends: the one owning the resumed session, else the
 * chain's last agent step — a synthetic `continue-N` owner and a fresh-session continuation
 * both extend the run's tail. Shared by `continueRun` (which identity to hold the override
 * against) and `runContinuation` (which tools, model, effort and account the turn gets).
 */
export function continuationDefStep(store: RunStore, record: RunRecord | undefined, sessionId: string | undefined): WorkflowStepDef | undefined {
  const defSteps = continuationDefSteps(store, record);
  if (defSteps === undefined) return undefined;
  const owningStep = sessionId === undefined ? undefined : record?.steps.find((s) => s.sessionId === sessionId);
  if (sessionId !== undefined && owningStep === undefined) return undefined;
  const ciSource = defSteps.find(step => step.id === record?.workflowResumeStepId && stepKind(step) === 'agent');
  if (ciSource && record?.steps.find(step => step.id === ciSource.id)?.status === 'failed') return ciSource;
  return defSteps.find((s) => s.id === owningStep?.id) ?? [...defSteps].reverse().find((s) => stepKind(s) === 'agent');
}

/**
 * The catalog chain an owned worker runs (#451), or undefined for the built-in quick-task.
 * The public `workflowDef` is mutable state, so it is authority only while the private
 * identity's hash binds it — the same shape as the context recipe. A tampered or lost
 * definition refuses execution instead of quietly running quick-task or the edit.
 */
export function ownedWorkflow(run: RunRecord, identity: WorkerExecutionIdentity | undefined): WorkflowDef | undefined {
  if (identity?.workflowHash === undefined) return undefined;
  if (!run.workflowDef || workerWorkflowHash(run.workflowDef) !== identity.workflowHash) {
    throw new WorkerIdentityError('Accepted worker workflow definition is unavailable or changed');
  }
  return run.workflowDef;
}
