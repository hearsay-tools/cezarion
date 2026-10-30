import type { DelegationProvisioner } from '../../delegation/provision.ts';
import type { RunnerId } from '../../core/agent-runner.ts';
import { buildChildEnv } from '../../core/agent-env.ts';
import { provisionArtifactDirectory } from '../../artifacts/lifecycle.ts';
import { handoffPath, refreshHandoffRecords } from '../../handoff.ts';
import { agentTmpEnv } from '../../runs/agent-tmpdir.ts';
import { workerIdentity, workerStepIdentity, boundWorkerAccountEnv, captureWorkerAccount, WorkerIdentityError, type WorkerAccountBinding, type WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import { resolveProfileEnvForRoot } from '../../workspace/agent-profiles.ts';
import { resolveCapabilities } from '../../server/capabilities.ts';
import { automationCliCommand, automationsPrompt } from '../../automations/prompts.ts';
import { createAutomationSkill } from '../../automations/builtin-skill.ts';
import { registryEntry } from '../../runs/webhook.ts';
import { agentWebhooksPrompt, webhookCliCommand } from '../../webhooks/prompt.ts';
import { agentWebhooks } from '../../workspace/webhooks.ts';
import type { Skill } from '../../skills.ts';
import { buildSessionContext, formatSessionContextReport, type SessionContext } from '../../session-context.ts';
import type { ActiveRun } from '../active-run.ts';
import { leadingSlashSkillName } from './prompts.ts';
import type { RunModuleContext } from './types.ts';

type LaunchContext = Pick<RunModuleContext, 'store' | 'repoRoot' | 'dataDir'>;
type CockpitAddress = { origin: string; projectId: string } | undefined;

export interface LaunchSettingsHost {
  active: ReadonlyMap<string, ActiveRun>;
  setCockpit(address: CockpitAddress): void;
  delegationProvisioner(): DelegationProvisioner | undefined;
  setProvisioner(provisioner: DelegationProvisioner | undefined): void;
  historyDeletionPending(runId: string): boolean;
}

export interface LaunchContextHost {
  agentEnv(runId: string): Record<string, string>;
  workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined;
}

/** Env for the rolling handoff and artifacts.
 *
 *  `TMPDIR`/`TEMP`/`TMP` (#785) point at this run's own scratch directory
 *  instead of the machine-wide one every agent used to share. Created and
 *  write-probed here, on the last common path before a spawn, so an unusable
 *  temp directory throws `AgentTempDirError` at the caller rather than
 *  turning into empty command output inside a running agent. */
export function agentEnv({ dataDir }: LaunchContext, cockpit: CockpitAddress, runId: string): Record<string, string> {
  return {
    CEZ_ARTIFACTS_DIR: provisionArtifactDirectory(dataDir, runId),
    CEZ_HANDOFF_FILE: handoffPath(dataDir, runId),
    CEZ_TASK_ID: runId,
    // Shadow a path inherited from an older parent process.
    CEZ_TODOS_FILE: '',
    ...agentTmpEnv(dataDir, runId),
    ...(cockpit ? { CEZ_COCKPIT_URL: cockpit.origin, CEZ_PROJECT_ID: cockpit.projectId } : {}),
  };
}

export async function agentEnvForStep(
  { store, repoRoot }: LaunchContext,
  host: LaunchContextHost,
  runId: string,
  backend: RunnerId,
  options: { recordedProfileId?: string | undefined; stepId?: string | undefined } = {},
): Promise<{ env: Record<string, string>; profileId: string; accountBinding?: WorkerAccountBinding | undefined }> {
  // An owned worker binds the account its identity pinned for THIS step (#452); a legacy identity
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
  const resolved = await resolveProfileEnvForRoot(repoRoot, backend, profileId);
  const env = { ...host.agentEnv(runId), ...resolved.env };
  return {
    env,
    profileId: resolved.profile.id,
    accountBinding: process.env.CEZ_DELEGATION === '1' ? captureWorkerAccount(resolved.profile, buildChildEnv({ backend, extraEnv: env })) : undefined,
  };
}

/** Automations on AND a cockpit attached: the one predicate behind the prompt part and the built-in skill. */
export function automationsReachable(cockpit: CockpitAddress): boolean {
  return !!cockpit && resolveCapabilities().automations;
}

/** The built-in skills this manager may offer now; empty unless automations are reachable. */
export function builtinSkills(cockpit: CockpitAddress): Skill[] {
  return automationsReachable(cockpit) ? [createAutomationSkill(automationCliCommand())] : [];
}

/** The automations part of every session's system prompt, or nothing. */
export function automationsPart(cockpit: CockpitAddress): string | undefined {
  return automationsReachable(cockpit) ? automationsPrompt(automationCliCommand()) : undefined;
}

/** The "Project webhooks" part (#1576): the webhooks this project exposes to agents, read from
 *  the registry when a session starts. Needs a cockpit to send through; nothing exposed, or an
 *  unreadable registry, adds nothing. */
export async function agentWebhooksPart({ repoRoot }: LaunchContext, cockpit: CockpitAddress): Promise<string | undefined> {
  if (!cockpit) return undefined;
  const entry = await registryEntry(cockpit.projectId, repoRoot).catch(() => undefined);
  return agentWebhooksPrompt(webhookCliCommand(), agentWebhooks(entry));
}

/**
 * One launch's session-start context (hearsay-tools/cezarion#1584): the run's own handoff,
 * then the project's `context.yaml` rules for this recipient, read now and rendered once.
 * Every launch reports its outcome as one lifecycle line. Both launch sites — a fresh step
 * and `runContinuation` — come here; a live message never does. The prefix goes into the
 * opening message only, never the system prompt a worker inherits (#778).
 */
export function sessionContextFor({ store, repoRoot, dataDir }: LaunchContext, runId: string, state: ActiveRun, stepId: string, openingPrompt: string): SessionContext {
  const run = store.getRun(runId);
  const role = run?.delegation?.role === 'worker' ? 'worker' : 'parent';
  const handoff = handoffPath(dataDir, runId);
  refreshHandoffRecords(store, dataDir, runId);
  // A backend's own slash command only works at character zero (#676); a prefix would turn
  // it into plain text, so such a launch gets no context and keeps the read instruction.
  const context: SessionContext = leadingSlashSkillName(openingPrompt)
    ? { prefix: '', handoffInjected: false, reports: [{ id: 'session-context', status: 'skipped', sources: [], reason: 'the opening message is a slash command, which must stay at its start' }] }
    : buildSessionContext({
      projectRoot: repoRoot,
      cwd: state.cwd,
      role,
      handoffPath: handoff,
      variables: {
        ...(run ? { task: run.task, 'workflow.name': run.workflow } : {}),
        'run.id': runId,
        role,
        'step.id': stepId,
        'project.root': repoRoot,
        'worktree.root': state.cwd,
        'handoff.path': handoff,
      },
    });
  store.appendEvent(runId, { type: 'lifecycle', message: formatSessionContextReport(context.reports) });
  return context;
}

/** The pinned identity one agent step of an owned worker runs under; undefined for ordinary and internal runs. */
export function workerStep({ store, repoRoot }: LaunchContext, runId: string, stepId: string | undefined): WorkerStepIdentity | undefined {
  const identity = workerIdentity(store, repoRoot, runId, stepId);
  if (!identity) return undefined;
  return stepId === undefined
    ? { account: identity.account, grants: identity.grants, ...(identity.model === undefined ? {} : { model: identity.model }), ...(identity.effort === undefined ? {} : { effort: identity.effort }) }
    : workerStepIdentity(identity, stepId);
}

export function setCockpitAddress(host: LaunchSettingsHost, address: CockpitAddress): void {
  host.setCockpit(address ? { ...address } : undefined);
}

export function cockpitAddress(cockpit: CockpitAddress): CockpitAddress {
  return cockpit ? { ...cockpit } : undefined;
}

export function setDelegationProvisioner(host: LaunchSettingsHost, provisioner: DelegationProvisioner): () => void {
  host.setProvisioner(provisioner);
  return () => {
    if (host.delegationProvisioner() === provisioner) host.setProvisioner(undefined);
    for (const state of host.active.values()) { state.revokeDelegation?.(); state.revokeDelegation = undefined; }
  };
}

export function provisionSession(host: LaunchSettingsHost, runId: string, state: ActiveRun) {
  state.revokeDelegation?.(); state.revokeDelegation = undefined;
  if (host.historyDeletionPending(runId)) return;
  const session = host.delegationProvisioner()?.(runId);
  state.revokeDelegation = session?.revoke;
  return session;
}
