/**
 * The option resolution behind `POST /runs` (hearsay-tools/cezarion#1635).
 *
 * Each helper settles one option group of a start request and answers either its value or a
 * `StartRunRefusal` — the status and `{ error }` text the route sends. The handler in
 * `server.ts` calls them in the order a body meets its refusals, so the first refusal a body
 * hits is the one it gets. None of them touches a route or a Hono context: the route stays in
 * its family chain, which is what keeps it in `AppType`.
 */
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import type { ProviderId } from '../core/provider-auth.ts';
import { clientRequestHash, type ClientRequestPayload } from '../runs/client-request.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { toPastedContent, type RunManager } from '../workflows/run.ts';
import type { StartRunInput } from '../workflows/run/types.ts';
import { plannedWorkflow, stepsIssue, type WorkflowDef, type WorkflowStepDef } from '../workflows/types.ts';
import type { WorkspaceProject } from '../workspace/config.ts';
import { taskWebhooks } from '../workspace/webhooks.ts';
import { providersRequiredByWorkflow } from './provider-action-gate.ts';

/** A refusal `POST /runs` answers as `{ error }` with this status. */
export interface StartRunRefusal {
  error: string;
  status: 400 | 404 | 409;
}

/** The id a retry carries and the fingerprint of its payload (#504). */
export interface ClientRequest {
  id: string;
  hash: string;
}

export const NO_WEBHOOK_ERROR =
  'this project has no task webhook — add a webhook with Task notifications on in Settings → General → Webhooks, or start without notify';

const REQUEST_ID_CONFLICT_ERROR = 'request id payload conflict';

/** The provider gate: the message that refuses a start, or `null` when every provider is usable. */
type ProviderActionError = (required: readonly ProviderId[]) => Promise<string | null>;

/** Resolves an account id for a provider; a dangling id comes back as an `{ error }`. */
type ProfileResolver = (provider: ProviderId, profileId?: string) => Promise<{ profile: unknown } | { error: string }>;

/** The project registry entry for a project id. */
type RegistryLookup = (projectId: string) => Promise<WorkspaceProject | undefined>;

/** The options of a start request that become the run's input. */
type StartRunOptions = Omit<StartRunInput, 'images' | 'stackedImages' | 'automation' | 'automationTrigger'> & {
  images?: Parameters<typeof toPastedContent>[0][] | undefined;
};

/** The request id and payload hash of an idempotent start; none when the body carries no id. */
export function clientRequestOf(body: ClientRequestPayload & { clientRequestId?: string | undefined }): ClientRequest | undefined {
  return body.clientRequestId ? { id: body.clientRequestId, hash: clientRequestHash(body) } : undefined;
}

/**
 * A retry only retrieves a persisted result: mutable start prerequisites (workflow, provider,
 * account and model policy) must not invalidate an already accepted request. The same payload
 * answers the existing run; a different one is a conflict; no match lets the start go on.
 */
export function replayedRun(
  store: Pick<RunStore, 'findRunByClientRequestId'>,
  request: ClientRequest,
): { run: RunRecord } | StartRunRefusal | undefined {
  const existing = store.findRunByClientRequestId(request.id);
  if (!existing) return undefined;
  if (existing.clientRequestHash !== request.hash) return { error: REQUEST_ID_CONFLICT_ERROR, status: 409 };
  return { run: existing };
}

/** A model or effort pin is refused while the project's models are locked. */
export function modelLockRefusal(
  repoRoot: string,
  pins: { model?: string | undefined; effort?: string | undefined },
): StartRunRefusal | undefined {
  if (!agentModelsLocked(repoRoot)) return undefined;
  return pins.model?.trim() || pins.effort?.trim() ? { error: AGENT_MODELS_LOCKED_ERROR, status: 409 } : undefined;
}

/** The workflow a start runs: an inline chain (spec 008) or a saved workflow found by name. */
export async function resolveStartWorkflow(
  repoRoot: string,
  choice: { workflow?: string | undefined; steps?: WorkflowStepDef[] | undefined },
): Promise<{ workflow: WorkflowDef } | StartRunRefusal> {
  if (choice.steps) {
    // Inline chain: an approved plan runs as an ad-hoc workflow.
    const issue = stepsIssue(choice.steps);
    return issue ? { error: issue, status: 400 } : { workflow: plannedWorkflow(choice.steps) };
  }
  const { workflows } = await loadWorkflows(repoRoot);
  const workflow = workflows.find((w) => w.name === choice.workflow);
  return workflow ? { workflow } : { error: `unknown workflow: ${choice.workflow}`, status: 404 };
}

/** A start whose workflow needs a provider that is disabled or unavailable is refused. */
export async function providerGateRefusal(
  providerActionError: ProviderActionError,
  workflow: WorkflowDef,
  runner: RunnerId,
): Promise<StartRunRefusal | undefined> {
  const blocked = await providerActionError(providersRequiredByWorkflow(workflow, runner));
  return blocked ? { error: blocked, status: 409 } : undefined;
}

/**
 * A composer override names an account the user just picked, so a stale id (deleted since the
 * page loaded) is answered honestly instead of quietly running on the default — the opposite of
 * how RESOLUTION treats a dangling reference, and deliberately so: a run replaying a stored id
 * has no better answer than the default, a user does.
 */
export async function agentProfileRefusal(
  resolveProfile: ProfileResolver,
  runner: RunnerId,
  agentProfile: string | undefined,
): Promise<StartRunRefusal | undefined> {
  if (agentProfile === undefined) return undefined;
  const account = await resolveProfile(runner, agentProfile);
  return 'error' in account ? { error: account.error, status: 400 } : undefined;
}

/**
 * Task webhook (#589): an explicit `true` on a project with no webhook is refused, so a bot
 * learns in one round trip. `cez task start`'s implicit default never sends it there.
 */
export async function notifyRefusal(
  notify: boolean | undefined,
  projectId: string,
  projectRegistryEntry: RegistryLookup,
): Promise<StartRunRefusal | undefined> {
  if (notify !== true) return undefined;
  const entry = await projectRegistryEntry(projectId).catch(() => undefined);
  return taskWebhooks(entry).length === 0 ? { error: NO_WEBHOOK_ERROR, status: 400 } : undefined;
}

/** The input the manager starts the run with: the start options, attachments converted. */
export function startRunInput(body: StartRunOptions): StartRunInput {
  const images = body.images?.map(toPastedContent);
  return {
    task: body.task,
    notify: body.notify,
    model: body.model,
    effort: body.effort,
    runner: body.runner,
    agentProfile: body.agentProfile,
    images,
    systemPrompt: body.systemPrompt,
    worktree: body.worktree,
    autonomous: body.autonomous,
    archiveWhenDone: body.archiveWhenDone,
    autoMergePr: body.autoMergePr,
  };
}

/**
 * Starts the run. A retry that carries an id starts through the manager's own lookup and create,
 * so a concurrent first request that missed the early lookup still creates exactly one run
 * (#504): 201 for the run it created, 200 for the one it found, a conflict for another payload.
 */
export function launchRun(
  manager: Pick<RunManager, 'startRun' | 'startRunIdempotent'>,
  workflow: WorkflowDef,
  input: StartRunInput,
  clientRequest: ClientRequest | undefined,
): { run: RunRecord; status: 200 | 201 } | StartRunRefusal {
  if (!clientRequest) return { run: manager.startRun(workflow, input), status: 201 };
  const result = manager.startRunIdempotent(workflow, input, clientRequest);
  if ('conflict' in result) return { error: REQUEST_ID_CONFLICT_ERROR, status: 409 };
  return { run: result.run, status: result.created ? 201 : 200 };
}
