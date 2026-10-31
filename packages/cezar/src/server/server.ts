import { automationCreateSchema, automationUpdateSchema, automationCheckRequestSchema, automationLogQuerySchema } from '@open-mercato/cezar-contract/automation-requests';
import { providerConnectSchema, createAgentProfileSchema, openAgentAccountFileSchema, updateAgentProfileSchema, selectAgentProfileSchema, providerEnabledSchema, providerRetrySchema, providerRouteParamsSchema, agentProfileRouteParamsSchema } from '@open-mercato/cezar-contract/provider-requests';
import { planSchema, parseWorkflowSchema } from '@open-mercato/cezar-contract/workflow-requests';
import { uiStateBody } from '@open-mercato/cezar-contract/ui-state-requests';
import { queuedMessagePatchSchema, continueSchema, archiveSchema, openInSchema } from '@open-mercato/cezar-contract/run-requests';
import { queryValue, refreshQuery, waitQuery, modelDiscoveryQuerySchema, strictRefreshQuerySchema, browseQuerySchema, worktreeFilesQuerySchema } from '@open-mercato/cezar-contract/query-requests';
import { mergeNumberParams, prChangesParams, prChangesQuery, mergeBodySchema } from '@open-mercato/cezar-contract/github-requests';
import { gitCommitSchema, reclaimBodySchema, repoBranchSchema } from '@open-mercato/cezar-contract/repo-requests';
import { setConfigSchema, setAgentConfigSchema } from '@open-mercato/cezar-contract/config-requests';
import { saveWorkflowInputSchema as saveWorkflowSchema } from '@open-mercato/cezar-contract/workflows';
import { patchRunInputSchema as patchRunSchema, messageInputSchema as messageSchema } from '@open-mercato/cezar-contract/runs';
import { checkoutProjectInputSchema as checkoutSchema, registerProjectInputSchema as registerProjectSchema } from '@open-mercato/cezar-contract/projects';
import { setWorkspaceConfigInputSchema as workspaceConfigUpdateSchema } from '@open-mercato/cezar-contract/workspace';
import { reclaimRunParamsSchema } from '@open-mercato/cezar-contract/repo-requests';
import { githubChecksQuerySchema } from '@open-mercato/cezar-contract/github-requests';
import { githubRefsQuerySchema } from '@open-mercato/cezar-contract/github-requests';
import { commitQuerySchema } from '@open-mercato/cezar-contract/query-requests';
import { imageMimeType } from '@open-mercato/cezar-contract/image-path';
import { providerForActiveRun } from '@open-mercato/cezar-contract/active-provider';
import { defined } from '../core/defined.ts';
import { ArchiveOnMergeCoordinator } from './archive-on-merge.ts';
import { CompletionActionCoordinator } from './completion-actions.ts';
import { resolveArchiveOnMerge, resolveGlobalArchiveOnMerge } from '../archive-on-merge-setting.ts';
import type {
  ProjectsResponse,
  RegisterProjectResponse,
  RemoveProjectResponse,
  UpdateProjectResponse,
  AgentWebhooksResponse,
  ProjectWebhookResponse,
  SendAgentReportResponse,
  TestProjectWebhookResponse,
  WorkspaceConfigResponse,
} from '@open-mercato/cezar-contract';
export type { WorkspaceConfigResponse } from '@open-mercato/cezar-contract';
import { permissionDecisionSchema } from '@open-mercato/cezar-contract/permissions';
import { runIdParamSchema as permissionRunIdParamSchema } from '@open-mercato/cezar-contract/events';
import { autosaveCleanupBlocker } from '../autosave-cleanup.ts';
import { CheckoutProgressCache } from './checkout-progress.ts';
import { checkoutProgressParamsSchema, createProjectInputSchema, type CreateProjectResponse, type GithubOwnersResponse } from '@open-mercato/cezar-contract/projects';
import { createLiveRoutes } from './live-routes.ts';
import { createWorkspaceProjects, createWorkspaceProjectContexts, createTaskWebhooks, type WorkspaceProjects } from './workspace-projects.ts';
import { subscribeRunFeed } from './run-event-feed.ts';
import type { ApiRun, ArchivedRunsResponse, RunSummary, RunsSearchResponse } from '@open-mercato/cezar-contract';
import { ARCHIVED_RUNS_PAGE_DEFAULT } from '@open-mercato/cezar-contract/run-limits';
import { RUNS_SEARCH_PER_PROJECT_MAX, archivedRunsQuerySchema, runSummariesQuerySchema, runsSearchQuerySchema } from '@open-mercato/cezar-contract/runs';
import { automationListQuerySchema } from '@open-mercato/cezar-contract/automations';
import { automationScheduleSchema, nextOccurrence } from '@open-mercato/cezar-contract/automation-schedule';
import { localTimeZone } from '@open-mercato/cezar-contract/zoned-time';
import { DelegationService } from '../delegation/service.ts';
import { workerCapacity } from '../delegation/capacity.ts';
import type { DelegationController } from '../delegation/provision.ts';
import { delegationFailure } from '../delegation/routes.ts';
import { githubItemParamsSchema } from '@open-mercato/cezar-contract/github';
import { createRunInputSchema, toRunSummary } from '@open-mercato/cezar-contract/runs';
import { workerEmptyRequestSchema, runRelationshipsSchema } from '@open-mercato/cezar-contract/delegation';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AutomationStore } from '../automations/store.ts';
import { createAutomationService, onceCreateAnswer } from '../automations/service.ts';
import { createAutomationToolService } from '../automations/tool-adapter.ts';
import { AutomationCoordinator } from '../automations/coordinator.ts';
import { AutomationCandidateChangedError, GithubPoller } from '../automations/github-poller.ts';
import { githubBaselineState } from '../automations/github-baseline.ts';
import { ProjectAutomationScheduler, WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { AutomationProjectUnavailableError, SCHEDULE_LEASE_HELD_REASON, ScheduleRunner, type ScheduleRunnerHandle } from '../automations/schedule-runner.ts';
import {
  launchAutomationRun,
  launchScheduledRun,
  rebaselineIdleAutomations,
  reconcileAutomationReceipts,
  validateAutomationPrompt,
} from '../automations/task-template.ts';
import {
  automationFiltersSchema,
  automationTaskSchema,
  isGithubAutomation,
  isScheduleAutomation,
  type AutomationDefinition,
} from '../automations/types.ts';
import type { IncomingMessage, Server } from 'node:http';
import { access, constants as fsConstants, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import type { Next } from 'hono';
import { getRequestListener, serve, type ServerType } from '@hono/node-server';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { matchedRoutes } from 'hono/route';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import { RecentVoiceActions } from '../voice/decision-log.ts';
import { selectVoiceEngine } from '../voice/engine.ts';
import { createVoiceRoutes } from '../voice/routes.ts';
import { deliverOnce, registryEntry, sendAgentReport, TaskWebhooks } from '../runs/webhook.ts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { repoPullInputSchema, deleteBranchesInputSchema } from '@open-mercato/cezar-contract/repo';
import {
  pinRunInputSchema,
  archiveFinishedRequestSchema,
  markAllReadRequestSchema,
  notifyRunInputSchema,
  type RunIndexEntry,
  type RunsIndexResponse,
} from '@open-mercato/cezar-contract/runs';
import {
  githubSearchQuerySchema,
  githubProjectsQuerySchema,
  githubListQuerySchema,
  githubCommentCountsQuerySchema,
} from '@open-mercato/cezar-contract/github';
import { setWorkspaceUiStateInputSchema } from '@open-mercato/cezar-contract/workspace';
// A contract VALUE, like `workspaceUiStateSchema` in workspace/migrations.ts — the request
// schema this route validates with is the same one the client compiles against.
import {
  MODEL_DISCOVERY_RUNNERS,
  openProjectInSchema,
} from '@open-mercato/cezar-contract/workspace';
import {
  attachmentFileParamSchema,
} from '@open-mercato/cezar-contract/runs';
import {
  agentWebhookParamsSchema,
  createProjectWebhookInputSchema,
  projectWebhookParamsSchema,
  sendAgentReportInputSchema,
  updateProjectInputSchema,
  updateProjectWebhookInputSchema,
} from '@open-mercato/cezar-contract/projects';
import { PROJECT_WEBHOOKS_MAX } from '@open-mercato/cezar-contract/project-limits';
import {
  agentWebhook,
  agentWebhooks,
  applyTaskWebhookInput,
  createdWebhook,
  editedWebhook,
  nameTaken,
  projectWebhooks,
  redactWebhook,
  setProjectWebhooks,
  taskWebhooks as taskWebhookList,
} from '../workspace/webhooks.ts';
import { detectEnvironment } from '../core/backend-detect.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import type { ContentBlock } from '../core/agent-runner.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import {
  PROVIDER_IDS,
  ProviderAuthService,
  type ProviderId,
} from '../core/provider-auth.ts';
import { applyProviderEnablement } from '../core/provider-availability.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { currentUsage, onUsage } from '../core/process-usage.ts';
import { WORKFLOWS_DIR, loadWorkflows } from '../workflows/load.ts';
import {
  QUICK_TASK_WORKFLOW,
  normalizeWorkflowDoc,
  skillStackOf,
  skillsToSteps,
  stepsIssue,
  workflowFileSchema,
} from '../workflows/types.ts';
import { planChain, slugify } from '../planner.ts';
import { discoverSkills, type Skill } from '../skills.ts';
import { createSelfUpdateRoutes, type SelfUpdateServerDeps } from './self-update-routes.ts';
import { getTeamSkillsCached, refreshTeamSkills, waitForTeamSkills } from '../skills-remote.ts';
import { readHandoff, renderHandoffRecords } from '../handoff.ts';
import { ARCHIVED_WINDOW, type RepoHandle, type RunEvent, type RunRecord, type RunStatus, type RunStore } from '../runs/store.ts';
import {
  HistoryCursorError,
  deriveRunContextEvents,
  readRunHistoryPage,
  validateLiveCursor,
} from '../runs/event-history.ts';
import { readRunIndexFromDisk, searchRunIndexFromDisk } from '../runs/run-index.ts';
import { workerDestroyView } from '../runs/delegation-state.ts';
import { searchTokens } from '@open-mercato/cezar-contract/run-search';
import { ownPullRequestNumbers } from '../runs/pull-requests.ts';
import { ColdRepoHandles } from './cold-repo-handles.ts';
import { isV2WireEventType } from '../runs/ui-event-sink.ts';
import {
  runEventsQuerySchema, runHistoryQuerySchema,
  runIdParamSchema,
} from '@open-mercato/cezar-contract/events';
import { resolveAttachmentPath } from '../workflows/attachment-path.ts';
import { artifactParamsSchema, fileLinkQuerySchema } from '@open-mercato/cezar-contract/artifacts';
import { artifactDirectory, listArtifacts, readArtifact } from '../artifacts/store.ts';
import { artifactPreview, loadFileLink, rasterMime } from '../artifacts/resolve.ts';
import { isUntouchedCancelledRun, toPastedContent, type RunManager } from '../workflows/run.ts';
import type { PastedContent } from '../workflows/run/types.ts';
import { worktreeDiff, worktreeSizeBytes } from '../git-worktree.ts';
import { releaseThenRemoveWorktree } from '../git-worktree-release.ts';
import { isReclaimable, reclaimWorktree, reclaimWorktrees, rematerializeReclaimedWorktree, selectReclaimableWorktrees } from '../runs/retention.ts';
import { getBranches, getCommit, getDiff, getLogWithParents, getBranchHead, getRepoInfo, getStatus, getTracking } from './git.ts';
import { attributeLog, classifyInputFor, deleteBranches, forgetRepoBranches, githubBranchForge, readRepoBranchCounts, readRepoBranches, type BranchForge, type ClassifyProject } from './repo-branches.ts';
import { claimRepoGitMutation, localPullBranches, pullRepoCheckout } from './repo-pull.ts';
import {
  collectChanges,
  collectCommitChanges,
  collectRunCommits,
  commitAll,
  createOrSwitchBranch,
  pushCurrentBranch,
  readWorktreePath,
} from './git-changes.ts';
import { loadConfig, resolveWorktreeRetention, type CezConfig } from '../config.ts';
import { resolveWorktreeSetup } from '../worktree-setup.ts';
import { findConfigFile } from '../agent-config/catalog.ts';
import { readConfigFile, statConfigPath, writeConfigFile } from '../agent-config/files.ts';
import { readAgentModelDefaults } from '../agent-config/models.ts';
import { listAgentConfig } from '../agent-config/service.ts';
import { listConfigFiles, type AgentHomePaths } from '../agent-config/catalog.ts';
import { readAccountIdentity } from '../agent-config/account-identity.ts';
import {
  defaultWorkspaceConfig,
  loadWorkspaceConfig,
  mergeWriteWorkspaceConfig,
  effectiveComposerDefault,
  type WorkspaceConfig,
  type StoredProjectWebhook,
  type WorkspaceProject,
} from '../workspace/config.ts';
import {
  CONTROL_CHARS_RE,
  DEFAULT_AGENT_ACCOUNT_ID,
  defaultAgentAccountStore,
  isAbsoluteConfigDir,
  loadAgentAccounts,
  mergeWriteAgentAccounts,
  type AgentAccount,
  type AgentAccountStore,
} from '../workspace/agent-accounts.ts';
import {
  defaultAgentProfile,
  listAgentProfiles,
  namedAccountUnavailable,
  ompProfileDirError,
  profileDirState,
  resolveStoredProfile,
  sameProfileDir,
  type ResolvedAgentProfile,
} from '../workspace/agent-profiles.ts';
import { PROFILE_CAPABLE_PROVIDERS, profileAgentDir, profileEnv, supportsProfiles } from '../core/agent-profiles.ts';
import { quoteExecutable, withEnvPrefix } from '../core/shell-env.ts';
import { resolveCursorExecutable } from '../core/cursor-model-catalog.ts';
import { resolveOmpExecutable } from '../core/omp-model-catalog.ts';
import {
  allocateProjectSlug,
  listProjects,
  normalizeProjectTags,
  probeProjectStatus,
  toProjectListEntry,
  registerProject,
  removeProject,
  shouldRegisterProject,
  type ProjectListEntry,
} from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { mergeWriteWorkspaceUiState, readWorkspaceUiState } from '../workspace/ui-state.ts';
import { checkoutRepo, type CloneRunner } from './checkout.ts';
import { createProject, listGithubOwners, type CommandRunner } from './create-project.ts';
import { armPreview, ProjectContexts, projectWarmupEnabled, sweepRegisteredPreviewLeftovers, type ProjectContext } from './project-context.ts';
import { reviewGateEnabled } from '../runs/review-gate.ts';
import { readProjectUiState, readUiState, writeProjectUiState } from '../ui-state.ts';
import { agentHomePaths, expandTilde } from '../paths.ts';
import { isLoopbackHostHeader, normalizeHostname, resolveCapabilities } from './capabilities.ts';
import { applicationUpdateInputSchema, type ApplicationUpdateState } from '@open-mercato/cezar-contract/application-update';
import { ApplicationUpdateConflictError, ApplicationUpdateFailureError, type ApplicationUpdateServiceLike } from '../application-update/service.ts';
import { createSocketHub, socketHubRoute, type SocketHub, type WsUpgradeVerdict } from './ws.ts';
import { attachUpgradeRouter } from './upgrade-router.ts';
import { createPreviewSockets } from './preview-sockets.ts';
import type { PreviewHost } from '../preview/host.ts';
import { browseDirectory, isInsideBrowseRoot, isLexicallyInsideBrowseRoot, resolveBrowseRoot } from './fs-browse.ts';
import { parseRemote, forgeKindOfRemote, forgeRepositoryUrl, resolveForge, forgeWebRoot, resolveForgeRoot, type ForgeFactory, type ForgeAvailability } from './forge/index.ts';
import { refNumberFromUrl } from '@open-mercato/cezar-contract/run-search';
import { GithubPrNotFoundError, GH_CHECKS_MAX, GH_REF_STATUS_MAX } from './forge/index.ts';
import type { CockpitOwnership } from './cockpit-ownership.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { openInTerminal } from './open-in-terminal.ts';
import { openRunApp, openRunCli, openRunDefaultApp } from './open-in-targets.ts';
import { agentCliRunner, detectOpenTargets, openFileInDefaultApp, openInApp } from './open-in-app.ts';
import { ProviderRuntimeAuthObserver } from './provider-auth-runtime.ts';
import {
  providerForExistingRun,
  providersRequiredByWorkflow,
} from './provider-action-gate.ts';
import {
  attachProjectWebhooks,
  createBootContext,
  createProviderStatus,
  resolveServerDeps,
  watchProviderRuntimeAuth,
} from './server-deps.ts';
import {
  NO_WEBHOOK_ERROR,
  agentProfileRefusal,
  clientRequestOf,
  launchRun,
  modelLockRefusal,
  notifyRefusal,
  providerGateRefusal,
  replayedRun,
  resolveStartWorkflow,
  startRunInput,
} from './start-run-options.ts';
import {
  ASSET_CACHE_CONTROL,
  BUILD_HINT_HTML,
  assetContentType,
  isSafeAssetFilename,
  resolveGetRequest,
} from './static-ui.ts';

export interface ServerDeps extends SelfUpdateServerDeps {
  /** Per-repository forge injection for embedded servers and tests. */
  forgeFactory?: ForgeFactory;
  /** CLI lifetime ownership, shared with secondary project contexts. */
  ownership?: CockpitOwnership;
  /** The task-webhook subscribers (#589). Boot creates it and attaches the boot store BEFORE
   *  `manager.recover()`, so recovery's transitions are reported; `startServer` sets its origin
   *  from the port it binds. Absent (tests, embedded apps), `createApp` makes its own. */
  taskWebhooks?: TaskWebhooks;
  /** Test seam for task-webhook deliveries (#589): the `fetch` they POST with. Used only when
   *  `createApp` builds its own `TaskWebhooks`. */
  taskWebhookFetch?: typeof fetch;
  /** Same-process optional private listener; attached to managers before recovery. */
  delegation?: DelegationController;
  repoRoot: string;
  store: RunStore;
  manager: RunManager;
  version: string;
  /** Mutable holder for the async npm-registry update check (#368) —
   *  `latest` appears once the registry answers with a newer version. */
  update?: { latest?: string };
  /** Local npm update coordinator, absent for test/embedded servers. */
  applicationUpdate?: ApplicationUpdateServiceLike | undefined;
  /** Host the HTTP server binds (default 127.0.0.1). A non-loopback host
   *  implies hosted mode — `capabilities.localHandoff:false`. */
  bindHost?: string | undefined;
  /** Workspace-registry id of the boot project (multi-project spec) — plumbed
   *  from `initWorkspace` in src/index.ts. Optional: legacy callers/tests get
   *  a lazy registry lookup by `repoRoot`, falling back to the repo's slug. */
  bootProjectId?: string | undefined;
  /** Per-project context map (multi-project spec, step 2.2). Non-boot
   *  `/api/p/:projectId/*` requests resolve their `{store, manager, …}` here,
   *  built lazily on first touch. Optional so legacy callers change nothing —
   *  the default is a registry-backed map; tests inject their own so they can
   *  `disposeAll()` after. The BOOT project never lives in this map: its
   *  context is seeded from `deps.{store,manager}` (which src/index.ts already
   *  recovered/pruned at startup) and the resolver short-circuits to it. */
  contexts?: ProjectContexts | undefined;
  /** Boot project's shared automation store. `startServer` injects the
   *  coordinator-owned instance so HTTP routes and the scheduler never cache
   *  separate views of the same project files. */
  automationStore?: AutomationStore;
  /** Workspace-wide parallel-cap semaphore + cached resource config (spec
   *  2026-07-20, step 2.5): the ONE instance boot created, refreshed, and gave
   *  the boot manager — threaded into the default `ProjectContexts` so every
   *  project's RunManager shares it. Step 2.7's `PUT /api/workspace/config`
   *  calls `semaphore.refresh()` after a write. Optional so legacy
   *  callers/tests change nothing. */
  semaphore?: WorkspaceSemaphore;
  /** Workspace-level SSE bus (spec, step 2.8): `project-added` /
   *  `project-removed` / `checkout-progress` plus the host-wide unstamped
   *  `provider-status` event reach `/api/workspace/events` through this.
   *  Optional — createApp builds a private one; inject to emit from outside
   *  the app (tests, future CLI hooks). */
  workspaceEvents?: WorkspaceEventBus | undefined;
  /** How `POST /api/projects/checkout` (step 4.3) actually clones. Defaults to
   *  `gh repo clone` (or the `CEZ_DRY_RUN=1` fake) — injected by tests so the
   *  route's guards, cleanup and error surfacing are exercised for real
   *  against real temp dirs, without a network or a `gh` binary. */
  cloneRunner?: CloneRunner;
  /** How `POST /api/v1/projects/create` and `GET /api/v1/projects/github-owners`
   *  run `git`/`gh` (spec 2026-10-15-create-new-project). Defaults to real
   *  commands (or the `CEZ_DRY_RUN=1` fake); injected by tests. */
  projectCommandRunner?: CommandRunner;
  /** What the Git view's branch classifier asks GitHub (issue 08). Defaults to the ref-status
   *  cache plus one cached `gh pr list`; tests inject a fake forge. */
  branchForge?: BranchForge;
  /** Host-wide model discovery service. Tests inject a deterministic adapter. */
  modelCatalog?: RunnerModelCatalog;
  /** Host-wide provider authentication discovery. Tests inject deterministic probes. */
  providerAuth?: ProviderAuthService;
  /** Global provider enablement preferences. Tests may inject an in-memory store. */
  workspaceConfig?: {
    load: typeof loadWorkspaceConfig;
    mergeWrite: typeof mergeWriteWorkspaceConfig;
  } | undefined;
  /** Shared runtime rejection observer. The CLI injects the instance already
   *  watching the boot store before recovery; createApp builds one for legacy
   *  callers and tests. */
  providerRuntimeAuth?: ProviderRuntimeAuthObserver;
  /** Local terminal handoff for provider-owned login. */
  openTerminal?: typeof openInTerminal | undefined;
  /** Hand a local FILE (or folder) to the OS default app. Injected so the account-file open route
   *  is testable without actually launching an editor. */
  openFile?: typeof openFileInDefaultApp;
  /** Hand a folder to a detected app by target id — editor, file manager, or `terminal`, which
   *  reaches `openInTerminal`. Injected for the same reason as the two above: a test that reaches
   *  this for real opens a window on the developer's machine (#820). */
  openApp?: typeof openInApp;
  /** WebSocket subscription hub (`/api/v1/ws`, src/server/ws.ts). `createApp`
   *  only registers topics on it — `startServer` builds one and attaches it
   *  to the HTTP server it binds. Optional so legacy callers/tests change
   *  nothing: no hub, no topics, and the HTTP surface is byte-identical. */
  socketHub?: SocketHub;
  /** The workspace-wide live preview host (#781), one per server process because ports are
   *  host-global. Present only under `CEZ_PREVIEW=1`; absent, the preview WebSocket answers 404
   *  and every run manager answers `headless`. */
  previewHost?: PreviewHost | undefined;
  /** The port the cockpit listens on, once it does: `cezar_preview_serve` refuses it. */
  cezarPort?: () => number | undefined;
  /** Shared workspace identity and upgrade lookup; direct createApp callers get a local instance. */
  workspaceProjects?: WorkspaceProjects;
  /** Re-arm the workspace automation timer after definition mutations. */
  automationsChanged?: () => void;
  archiveOnMergeChanged?: () => void;
}

// ---- project-scoped routing (multi-project spec, step 2.2) -----------------

/** Hono env for the mirrored project-route table: the scope resolver puts the
 *  request's `ProjectContext` on the context, handlers read `c.get('project')`. */
export type ProjectApiEnv = { Variables: { project: ProjectContext; stoppedOnAdoption?: boolean } };

/** The hosted-mode refusal, worded like the agent-config one it mirrors. */
const HOSTED_GITHUB_CREATE_REFUSAL = 'Creating GitHub repositories is available from a local cockpit only';
const HOSTED_GITHUB_OWNERS_REASON = 'GitHub repositories can be created from a local cockpit only';

const hostedProfileRefusal = {
  error: 'agent accounts are managed from the machine that owns the checkout (this cockpit runs in hosted mode)',
};

/**
 * Allocate a profile id from the label (or, with no label, the folder name).
 *
 * Reuses the project allocator's shape, and deliberately its reserved set too: `default` is the
 * discovered profile here exactly as it is the boot alias there, so a folder called `default/`
 * becomes `default-2` and can never shadow it.
 */
function allocateAgentProfileId(source: string, taken: Iterable<string>): string {
  // `allocateProjectSlug` already basenames its argument and enforces the shared
  // `^[a-z0-9][a-z0-9-]{0,63}$` shape, so `~/.claude-klaudiusz` slugs to `claude-klaudiusz`.
  return allocateProjectSlug(source, taken);
}

/** One row of the mirrored project-route table. */
export interface ProjectRouteInfo {
  method: string;
  /** Path relative to the mount — `/runs/:id`, not `/api/runs/:id`. */
  path: string;
}

/**
 * The public API surface (spec 2026-07-23-independent-server-web-packages).
 *
 * Every route lives under this one prefix. The unversioned `/api/*` spelling the cockpit used
 * to speak was removed once the whole API was reachable here — carrying two spellings meant two
 * surfaces to keep working, and only one of them could be the typed contract. Bumping to `v2`
 * means mounting a second table beside this one, not editing route paths.
 */
const V1_PREFIX = '/api/v1';

/** Project scoping inside the versioned surface. The version is the OUTER dimension, so a
 *  consumer picks its API version once and then addresses projects inside it. */
const V1_SCOPED_PREFIX = `${V1_PREFIX}/p/:projectId`;

/**
 * The project-scoped route table of a `createApp()` app, derived from its actual registrations
 * (so it can never drift from the code): every method+path mounted under
 * `/api/v1/p/:projectId/…`, minus the scope-resolver middleware (method ALL), deduped. The
 * alias-parity suite iterates this to assert `/api/v1/<path>` ≡ `/api/v1/p/<boot>/<path>` ≡
 * `/api/v1/p/default/<path>`.
 */
export function projectRouteManifest(app: Hono): ProjectRouteInfo[] {
  const seen = new Set<string>();
  const manifest: ProjectRouteInfo[] = [];
  for (const route of app.routes) {
    if (route.method === 'ALL' || !route.path.startsWith(`${V1_SCOPED_PREFIX}/`)) continue;
    const path = route.path.slice(V1_SCOPED_PREFIX.length);
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    manifest.push({ method: route.method, path });
  }
  return manifest;
}

/** 409 body for every automations route while GitHub automations are off (#801). */
const AUTOMATIONS_OFF = 'Automations are disabled — set CEZ_AUTOMATIONS=1 to enable them';

/** 404 body for a run whose row is in runs.db but whose record this cezar cannot decode (#779). */
const UNREADABLE_RUN_ERROR = 'this run could not be read by this cezar: its record in runs.db does not fit this version (a newer cezar may have written it). It is left in the database untouched.';

// These response shapes belong to the contract; keep the server's existing type exports.
export type { ProjectsResponse, RegisterProjectResponse, RemoveProjectResponse, UpdateProjectResponse } from '@open-mercato/cezar-contract';

// ---- workspace SSE (multi-project spec, step 2.8) --------------------------

/** Workspace-level event names carried ONLY on `GET /api/workspace/events`
 *  (never on the per-project streams): registry mutations, the GUI-clone
 *  progress feed (step 4.3), and host-wide unstamped provider status. */
export type WorkspaceEventName =
  | 'project-added'
  | 'project-removed'
  | 'checkout-progress'
  | 'health'
  | 'model-catalog'
  | 'provider-status'
  | 'automation-change'
  | 'project-ready';

/**
 * The in-process bus for workspace-level SSE events. The registry-mutating
 * routes (`POST /api/projects` — step 4.2, emits `project-added` for a
 * genuinely new entry; `DELETE /api/projects/:projectId` — step 4.4) and the
 * checkout flow (step 4.3) call `emit()`; runtime provider auth observation
 * emits host-wide `provider-status`; every open `/api/workspace/events` stream
 * relays the event verbatim under its name. Injectable via
 * `ServerDeps.workspaceEvents` so tests (and any out-of-createApp emitter) can
 * drive the stream.
 */
export class WorkspaceEventBus {
  private readonly listeners = new Set<(event: WorkspaceEventName, data: unknown) => void>();

  emit(event: WorkspaceEventName, data: unknown): void {
    for (const listener of [...this.listeners]) listener(event, data);
  }

  /** Subscribe; returns an unsubscribe. */
  on(listener: (event: WorkspaceEventName, data: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** streamSSE with the anti-buffering contract (#424): hono's own header is a
 *  bare `no-cache`, which lets an intermediary (reverse proxy, compression
 *  middleware, corporate MITM) transform-buffer the stream — the client then
 *  sees a silently frozen transcript while the server keeps writing. Headers
 *  are set on the returned Response because hono's helper overwrites
 *  `Cache-Control` set via `c.header()` before it. */
const streamSSENoBuffer: typeof streamSSE = (c, cb, onError) => {
  const res = streamSSE(c, cb, onError);
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  return res;
};

// Queued prompt stack bounds (#472). The per-message bounds mirror `messageSchema`
// above; the one that actually matters is the FOLDED total, because 20 messages of
// 100 000 chars each would otherwise compose a ~2 M-character {{task}}.
const MAX_QUEUED_MESSAGES = 20;
const MAX_QUEUED_ATTACHMENTS = 8;
const MAX_FOLDED_TASK_CHARS = 200_000;

/** Length of the prompt a run would execute with — `task` plus its whole stack,
 *  composed exactly as `hydrateQueuedInput` composes it. Checked against the
 *  PROSPECTIVE state so the user is stopped at the write, not at dequeue where
 *  there would be no one left to tell. */
function foldedLength(task: string, stack: Array<{ text: string }>): number {
  return [task, ...stack.map((m) => m.text)]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n').length;
}

// Request-body size guards (#429). A generous global cap keeps a single
// localhost request from being unbounded (the largest legit body is 4 pasted
// images at ~7 MB base64 each); the ui-state PUT gets a much tighter cap since
// it only ever carries small GUI prefs.
const GLOBAL_BODY_LIMIT = 32 * 1024 * 1024; // 32 MiB
const UI_STATE_BODY_LIMIT = 128 * 1024; // 128 KiB

/** The name half of a Host header — `localhost:4321` → `localhost`,
 *  `[::1]:4321` → `[::1]`. A bracketed IPv6 literal keeps its brackets
 *  (`isLoopbackHost` strips them itself); an unbracketed IPv6 spelling is
 *  nonstandard in a Host header and simply fails the loopback test closed. */
function stripHostPort(host: string): string {
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(host);
  if (bracketed?.[1]) return bracketed[1];
  return host.replace(/:\d+$/, '');
}

/**
 * HTTP content negotiation for the two routes that serve more than one FORMAT on one path:
 * `GET /repo/commit/:sha` (a structured payload or the legacy text blob) and
 * `GET /runs/:id/files` (a JSON listing/metadata or an image file's BYTES).
 *
 * ## Precedence — flag, then Accept, then the route's own default
 *
 * 1. **The query flag wins whenever the request carries it.** `?structured=1` and `?raw=1` are the
 *    live wire and a protected surface (BACKWARD_COMPATIBILITY.md); `Accept` is ADDITIVE and
 *    may never override a caller that said what it wanted in the URL. The flag counts as "carried"
 *    when the key is PRESENT, so `?raw=0` is an explicit opt-out of the raw representation and not
 *    an invitation to re-decide from a header.
 * 2. **Otherwise the best `Accept` match** among the representations that route offers.
 * 3. **Otherwise the route's established default** — the text blob for `/repo/commit/:sha`, the
 *    JSON listing for `/runs/:id/files` — i.e. exactly what a pre-Accept client received.
 *
 * `*<slash>*` matches NOTHING here, deliberately: it is what `fetch`, `curl` and XHR send when
 * they have no preference at all, and treating "anything" as a preference would silently change
 * the default representation of both routes for every existing caller. A browser that navigates to
 * a worktree image DOES get the bytes, because its `Accept` really does ask for `image/*` at q=1 —
 * the same protections ride along (image extensions only, size cap, `nosniff`, sandbox CSP).
 *
 * Both routes answer `Vary: Accept`, since a cache that ignored the header would serve one
 * representation for the other.
 */
type MediaRange = { type: string; subtype: string; q: number };

function parseAccept(header: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (const part of header.split(',')) {
    const [range = '', ...params] = part.split(';');
    const [type = '', subtype = ''] = range.trim().toLowerCase().split('/');
    if (type === '' || subtype === '') continue;
    const weight = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    const parsed = weight === undefined ? 1 : Number.parseFloat(weight.slice(2));
    const q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
    if (q > 0) ranges.push({ type, subtype, q });
  }
  return ranges;
}

/**
 * The best of `offers` for this `Accept`, or `null` for "no preference expressed" — which is what
 * an absent header, a `*<slash>*`-only header and a header naming nothing on offer all mean, and
 * what leaves the caller on its route's default.
 *
 * `offers` is the server's own preference order: an offer may itself be a wildcard (`image/*`,
 * since the concrete image type is not known until the file is read), and equal q-values go to the
 * EARLIER offer, so each route lists its default representation first.
 */
function negotiate<O extends string>(accept: string | undefined, offers: readonly O[]): O | null {
  if (accept === undefined) return null;
  const ranges = parseAccept(accept);
  let best: { offer: O; q: number } | null = null;
  for (const offer of offers) {
    const [type = '', subtype = ''] = offer.split('/');
    let q = 0;
    for (const range of ranges) {
      if (range.type === '*' && range.subtype === '*') continue; // "anything" is not a preference
      const typeMatches = range.type === type || range.type === '*' || type === '*';
      const subtypeMatches = range.subtype === subtype || range.subtype === '*' || subtype === '*';
      if (typeMatches && subtypeMatches && range.q > q) q = range.q;
    }
    if (q > 0 && (best === null || q > best.q)) best = { offer, q };
  }
  return best?.offer ?? null;
}

/** What `GET /repo/commit/:sha` offers, DEFAULT FIRST: the legacy `text/plain` blob is what a
 *  request with no opinion has always received (§2), so it also wins an Accept tie. */
const COMMIT_FORMATS = ['text/plain', 'application/json'] as const;

/** What `GET /runs/:id/files` offers, DEFAULT FIRST. `image/*` rather than a concrete type: which
 *  image type the bytes are is only known once the path resolves, and the raw branch refuses
 *  everything that is not an image anyway. */
const FILE_FORMATS = ['application/json', 'image/*'] as const;

/** Workspace-root writability probe (multi-project spec, "API Contracts"):
 *  optional `mkdir -p`, `access W_OK`, then a real create/delete round-trip — W_OK alone
 *  can lie (e.g. a read-only mount still reports writable permission bits).
 *  Returns the failure message, or null when the directory is usable. */
async function probeWritableDir(dir: string, create: boolean): Promise<string | null> {
  const probe = join(dir, `.cez-write-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    if (create) await mkdir(dir, { recursive: true });
    const info = await stat(dir);
    if (!info.isDirectory()) return `${dir} is not a directory`;
    await access(dir, fsConstants.W_OK);
    await writeFile(probe, '', 'utf8');
    await unlink(probe);
    return null;
  } catch (err) {
    await unlink(probe).catch(() => {}); // best-effort if the round-trip half-succeeded
    return err instanceof Error ? err.message : String(err);
  }
}

// The return type is INFERRED on purpose: it is the chained app type built at the bottom of
// this function, and `AppType` (src/server/app-type.ts) is `ReturnType<typeof createApp>`.
// Annotating it `Hono` here would erase every route from the type and leave the typed client
// with nothing to offer. See the `routed` assembly at the end of the function.
export function createApp(deps: ServerDeps) {
  const { version, update, bindHost, bootProjectId } = deps;
  const resolveProjectForge = (info: Awaited<ReturnType<typeof getRepoInfo>>) => resolveForge(info, deps.forgeFactory);
  // Boot singletons keep DELIBERATELY distinct names (`boot*`): every
  // project-scoped handler must resolve its `{store, manager, root, dataDir,
  // launchKey}` from `c.get('project')` — a bare `store`/`repoRoot` in a
  // handler body would silently pin it to the boot project, which the rename
  // turns into a compile error instead.
  const bootRoot = deps.repoRoot;
  const bootDataDir = join(bootRoot, '.ai/cezar');
  // The host-wide services and the provider closures built on them live in `./server-deps.ts`.
  const { modelCatalog, providerAuth, workspaceConfig, openTerminal, openFile, openApp } =
    resolveServerDeps(deps, bootRoot);
  const { providerStatus, providerActionError, invalidateHostModels } =
    createProviderStatus({ modelCatalog, providerAuth, workspaceConfig });

  const workspaceProjects = deps.workspaceProjects ?? createWorkspaceProjects({ bootRoot, bootProjectId, bindHost });
  const { resolveBootProject } = workspaceProjects;
  // Health's workspace garnish: id+name ONLY — never `root` (#431, see the
  // health route). Reads only the registry file; no per-root status probes,
  // so health stays cheap enough for the bookmarklet's 800 ms port sweep.
  const workspaceSummary = async (): Promise<{
    projects: { id: string; name: string }[];
    bootProject: string;
  }> => {
    try {
      const registry = (await loadWorkspaceConfig()).projects;
      const bootProject = await resolveBootProject(registry);
      const visible = await workspaceProjects.visibleProjects(registry, bootProject);
      return {
        // Explicit picks, not a spread: the registry schema passes unknown
        // keys through, and `root` must never ride along onto health.
        projects: visible.map((p) => ({
          id: p.id,
          name: p.name || basename(p.root),
        })),
        bootProject,
      };
    } catch {
      return { projects: [], bootProject: await resolveBootProject([]) };
    }
  };
  // Hosted-mode gate (spec §"Deployment modes") — read per request so
  // CEZ_REMOTE flips take effect live (and tests can toggle it).
  const capabilities = () => resolveCapabilities(process.env, bindHost);
  const singleProjectRefusal = (
    action: 'adding projects' | 'editing projects' | 'removing projects' | 'folder browsing',
  ) => ({ error: `single-project mode is enabled; ${action} is disabled` });
  // Inbox live updates (spec 007). Opt-in (#471): no capability, no watcher —
  // and since step 2.3 the per-dataDir watch is created lazily by the first
  // SSE subscription (and torn down with the last), nothing to start here.

  // ---- project contexts (multi-project spec, step 2.2) ---------------------
  // The boot project's context is SEEDED from the deps the caller already built (`createBootContext`).
  const bootContext: ProjectContext = createBootContext(deps, bootRoot, bootDataDir);
  // The task webhook (#589): attached before any recovery — the boot store by `index.ts`, lazy
  // projects through `prepareManager` below. Attaching is idempotent, so the calls here only
  // cover an app built without boot's wiring (tests, embedded servers).
  const taskWebhooks = createTaskWebhooks(deps, '');
  taskWebhooks.attach(bootContext);
  // Non-boot projects build lazily on first scoped request; their managers
  // count against the same workspace semaphore as the boot manager (step 2.5).
  const contexts = createWorkspaceProjectContexts(deps, taskWebhooks, {
    listProjects: () => workspaceProjects.listVisibleProjects(),
    cezarPort: deps.cezarPort,
  });
  // Workspace-level SSE bus (step 2.8) — the registry mutators and the
  // checkout flow (Phase 4) emit here; /api/workspace/events relays.
  const serverGeneration = randomUUID();
  const checkoutProgress = new CheckoutProgressCache();
  const workspaceEvents = deps.workspaceEvents ?? new WorkspaceEventBus();
  const emitAutomationChange = (
    project: ProjectContext,
    automationId: string,
    revision: number,
    deleted = false,
  ) => workspaceEvents.emit('automation-change', {
    project: project.id,
    automationId,
    revision,
    ...(deleted ? { deleted: true } : {}),
  });
  const automationsChanged = () => deps.automationsChanged?.();

  const providerRuntimeAuth = deps.providerRuntimeAuth
    ?? new ProviderRuntimeAuthObserver(providerAuth, (status) => {
      workspaceEvents.emit('provider-status', status);
    });

  watchProviderRuntimeAuth(providerRuntimeAuth, bootContext, contexts);

  attachProjectWebhooks(taskWebhooks, contexts);
  // #667: recovery ran inside the build, before any workspace stream attached to this project's
  // store, so the runs it resumed sent no `run` event. Until a cockpit refetches, its cross-project
  // index keeps the cold read's answer: every run the restart interrupted, shown as failed.
  contexts.onContextBuilt((ctx) => workspaceEvents.emit('project-ready', { project: ctx.id }));
  const projectRegistryEntry = workspaceProjects.registryEntry;
  workspaceProjects.bindContexts(bootContext, contexts);

  /** One `task.test` POST to `webhook`, or a dry run under `CEZ_DRY_RUN=1`. */
  const sendTestDelivery = async (projectId: string, webhook: StoredProjectWebhook): Promise<TestProjectWebhookResponse> => {
    if (process.env.CEZ_DRY_RUN === '1') return { ok: true, dryRun: true };
    const payload = {
      event: 'task.test' as const,
      deliveryId: randomUUID(),
      projectId,
      webhook: { id: webhook.id, name: webhook.name },
      occurredAt: new Date().toISOString(),
    };
    const result = await deliverOnce(webhook, payload, { fetch: deps.taskWebhookFetch });
    return {
      ok: result.ok,
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  };

  type WebhookEdit =
    | { webhooks: StoredProjectWebhook[]; webhook: StoredProjectWebhook }
    | { error: string; status: 404 | 409 };
  /**
   * Read-modify-write one project's webhook list (hearsay-tools/cezarion#1576), with the PATCH
   * route's guards: single-project mode refuses, an unknown project 404s without a write, and a
   * failed write (a read-only home) answers 500 having persisted nothing.
   */
  const editProjectWebhooks = async (
    raw: string,
    edit: (webhooks: StoredProjectWebhook[]) => WebhookEdit,
  ): Promise<{ body: ProjectWebhookResponse } | { error: string; status: 400 | 404 | 409 | 500 }> => {
    if (capabilities().singleProject) return { ...singleProjectRefusal('editing projects'), status: 409 };
    const resolved = await workspaceProjects.resolveProjectId(raw);
    if ('error' in resolved) return { ...resolved, status: 404 };
    const { id } = resolved;
    const known = await loadWorkspaceConfig().then((config) => config.projects.some((p) => p.id === id), () => false);
    if (!known) return { error: `unknown project: ${id}`, status: 404 };
    let updated: WorkspaceProject | undefined;
    let outcome: WebhookEdit | undefined;
    try {
      await mergeWriteWorkspaceConfig((config) => {
        const entry = config.projects.find((p) => p.id === id);
        if (!entry) return;
        outcome = edit([...projectWebhooks(entry)]);
        if ('error' in outcome) return;
        setProjectWebhooks(entry, outcome.webhooks);
        updated = entry;
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), status: 500 };
    }
    if (outcome && 'error' in outcome) return outcome;
    if (!updated || !outcome) return { error: `unknown project: ${id}`, status: 404 };
    return {
      body: {
        project: toProjectListEntry(updated, await probeProjectStatus(updated.root)),
        webhook: redactWebhook(outcome.webhook),
      },
    };
  };

  const app = new Hono();

  // Reject oversized request bodies before they reach any handler (#429). GETs
  // and SSE carry no body, so this only ever gates the mutating routes.
  app.use('*', bodyLimit({ maxSize: GLOBAL_BODY_LIMIT }));

  // Local APIs require a loopback Host, including health. Browser writes require
  // matching full authority or the verified local dev-proxy case. Health alone is
  // CORS-readable. Hosted mode delegates Host/auth policy to the deployment;
  // absent Origin remains valid for native clients. Keep WS trust checks separate.
  const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const isHostedMode = () => !resolveCapabilities(process.env, bindHost).localHandoff;
  app.use('/api/*', async (c, next) => {
    const hostName = hostnameOfHost(c.req.header('host'));
    // Strict twin of `isLoopbackHost`: a *missing* Host is untrusted here (an
    // absent header is not the "we defaulted to the loopback bind" case), and
    // the loopback match is anchored so `127.0.0.1.evil.com` does not pass.
    if (!isHostedMode() && !isLoopbackHostHeader(hostName)) {
      return c.json(
        {
          error: 'forbidden: unexpected Host header — this request did not originate from this machine (see #426)',
        },
        403,
      );
    }

    // /api/v1/health stays CORS-open for cross-origin discovery, but its Host is
    // still checked above: cross-origin is legitimate, DNS rebinding is not. The
    // path is spelled through V1_PREFIX rather than inline — an unversioned
    // literal here silently stopped matching when the API moved and left health
    // relying on the mutating-methods gate below to let its GETs through.
    if (c.req.path === `${V1_PREFIX}/health`) return next();

    if (MUTATING_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin !== undefined) {
        const originHost = hostnameOfOrigin(origin);
        // Compare the whole authority, not just the hostname: a different PORT
        // is a different web origin, and on a dev machine `http://localhost:3000`
        // is every bit as foreign as `https://evil.tld`. Matching on hostname
        // alone would let any page served from another loopback port (a local
        // dev server rendering attacker content, an XSS in a local app) start a
        // shell-capable agent here.
        const sameOrigin = !!originHost && authorityOfOrigin(origin) === authorityOfHost(c.req.header('host'));
        // The one legitimate cross-port case is the `npm run dev` Vite proxy:
        // the browser fetches same-origin from `localhost:5173`, Vite's
        // `changeOrigin` rewrites Host to `127.0.0.1:<api port>` but forwards
        // the original Origin, so the authorities no longer line up. The browser
        // already told us what it thinks: `Sec-Fetch-Site: same-origin` is a
        // forbidden header name that page JS cannot set, and a cross-port
        // attacker page gets `same-site`, never `same-origin`. Requiring it
        // (plus loopback on both ends) readmits the proxy without readmitting
        // the attack. Browsers too old to send Sec-Fetch metadata simply fail
        // closed here — they still work against a non-proxied cockpit.
        const isDevProxy =
          c.req.header('sec-fetch-site') === 'same-origin' &&
          isLoopbackHostHeader(originHost) &&
          isLoopbackHostHeader(hostName);
        if (!sameOrigin && !isDevProxy) {
          return c.json(
            {
              error: 'forbidden: cross-origin request rejected (same-origin only)',
            },
            403,
          );
        }
      }
      // Belt-and-suspenders for browsers that send Sec-Fetch metadata: an
      // explicit cross-site marker is rejected regardless of the Origin dance.
      if (c.req.header('sec-fetch-site') === 'cross-site') {
        return c.json(
          {
            error: 'forbidden: cross-site request rejected (same-origin only)',
          },
          403,
        );
      }
    }
    return next();
  });

  // Register project routes once; mount them under scoped and boot-alias prefixes.
  // Resolve default and boot ids to the boot context; unknown/missing projects map to 404/409.
  const resolveProjectScope = async (c: Context<ProjectApiEnv>, next: Next): Promise<Response | void> => {
    const raw = c.req.param('projectId');
    let project: ProjectContext;
    try {
      project = await workspaceProjects.resolveProject(raw);
    } catch (err) {
      const failure = workspaceProjects.httpFailure(err);
      if (failure) return c.json({ error: failure.error }, failure.status);
      throw err;
    }
    // The boot project's store could not open (#779): its runs are unknown, not absent, so its
    // routes answer with why rather than as an empty project. Only its routes: this resolver also
    // runs in front of every workspace route (`/health` above all), which must keep answering.
    if (project.store.unavailable && servesProjectRoute(c)) return c.json({ error: project.store.unavailable.message }, 409);
    c.set('project', project);
    return next();
  };
  /** Every method+path of the project table, under both prefixes; filled once `v1` is built. */
  let projectRoutePaths: ReadonlySet<string> = new Set();
  const servesProjectRoute = (c: Context): boolean =>
    matchedRoutes(c).some((route) => route.method !== 'ALL' && projectRoutePaths.has(`${route.method} ${route.path}`));

  // ---- static GUI ----------------------------------------------------------
  const webDir = resolveWebDir();
  const distDir = join(webDir, 'dist');
  const HTML_TYPE = 'text/html; charset=utf-8';
  const staticFile = (name: string, type: string) => (c: Context): Response => {
    // Read per request — the files are tiny and this keeps dev iteration live.
    //
    // Served out of the Vite build: the files are `public/` assets of the web package, which the
    // build copies verbatim into `web/dist`. One home, one URL — the same bytes these routes
    // hand out are what the bundle's `<img src>` and `<link rel="icon">` ask for by those exact
    // paths. Without a build there is nothing to serve, which is a 404 rather than a crash (the
    // shell route answers the same dev-only state with its build hint).
    const path = join(distDir, name);
    if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
    return new Response(readFileSync(path), { headers: { 'content-type': type } });
  };

  // Stable SharedWorker identity across same-origin tabs; its imported chunks stay hashed.
  app.get('/live-worker.js', (c) => {
    const response = staticFile('live-worker.js', 'text/javascript; charset=utf-8')(c);
    response.headers.set('Cache-Control', 'no-cache');
    return response;
  });

  let hintLogged = false;
  const serveShell = (c: Context): Response | undefined => {
    const distIndex = join(distDir, 'index.html');
    // existsSync per request, like the reads below: `npm run build:web` in a
    // running cockpit takes effect on the next reload, no restart.
    const target = resolveGetRequest({
      path: c.req.path,
      distExists: existsSync(distIndex),
    });
    if (target === 'passthrough') return undefined;
    if (target === 'build-hint') {
      // Dev-only state (the tarball ships web/dist): serve the built-in hint
      // page instead of the app — the legacy fallback UI was deleted in R7.
      if (!hintLogged) {
        hintLogged = true;
        console.log('cezar: web/dist is missing — run `npm run build:web` to build the cockpit');
      }
      return new Response(BUILD_HINT_HTML, {
        headers: { 'content-type': HTML_TYPE },
      });
    }
    return new Response(readFileSync(distIndex), {
      headers: { 'content-type': HTML_TYPE },
    });
  };

  // Hashed bundles/fonts of the built app. Vite fingerprints every name, so
  // the bytes behind a URL never change — cache them hard. Only plain
  // filenames are served: `basename('..')` is `'..'` (it resolves to the
  // assets dir itself and readFileSync would throw EISDIR), so dot-segments
  // and separator-bearing params get a 404, not a 500.
  app.get('/assets/:file', (c) => {
    const file = c.req.param('file');
    if (!isSafeAssetFilename(file)) return c.json({ error: 'not found' }, 404);
    const path = join(distDir, 'assets', file);
    if (!existsSync(path) || !statSync(path).isFile()) return c.json({ error: 'not found' }, 404);
    return new Response(readFileSync(path), {
      headers: {
        'content-type': assetContentType(file),
        'cache-control': ASSET_CACHE_CONTROL,
      },
    });
  });

  // The themed brand SVGs (#143): the sidebar lockup pair and the favicon pair. The cockpit
  // picks light or dark by its RESOLVED theme, so both files of each pair must be served —
  // a `<link media>` pair would follow the OS, which the stored theme can disagree with.
  app.get('/cezarion-lockup-light.svg', staticFile('cezarion-lockup-light.svg', 'image/svg+xml'));
  app.get('/cezarion-lockup-dark.svg', staticFile('cezarion-lockup-dark.svg', 'image/svg+xml'));
  app.get('/cezarion-mark-light.svg', staticFile('cezarion-mark-light.svg', 'image/svg+xml'));
  app.get('/cezarion-mark-dark.svg', staticFile('cezarion-mark-dark.svg', 'image/svg+xml'));

  // ---- meta ----------------------------------------------------------------
  // CORS — deliberately for /api/health ONLY (spec 011): the bookmarklets
  // fetch it cross-origin from github.com to discover which local ports run a
  // cockpit and which repo each serves. Health exposes no secrets beyond the
  // repo path/remote; every other endpoint stays same-origin.
  const healthCors = async (c: Context, next: Next): Promise<Response | void> => {
    c.header('access-control-allow-origin', '*');
    if (c.req.method === 'OPTIONS') {
      // Preflight (e.g. Chrome Private Network Access) — allow the plain GET.
      c.header('access-control-allow-methods', 'GET');
      c.header('access-control-allow-private-network', 'true');
      return c.body(null, 204);
    }
    await next();
  };
  app.use(`${V1_PREFIX}/health`, healthCors);
  // One builder for both transports: `GET /api/health` (the authoritative,
  // CORS-open discovery endpoint) and the `health` topic on `/api/v1/ws` below
  // push the byte-identical shape, so the two can never drift.
  // Deliberately UNANNOTATED: this literal is the source of the `/health` shape. Annotating it
  // with the api-client's `HealthResponse` made the contract circular — the DTO was declared by
  // hand, the handler was checked against it, and `AppType` then reported the hand-written type
  // back as if the server had proven it. Inferring here means the route says what it actually
  // sends, which is what lets the DTO be derived instead of maintained.
  // Availability has its own lifetime: even a cold/max-stale health read must not
  // await agent startup. Repository/config freshness below remains independently bounded.
  let backendChecks: Awaited<ReturnType<typeof detectEnvironment>> = [];
  let backendChecksAt = -Infinity;
  let backendChecksPending: Promise<void> | undefined;
  const readBackendChecks = () => {
    if (!backendChecksPending && Date.now() - backendChecksAt >= 5_000) {
      backendChecksPending = detectEnvironment().then(async (checks) => {
        const changed = JSON.stringify(checks) !== JSON.stringify(backendChecks);
        backendChecks = checks;
        if (!changed) return;
        // A cold snapshot may still be assembling with the previous checks. Let
        // it finish, then replace it and notify remote SSE readers as well as WS.
        await healthInFlight?.catch(() => {});
        await refreshHealth();
      })
        .catch(() => {})
        .finally(() => { backendChecksAt = Date.now(); backendChecksPending = undefined; });
    }
    return backendChecks;
  };
  const healthSnapshot = async () => {
    const [checks, repo, config, workspace] = await Promise.all([
      readBackendChecks(),
      getRepoInfo(bootRoot),
      loadConfig(bootRoot),
      workspaceSummary(),
    ]);
    // Additive fields only below — the pre-forge shape is the most
    // externally-depended-on JSON in the app (BACKWARD_COMPATIBILITY.md).
    const forge = resolveProjectForge(repo);
    const caps = capabilities();
    return {
      version,
      // Spread rather than `latestVersion: update?.latest`: an `undefined` VALUE is dropped by
      // JSON.stringify, so the key is absent on the wire — but writing it unconditionally types
      // the key as always-present, which is a shape no client ever receives. The contract schema
      // says `.optional()`, and contract-parity.test.ts holds the two together.
      ...(update?.latest !== undefined ? { latestVersion: update.latest } : {}),
      ...(deps.applicationUpdate ? { applicationUpdate: caps.localHandoff
        ? deps.applicationUpdate.snapshot()
        : { status: 'idle' as const, supported: false, message: 'Update this installation manually.' } } : {}),
      // Health is CORS-open and, in hosted mode, reachable off the loopback —
      // so any site/host that reads it would learn the developer's absolute
      // checkout path and username (#431). Local mode keeps the full path (the
      // protected bookmarklet shape); hosted/remote mode trims it to a basename.
      // The field is always present and a string, but under CEZ_REMOTE it is
      // no longer an absolute path. A hosted cockpit's paths are on a machine
      // the reader does not have anyway.
      repoRoot: caps.localHandoff ? bootRoot : basename(bootRoot),
      repo,
      checks,
      defaultRunner: config.defaultRunner,
      // Non-blocking: cached availability or null-until-warm — health must never pay a `gh`
      // shell-out (the bookmarklet aborts its port probe at 800 ms). See detectGithubCached.
      forge: forge ? { kind: forge.kind, ...(forge.detectCached() ?? {}) } : null,
      capabilities: caps,
      // Workspace enumeration (multi-project spec) — additive, id+name ONLY.
      // NEVER `projects[].root` here: health is the one CORS-open route, and
      // the repoRoot trim above exists precisely to keep absolute paths and
      // usernames away from cross-origin readers (#431) — per-project roots
      // would reintroduce that leak once per registered project. Absolute
      // roots live on the same-origin GET /api/projects instead. An
      // unreadable workspace degrades to `projects: []`.
      projects: workspace.projects,
      bootProject: workspace.bootProject,
    };
  };
  // ---- server-side health cache (stale-while-revalidate) -------------------
  // The snapshot still reads git and workspace state. Agent-CLI availability
  // probes have their own nonblocking cache above. Paying that on the browser's FIRST `GET /api/health` is
  // exactly the few-seconds-blank the cockpit showed at load. So on the live
  // server the snapshot is computed at the server's OWN pace: both the GET and
  // the WS `health` topic serve the cached value immediately and revalidate
  // behind the response, and the cache is pre-warmed at boot so that first
  // request lands on a warm value instead of the cold compute.
  const HEALTH_TTL_MS = 5_000;
  // The staleness CEILING, which is a different job from the TTL above. The TTL
  // decides how often a revalidation is kicked off; on its own it bounds nothing,
  // because the revalidation is fire-and-forget. While a cockpit holds the
  // `health` topic the publisher's interval keeps the cache warm and the two are
  // the same number — but the normal state of a background `cezar serve` is NO
  // subscriber, and then nothing refreshes the cache at all: the next `GET
  // /api/health`, an hour later, would answer with the boot pre-warm's payload
  // and only the request AFTER it would see the truth. That endpoint is the
  // bookmarklet contract (BACKWARD_COMPATIBILITY.md) and `repo.branch` going stale is
  // literally #369, so past this age correctness beats the latency win and the
  // read waits for the compute. `refreshHealth` dedupes, so waiting costs one.
  const HEALTH_MAX_STALE_MS = 60_000;
  /** Whatever `healthSnapshot` actually returns — see the note there. */
  type HealthPayload = Awaited<ReturnType<typeof healthSnapshot>>;
  let healthCache: { at: number; payload: HealthPayload; body: string } | undefined;
  let healthInFlight: Promise<HealthPayload> | undefined;
  // Set while the topic has a subscriber; a change a refresh detects is pushed
  // here (a noop when nobody is listening).
  let publishHealth: (data: unknown) => void = () => {};

  const refreshHealth = (): Promise<HealthPayload> => {
    // Dedupe: a GET's background revalidation and the topic's interval tick
    // share ONE repository/workspace compute rather than racing two.
    if (healthInFlight) return healthInFlight;
    healthInFlight = (async () => {
      try {
        const payload = await healthSnapshot();
        const body = JSON.stringify(payload);
        const changed = body !== healthCache?.body;
        healthCache = { at: Date.now(), payload, body };
        if (changed) {
          publishHealth(payload);
          workspaceEvents.emit('health', payload);
        } // only a real change reaches either transport
        return payload;
      } finally {
        healthInFlight = undefined;
      }
    })();
    return healthInFlight;
  };
  deps.applicationUpdate?.onStateChange?.(() => {
    healthCache = undefined;
    void refreshHealth();
  });

  // The read the GET and the topic snapshot share. On the live server (a hub is
  // injected) it answers from cache instantly and revalidates behind the
  // response; without a hub — a bare app in tests — there is no refresher
  // keeping a cache coherent, so it computes fresh, exactly as before.
  const readHealth = async (): Promise<HealthPayload> => {
    if (!deps.socketHub) return healthSnapshot();
    if (!healthCache) return refreshHealth(); // first ever: nothing to serve yet
    const age = Date.now() - healthCache.at;
    if (age > HEALTH_MAX_STALE_MS) return refreshHealth(); // too old to serve — wait for the truth
    if (age > HEALTH_TTL_MS) void refreshHealth(); // stale: refresh, don't wait on it
    return healthCache.payload;
  };

  // ---- chained family: health (workspace-level) ----------------------------
  // Written as ONE chained expression rather than a loose `app.get(...)`
  // statement because Hono accumulates its route types through the chain: a
  // statement's return value is discarded, so `typeof app` would record nothing
  // and `hc<AppType>` would have no endpoint to offer. `createApp` mounts this
  // under both `/api` (the frozen legacy spelling) and `/api/v1`.
  const healthRoutes = new Hono().get('/health', async (c) => c.json(await readHealth()));

  // The push twin of the poll it replaced (#369): while at least one cockpit
  // holds the `health` topic the server re-reads the snapshot on the old 5 s
  // cadence and broadcasts ONLY when it changed — a `git checkout` in a
  // terminal reaches every open tab within a tick — and an idle workspace (no
  // subscriber) runs no timer. Nothing server-side watches `.git/HEAD`, so the
  // interval stays the honest mechanism; it just lives behind the socket now
  // instead of N tabs × 5 s HTTP polls. Every tick and every subscriber read
  // goes through the cache above, so N subscribers still cost one compute.
  deps.socketHub?.registerTopic(
    'health',
    {
      snapshot: readHealth,
      start: (publish) => {
        publishHealth = publish;
        const timer = setInterval(() => void refreshHealth(), HEALTH_TTL_MS);
        timer.unref?.();
        return () => {
          clearInterval(timer);
          publishHealth = () => {};
        };
      },
    },
    // health IS the CORS-open discovery payload (#431), so it is the one topic
    // safe for any local page — including a cross-port page admitted by the
    // loopback fallback on a no-Sec-Fetch browser. Every other (future) topic
    // keeps the default: trusted connections only.
    { loopbackReadable: true },
  );
  // Pre-warm on the live-server path only (startServer injects the hub; a bare
  // app in tests does not, so tests never spawn the probes here): the cache
  // fills while the browser is still downloading the bundle, so its first
  // `GET /api/health` reads a warm value instead of the cold ~1 s compute.
  if (deps.socketHub) {
    void refreshHealth();
    void modelCatalog.get('cursor');
  }
  // Authenticated SSE carries completion to remote cockpits too. Reuse the HTTP
  // contract; no CLI output, paths or account data enter this payload.
  modelCatalog.onRefresh((result) => {
    if (result.runner === 'cursor') workspaceEvents.emit('model-catalog', result);
  });
  deps.socketHub?.registerTopic('models:cursor', {
    snapshot: async () => modelCatalog.getCached('cursor'),
    start: (publish) => {
      let previous = '';
      const off = modelCatalog.onRefresh((result) => {
        if (result.runner !== 'cursor') return;
        const body = JSON.stringify(result);
        if (body !== previous) { previous = body; publish(result); }
      });
      // Only active pickers keep discovery warm. Last unsubscribe stops all work.
      const timer = setInterval(() => { void modelCatalog.get('cursor'); }, 5 * 60_000);
      timer.unref?.();
      return () => { clearInterval(timer); off(); };
    },
  });
  /**
   * Warm the whole of cezar's agent knowledge — the three discovered defaults AND every extra
   * account — so no reader ever pays the first shell-out.
   *
   * Which login each agent is signed into is operating knowledge, not a settings-page detail: the
   * composer, the action gate, the accounts pane and every run resolution ask for it. So the server
   * learns it once, at boot, and keeps it (see the asymmetric cache lifetime in
   * `core/provider-auth.ts`); on-demand refresh rides on `?refresh=1` and on the explicit
   * invalidations — connect, repoint, remove, runtime rejection.
   *
   * Extra accounts are warmed ONE AT A TIME, after the defaults. Each is a CLI spawn, and a machine
   * with several accounts would otherwise fan out a spawn storm at exactly the moment the browser is
   * fetching the bundle; nothing is waiting on this, so sequential costs nothing that matters.
   *
   * Hosted mode warms only the defaults: the agent-profiles family is refused there, so there are
   * no accounts to learn about.
   */
  const warmAgentKnowledge = async (): Promise<void> => {
    await providerAuth.status().catch(() => {});
    if (!capabilities().localHandoff) return;
    const store = await loadAgentAccounts().catch(() => defaultAgentAccountStore());
    for (const account of listAgentProfiles(store, PROVIDER_IDS)) {
      if (account.isDefault) continue; // covered by `status()` above
      // Probing it would sign in or report on another folder (#1283); its status route says why.
      if (namedAccountUnavailable(account.provider, account.path) !== null) continue;
      await providerAuth
        .profileStatus(account.provider, { id: account.id, configDir: account.path })
        .catch(() => {});
    }
  };
  // Same gate as `refreshHealth`, same reason (startServer injects the hub; a bare app in tests does
  // not, so tests never spawn probes here). Fire-and-forget: a probe that fails leaves that row
  // cold, which is exactly the state every reader already handles.
  if (deps.socketHub) void warmAgentKnowledge();

  // ---- chained family: host model catalog (workspace-level) ----
  const modelsRoutes = new Hono<ProjectApiEnv>()
    // `modelDiscoveryRunnerSchema` is the contract's own list of the runners with an
    // authoritative host-local catalog (#794), so the client compiles against exactly what this
    // validates, including Claude stream-json discovery (#89).
    .get('/models', queryZodValidator(modelDiscoveryQuerySchema, { message: `runner must be ${MODEL_DISCOVERY_RUNNERS.slice(0, -1).join(', ')}, or ${MODEL_DISCOVERY_RUNNERS.at(-1)}` }), async (c) => {
      const query = { data: c.req.valid('query') };
      return c.json(query.data.runner === 'cursor'
        ? modelCatalog.getCached('cursor')
        : await modelCatalog.get(query.data.runner));
    });

  /**
   * Resolve `profileId` (absent = the discovered default) into a concrete account for `provider`.
   *
   * A dangling id is an ERROR here rather than the silent fall-back to the default that run
   * resolution performs. The difference is who is asking: a run is replaying a stored reference
   * and the default is the only safe answer it can act on, whereas a route is answering a user
   * who just named an account — telling them "unknown account" is honest, and quietly connecting
   * or reporting on a different one is not.
   */
  const resolveWorkspaceProfile = async (
    provider: ProviderId,
    profileId?: string,
  ): Promise<{ profile: ResolvedAgentProfile } | { error: string }> => {
    if (profileId === undefined || profileId === DEFAULT_AGENT_ACCOUNT_ID) {
      return { profile: defaultAgentProfile(provider) };
    }
    let accounts: readonly AgentAccount[];
    try {
      accounts = (await loadAgentAccounts()).accounts;
    } catch {
      return { error: `unknown ${provider} account: ${profileId}` };
    }
    const stored = accounts.find((a) => a.id === profileId && a.provider === provider);
    if (!stored) return { error: `unknown ${provider} account: ${profileId}` };
    return { profile: resolveStoredProfile(stored) };
  };

  /**
   * The environment a terminal handoff must carry so the CLI lands on the right account.
   *
   * `profileId` is the one RECORDED on the step that owns the session, never the project's
   * current selection: `claude --resume <id>` reads `<configDir>/sessions`, so a handoff for a
   * run started on the work account and resumed after the project was switched back would find
   * nothing and silently open a fresh conversation.
   */
  const handoffEnv = async (
    provider: ProviderId,
    profileId: string | undefined,
  ): Promise<{ env: Record<string, string> } | { error: string }> => {
    const resolved = await resolveWorkspaceProfile(provider, profileId);
    if ('error' in resolved) {
      return { error: `this session belongs to an account that no longer exists (${profileId})` };
    }
    const { profile } = resolved;
    if (profile.isDefault) return { env: {} };
    const unavailable = namedAccountUnavailable(provider, profile.path);
    return unavailable !== null ? { error: unavailable } : { env: profileEnv(provider, profile.path) };
  };

  /** The copy-paste fallback shown when no terminal could be opened — same account, spelled for
   *  this platform's shell. `null` when the dir cannot be embedded safely, which is a refusal. */
  const handoffFallbackCommand = (cwd: string, command: string, env: Record<string, string>): string | null => {
    const prefixed = withEnvPrefix(command, env, process.platform);
    return prefixed === null ? null : `cd '${cwd}' && ${prefixed}`;
  };

  /** A registered project's realpath'd root, or null when the id is unknown. */
  const projectRootFor = async (projectId: string): Promise<string | null> => {
    try {
      return (await loadWorkspaceConfig()).projects.find((p) => p.id === projectId)?.root ?? null;
    } catch {
      return null;
    }
  };

  // ---- chained family: agent providers (workspace-level) ----
  const providersRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/providers/status',
      queryZodValidator(strictRefreshQuerySchema, { message: 'refresh must be 1 when provided' }),
      async (c) => {
        const query = { data: c.req.valid('query') };
        const refresh = query.data.refresh === '1';
        if (refresh) {
          for (const runner of MODEL_DISCOVERY_RUNNERS) modelCatalog.invalidate(runner);
        }
        return c.json(await providerStatus({ refresh }));
      },
    )

    .put(
      '/providers/:provider/enabled',
      paramZodValidator(providerRouteParamsSchema, { message: 'provider and enabled boolean are required' }),
      jsonZodValidator(providerEnabledSchema, { message: 'provider and enabled boolean are required' }),
      async (c) => {
        const provider = { data: c.req.valid('param').provider };
        const body = { data: c.req.valid('json') };
        let workspace: WorkspaceConfig;
        try {
          workspace = await workspaceConfig.mergeWrite((config) => {
            const disabled = new Set(config.disabledProviders);
            if (body.data.enabled) disabled.delete(provider.data);
            else disabled.add(provider.data);
            config.disabledProviders = PROVIDER_IDS.filter((id) => disabled.has(id));
          });
        } catch {
          return c.json({ error: 'Provider preference could not be saved.' }, 500);
        }
        const result = applyProviderEnablement(
          await providerAuth.status(),
          workspace.disabledProviders,
        );
        const row = result.providers.find(({ provider: id }) => id === provider.data);
        if (row) workspaceEvents.emit('provider-status', row);
        return c.json(result);
      },
    )

    .post(
      '/providers/:provider/retry',
      paramZodValidator(providerRouteParamsSchema, { message: 'provider and current authFailureId are required' }),
      jsonZodValidator(providerRetrySchema, { message: 'provider and current authFailureId are required' }),
      async (c) => {
        const provider = { data: c.req.valid('param').provider };
        const body = { data: c.req.valid('json') };
        if (!providerAuth.clearRuntimeAuthFailure(provider.data, body.data.authFailureId)) {
          return c.json({ error: 'Authentication incident changed. Refresh and try again.' }, 409);
        }
        invalidateHostModels(provider.data);
        const result = await providerStatus({ refresh: true });
        const row = result.providers.find(({ provider: id }) => id === provider.data);
        if (row) workspaceEvents.emit('provider-status', row);
        return c.json(result);
      },
    )

    .post('/providers/connect', jsonZodValidator(providerConnectSchema, { message: 'provider must be claude, codex, opencode, pi, cursor, or omp' }), async (c) => {
      const body = { data: c.req.valid('json') };

      const provider = body.data.provider as ProviderId;
      // A NAMED account is refused in hosted mode before anything is resolved, exactly like every
      // sibling route in the agent-profiles family. Checking later would already have read
      // `~/.cezar/agent-accounts.json`, built a command carrying the account's absolute path (which
      // both the success body and the hosted 409 echo), and — for a stored account — spawned a
      // probe. It would also answer `unknown account: <id>` for a wrong id, which is an enumeration
      // oracle for the very ids the hosted listing withholds. The bare-provider spelling keeps its
      // existing behaviour: it names no host path and is how the Providers card has always worked.
      if (body.data.profileId !== undefined
        && body.data.profileId !== DEFAULT_AGENT_ACCOUNT_ID
        && !capabilities().localHandoff) {
        return c.json(hostedProfileRefusal, 409);
      }
      // Resolve the account BEFORE anything else: both the command and the status probe below
      // must describe the same one, or the pane reports on the personal login while the terminal
      // signs into the work login.
      const resolved = await resolveWorkspaceProfile(provider, body.data.profileId);
      if ('error' in resolved) return c.json({ error: resolved.error }, 400);
      const { profile } = resolved;
      // A login aimed at a folder the agent would not open signs in another account (#1283).
      const unavailable = profile.isDefault ? null : namedAccountUnavailable(provider, profile.path);
      if (unavailable !== null) return c.json({ error: unavailable }, 409);
      const command = providerAuth.loginCommand(provider, profile.isDefault ? null : profile.path);
      // Fail closed: a config dir that cannot be embedded safely in this platform's shell has no
      // safe degradation. Running the bare command would sign the user into a DIFFERENT account
      // than the one they clicked, and nothing in the terminal would say so.
      if (command === null) {
        return c.json({ error: `This account's folder cannot be used in a terminal command: ${profile.configDir}` }, 409);
      }
      // BOTH branches must mean "is this account signed in NOW". The default branch refreshes; the
      // account branch has to evict first, because `profileStatus` serves the per-account cache and
      // a connected answer there stands for CONNECTED_TTL_MS. Without this, Connect after a
      // `claude /logout` answers "already connected", opens nothing, and the user is stuck — and it
      // would contradict this module's own invariant that opening a login is one of the things
      // cezar CAN observe and therefore invalidates explicitly rather than waiting out a window.
      if (!profile.isDefault) providerAuth.forgetProfileStatus(provider, profile.id);
      const row = profile.isDefault
        ? (await providerAuth.status({ refresh: true })).providers.find(
          (candidate) => candidate.provider === provider,
        )
        : await providerAuth.profileStatus(provider, { id: profile.id, configDir: profile.path });
      if (!row) {
        return c.json({ error: 'Authentication could not be verified. Try again.' }, 500);
      }

      if (row.status === 'connected') {
        invalidateHostModels(provider);
        return c.json({ opened: false, connected: true, command });
      }
      if (row.status === 'not-installed') {
        return c.json({ error: row.hint ?? providerAuth.installHint(provider), command }, 409);
      }
      if (row.status === 'unknown') {
        return c.json({ error: row.hint ?? 'Authentication could not be verified. Try again.', command }, 409);
      }
      if (!capabilities().localHandoff) {
        return c.json({ error: 'Run this command on the machine hosting cezar.', command }, 409);
      }
      let opened = false;
      try {
        // No `env` argument: `loginCommand` already rendered the account's config dir INTO the
        // command, because this string is also the copy-paste fallback the pane shows. Passing
        // it again here would set the variable twice.
        opened = await openTerminal(bootRoot, command);
      } catch {
        // Terminal handoff is best-effort; the exact command remains the safe fallback.
      }
      if (!opened) {
        return c.json({ error: 'No terminal emulator could be opened. Run this command manually.', command }, 409);
      }
      invalidateHostModels(provider);
      return c.json({ opened: true, command });
    });

  // ---- chained family: agent profiles / accounts (workspace-level) ----------
  // Extra config dirs for a SECOND login of the same agent CLI (spec
  // 2026-07-29-agent-profiles). Workspace-level and therefore SINGLE-MOUNT: an account belongs to
  // the person and the machine, never to a repo, and a project-scoped spelling would be a second
  // surface to protect with no consumer. Which account a project uses is a field on
  // `PATCH /api/v1/projects/:projectId` instead.
  //
  // Writing is a LOCAL-MACHINE capability, exactly like `PUT /api/v1/agent-config/:id`: a profile
  // points an agent at a directory on the host, and the listing echoes absolute paths carrying
  // the username — the same disclosure `/api/v1/health` trims in hosted mode (#431).

  /**
   * This agent's own USER-scope config files, resolved inside ONE account's folder.
   *
   * Straight from the catalog — the single home of config-file vendor knowledge — with an
   * `AgentHomePaths` whose slot for this provider is the account's dir. That is what makes a second
   * login's `settings.json` the file you open rather than the default account's, and it keeps the
   * ids opaque and stable so the open route below never takes a path from the client.
   */
  const accountFiles = async (profile: ResolvedAgentProfile) => {
    const home: AgentHomePaths = {
      ...agentHomePaths(),
      ...(profile.provider === 'claude' ? { claude: profile.path } : {}),
      ...(profile.provider === 'codex' ? { codex: profile.path } : {}),
      ...(profile.provider === 'opencode' ? { opencodeConfig: profile.path } : {}),
      ...(profile.provider === 'pi' ? { pi: profile.path } : {}),
      // The discovered omp account is already an agent dir; a named one is a profile folder that
      // keeps its config in `agent/`.
      ...(profile.provider === 'omp' ? { omp: profile.isDefault ? profile.path : profileAgentDir('omp', profile.path) } : {}),
    };
    const defs = listConfigFiles().filter(
      (def) => def.scope === 'user' && def.runners.includes(profile.provider),
    );
    return Promise.all(
      defs.map(async (def) => {
        const path = def.resolve(bootRoot, home);
        return { id: def.id, label: basename(path), path, exists: (await statConfigPath(path)).exists };
      }),
    );
  };

  /** Build the wire row for one resolved profile: its dir state plus whatever auth is cached. */
  const agentProfileBody = async (profile: ResolvedAgentProfile) => ({
    id: profile.id,
    provider: profile.provider,
    label: profile.label,
    configDir: profile.configDir,
    path: profile.path,
    ...(await profileDirState(profile.provider, profile.path)),
    isDefault: profile.isDefault,
    // CACHED auth only — this listing must never pay a CLI spawn.
    //
    // Probing here cost a shell-out per provider PLUS one per extra account: ~0.7s with no extra
    // accounts and over 2s with a few, on every cold load, for a route whose real job (what
    // accounts exist) is a JSON read and a handful of stats. `GET /api/v1/health` already
    // established the rule — it serves whatever the cache holds and never pays a `gh` shell-out.
    // An absent `status` means "not determined yet", which the cockpit renders as Checking… and
    // then fills in from the per-account status route below.
    //
    // SPREAD, not `status: maybeUndefined`: hono would type the key as always-present while
    // `JSON.stringify` drops it, which is exactly the drift `contract-parity` catches (AGENTS.md
    // names this as one of the two recurring mismatches).
    ...(() => {
      const cached = profile.isDefault
        ? providerAuth.peekStatus()?.providers.find((row) => row.provider === profile.provider)
        : providerAuth.peekProfileStatus(profile.provider, profile.id);
      return cached ? { status: cached } : {};
    })(),
    files: await accountFiles(profile),
  });

  /**
   * Resolve `:id` to an account for the per-account reads below. Unlike `resolveWorkspaceProfile`
   * this accepts the reserved `default` for a NAMED provider, which these routes cannot infer — so
   * the id may be `default:<provider>` as well as a stored account id.
   */
  const accountById = async (id: string): Promise<ResolvedAgentProfile | null> => {
    const [head, tail] = id.split(':');
    if (head === DEFAULT_AGENT_ACCOUNT_ID) {
      const provider = PROVIDER_IDS.find((p) => p === tail);
      return provider ? defaultAgentProfile(provider) : null;
    }
    try {
      const stored = (await loadAgentAccounts()).accounts.find((a) => a.id === id);
      return stored ? resolveStoredProfile(stored) : null;
    } catch {
      return null;
    }
  };

  /** Validate a client-supplied config dir. Returns the error text, or null when it is usable. */
  const checkProfileDir = async (configDir: string, provider?: ProviderId): Promise<string | null> => {
    if (CONTROL_CHARS_RE.test(configDir)) return 'folder must not contain control characters';
    const expanded = expandTilde(configDir);
    // Absolute after expansion: a relative dir would resolve against whatever cwd the agent
    // happens to be spawned in, which for a task is a throwaway worktree. Through
    // `isAbsoluteConfigDir`, never a leading-`/` test — see its note: a string test refuses every
    // real Windows path, and this is the only gate the Add-account dialog has.
    if (!isAbsoluteConfigDir(expanded)) return `folder must be an absolute path: ${configDir}`;
    // An omp account is selected by profile NAME, so only a folder in omp's profiles dir can be one.
    if (provider === 'omp') return ompProfileDirError(expanded);
    return null;
  };

  /** Refuse a dir that is already some other account's (or the default's), compared through
   *  `realpath` — two spellings of one directory would be two accounts silently sharing one
   *  session store, and "which one am I logged into?" would stop having an answer. */
  const conflictingProfile = async (
    profiles: readonly AgentAccount[],
    provider: ProviderId,
    path: string,
    exceptId?: string,
  ): Promise<string | null> => {
    // Compared as agent dirs: the discovered omp account is one (a host `OMP_PROFILE=work` makes it
    // `…/profiles/work/agent`), while a named omp account is the profile folder holding it.
    if (await sameProfileDir(profileAgentDir(provider, path), defaultAgentProfile(provider).path)) {
      return 'that is already this agent\'s default folder';
    }
    for (const candidate of profiles) {
      if (candidate.provider !== provider || candidate.id === exceptId) continue;
      if (await sameProfileDir(path, expandTilde(candidate.configDir))) {
        return `that folder is already used by "${candidate.label || candidate.id}"`;
      }
    }
    return null;
  };

  const agentProfilesRoutes = new Hono<ProjectApiEnv>()
    .get('/workspace/agent-profiles', async (c) => {
      const editable = capabilities().localHandoff;
      // Hosted mode withholds the listing entirely rather than serving it read-only: the paths
      // are the host disclosure, so an empty list is the only honest hosted answer.
      //
      // ONE body object, never a hosted `return` and a local `return`: two returns let hono
      // narrow `editable` to the literal `false`/`true` of each branch, and the contract's
      // honest `z.boolean()` then reads as wider than the route. Same shape as
      // `listAgentConfig`, which carries the same flag for the same reason.
      let store = defaultAgentAccountStore();
      if (editable) {
        try {
          store = await loadAgentAccounts();
        } catch {
          // an unreadable home degrades to "no extra accounts", never a failed request
        }
      }
      const profiles = editable
        ? await Promise.all(listAgentProfiles(store, PROVIDER_IDS).map(agentProfileBody))
        : [];
      return c.json({
        editable,
        profiles,
        profileCapableProviders: [...PROFILE_CAPABLE_PROVIDERS],
        // Which account each project uses, keyed by repo root. Served here rather than on the
        // project registry because it lives in the same file as the accounts it names.
        selections: editable ? store.selections : {},
        /** The machine-wide fallback, for repos that have chosen nothing. Withheld in hosted mode
         *  on the same terms as the rest of this family. */
        defaults: editable ? store.defaults : {},
      });
    })

    .post('/workspace/agent-profiles', jsonZodValidator(() => createAgentProfileSchema), async (c) => {
      if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
      const { provider, configDir, label } = c.req.valid('json');
      if (!supportsProfiles(provider)) {
        return c.json({ error: `${provider} cannot carry more than one account` }, 400);
      }
      const dirError = await checkProfileDir(configDir, provider);
      if (dirError) return c.json({ error: dirError }, 400);

      // Read-first, exactly like `POST /projects`: the duplicate check needs `realpath`, and the
      // merge-write mutator is deliberately SYNCHRONOUS so the read→rename window stays as small
      // as it is for every other writer of this file. Two processes adding the same folder in
      // that window would both win — a cosmetic duplicate, not a correctness problem, since the
      // schema's id dedupe is what keeps resolution deterministic.
      let existing: readonly AgentAccount[] = [];
      try {
        existing = (await loadAgentAccounts()).accounts;
      } catch {
        // unreadable store — the merge-write below reports the real failure
      }
      const conflict = await conflictingProfile(existing, provider, expandTilde(configDir));
      if (conflict !== null) return c.json({ error: conflict }, 409);

      let created: AgentAccount | undefined;
      try {
        await mergeWriteAgentAccounts((store) => {
          const id = allocateAgentProfileId(label ?? configDir, store.accounts.map((a) => a.id));
          created = {
            id,
            provider,
            configDir,
            label: label?.trim() || id,
            addedAt: new Date().toISOString(),
          };
          store.accounts.push(created);
        });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      if (!created) return c.json({ error: 'account could not be saved' }, 500);
      // A brand-new account is the one thing the boot warm could not have known about, so learn it
      // now rather than only when something asks. Still off the response: the row is returned with
      // `status` absent (the listing's rule), the pane shows Checking…, and its follow-up request
      // joins this same in-flight probe.
      const account = resolveStoredProfile(created);
      const created201 = await agentProfileBody(account);
      void providerAuth
        .profileStatus(account.provider, { id: account.id, configDir: account.path })
        .catch(() => {});
      return c.json({ profile: created201 }, 201);
    })

    .patch(
      '/workspace/agent-profiles/:id',
      paramZodValidator(agentProfileRouteParamsSchema),
      jsonZodValidator(() => updateAgentProfileSchema),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const id = c.req.param('id');
        const { label, configDir } = c.req.valid('json');
        if (configDir !== undefined) {
          const dirError = await checkProfileDir(configDir);
          if (dirError) return c.json({ error: dirError }, 400);
        }

        // Read-first (see POST above, and `PATCH /projects`): a well-formed but unknown id must
        // 404 WITHOUT rewriting the config, and the duplicate check needs async `realpath`.
        let existing: readonly AgentAccount[] = [];
        try {
          existing = (await loadAgentAccounts()).accounts;
        } catch {
          // unreadable store — treated as unknown, like DELETE and PATCH /projects
        }
        const current = existing.find((a) => a.id === id);
        if (!current) return c.json({ error: `unknown account: ${id}` }, 404);
        if (configDir !== undefined) {
          // The provider's own folder rule needs the account, so it runs once the id is known.
          const dirError = await checkProfileDir(configDir, current.provider);
          if (dirError) return c.json({ error: dirError }, 400);
          const conflict = await conflictingProfile(existing, current.provider, expandTilde(configDir), id);
          if (conflict !== null) return c.json({ error: conflict }, 409);
        }

        let updated: AgentAccount | undefined;
        try {
          await mergeWriteAgentAccounts((store) => {
            const entry = store.accounts.find((a) => a.id === id);
            if (!entry) return; // lost a race with a concurrent delete — answered below
            // Mutated in place so `.passthrough()` keys on the row survive.
            if (label !== undefined) entry.label = label.trim() || entry.id;
            if (configDir !== undefined) entry.configDir = configDir;
            updated = entry;
          });
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        if (!updated) return c.json({ error: `unknown account: ${id}` }, 404);
        // The dir may have moved under a cached probe — drop THIS account's answer so the response
        // reports the new folder's state rather than the old one's, and leave every other account's
        // warm answer alone (it is still true). Then re-learn it in the background, so the server's
        // knowledge is complete again whether or not a cockpit is open to ask; the pane's own
        // request for this row joins the same in-flight probe rather than spawning a second.
        const repointed = resolveStoredProfile(updated);
        providerAuth.forgetProfileStatus(repointed.provider, repointed.id);
        const body = await agentProfileBody(repointed);
        void providerAuth
          .profileStatus(repointed.provider, { id: repointed.id, configDir: repointed.path })
          .catch(() => {});
        return c.json({ profile: body });
      },
    )

    /**
     * One account's authentication state, probed for real.
     *
     * Separate from the listing because a probe shells out to an agent CLI: keeping it here lets
     * the pane paint immediately and fill each row in as its answer lands, instead of every cold
     * load blocking on N spawns. `refresh=1` drops this account's cached answer and re-probes, for
     * the "Check again" affordance — the cache itself holds a connected answer for minutes and an
     * unsettled one for a minute (`cacheTtlFor` in `core/provider-auth.ts`).
     */
    .get(
      '/workspace/agent-profiles/:id/status',
      paramZodValidator(agentProfileRouteParamsSchema),
      queryZodValidator(strictRefreshQuerySchema, { message: 'refresh must be 1 when provided' }),
      async (c) => {
        // jscpd:ignore-start -- hearsay-tools/cezarion#1888: unchanged gate; only the validator arguments around it moved.
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const account = await accountById(c.req.param('id'));
        if (!account) return c.json({ error: `unknown account: ${c.req.param('id')}` }, 404);
        // jscpd:ignore-end
        const refresh = c.req.valid('query').refresh === '1';
        if (refresh) invalidateHostModels(account.provider);
        // The discovered account's row is the one `GET /api/v1/providers/status` owns, so it comes
        // from there — enablement included, which a bare probe does not know about.
        if (account.isDefault) {
          const all = await providerStatus(refresh ? { refresh: true } : undefined);
          const row = all.providers.find((candidate) => candidate.provider === account.provider);
          return c.json({ status: row ?? { provider: account.provider, status: 'unknown' as const } });
        }
        // A probe of an account the agent would not open reports on another folder (#1283), so the
        // row says why instead, without a spawn.
        const unavailable = namedAccountUnavailable(account.provider, account.path);
        if (unavailable !== null) {
          return c.json({ status: { provider: account.provider, status: 'unknown' as const, hint: unavailable, profileId: account.id } });
        }
        // "Check again" re-probes THIS account only — the other accounts' warm answers are not
        // invalidated by asking about this one.
        if (refresh) providerAuth.forgetProfileStatus(account.provider, account.id);
        return c.json({
          status: await providerAuth.profileStatus(account.provider, {
            id: account.id,
            configDir: account.path,
          }),
        });
      },
    )

    /**
     * Local-only account details, fetched separately on request. Keep identity out of normal
     * listings, logs and run persistence.
     */
    .get(
      '/workspace/agent-profiles/:id/details',
      paramZodValidator(agentProfileRouteParamsSchema),
      async (c) => {
        // jscpd:ignore-start -- hearsay-tools/cezarion#1888: unchanged gate; only the validator arguments around it moved.
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const account = await accountById(c.req.param('id'));
        if (!account) return c.json({ error: `unknown account: ${c.req.param('id')}` }, 404);
        // jscpd:ignore-end
        return c.json(await readAccountIdentity(account.provider, account.path));
      },
    )

    /**
     * Open one of this account's own config files — or its folder — in a local app.
     *
     * `file` is a catalog ID from the account's own `files`, never a path: the client cannot name a
     * location, so there is no traversal surface here at all (the same rule
     * `/api/v1/agent-config/:id` follows). `folder` is the one extra keyword, and it resolves to
     * the account's dir rather than anything the caller spelled.
     */
    .post(
      '/workspace/agent-profiles/:id/open',
      paramZodValidator(agentProfileRouteParamsSchema),
      jsonZodValidator(() => openAgentAccountFileSchema),
      async (c) => {
        // jscpd:ignore-start -- hearsay-tools/cezarion#1888: unchanged gate; only the validator arguments around it moved.
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const account = await accountById(c.req.param('id'));
        if (!account) return c.json({ error: `unknown account: ${c.req.param('id')}` }, 404);
        // jscpd:ignore-end
        const { file, target } = c.req.valid('json');

        let path: string;
        if (file === 'folder') {
          path = account.path;
        } else {
          const match = (await accountFiles(account)).find((f) => f.id === file);
          if (!match) return c.json({ error: `unknown file: ${file}` }, 404);
          path = match.path;
        }
        // A file the agent has not written yet has nothing to open; say so rather than hand the OS
        // a missing path and report success.
        if (!(await statConfigPath(path)).exists && file !== 'folder') {
          return c.json({ error: `this account has no ${basename(path)} yet` }, 409);
        }
        // `target` names a detected app; absent means the OS default handler. Either way the PATH
        // came from the catalog, so an editor is only ever pointed inside this account's folder.
        //
        // Which targets APPLY is checked here rather than left to the UI, because two of them are
        // actively wrong rather than merely useless: `terminal` runs `cd <path>`, which fails on a
        // file, and a `cli:<runner>` handoff would start an agent session inside the config folder.
        // A route is a surface of its own; it refuses what it cannot do correctly.
        if (target !== undefined) {
          if (agentCliRunner(target) !== null) {
            return c.json({ error: 'agent CLIs open a task worktree, not a config folder' }, 400);
          }
          if (target === 'terminal' && file !== 'folder') {
            return c.json({ error: 'a terminal opens a folder, not a file' }, 400);
          }
          if (!detectOpenTargets().some((candidate) => candidate.id === target)) {
            return c.json({ error: `no such app on this machine: ${target}` }, 400);
          }
        }
        const opened = target === undefined
          ? await openFile(path)
          : await openApp(target, path);
        if (!opened) return c.json({ error: `could not open ${basename(path)}`, path }, 409);
        return c.json({ opened: true as const, path });
      },
    )

    // Which account a PROJECT uses. On the accounts family rather than `PATCH /api/v1/projects`
    // because the selection is stored beside the accounts it names — one file, one atomic write,
    // and nothing about it can be dropped by a cezar version that never heard of accounts.
    .put(
      '/workspace/agent-profiles/selection',
      jsonZodValidator(() => selectAgentProfileSchema),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const { projectId, provider, profileId } = c.req.valid('json');
        // `null` writes the MACHINE-WIDE default instead of one repo's selection: the account any
        // repo that has chosen nothing uses, so a second login is set up once rather than per
        // checkout. No project to resolve, and therefore no 404 path.
        let root: string | null = null;
        if (projectId !== null) {
          const resolvedId = await workspaceProjects.canonicalProjectId(projectId);
          // Keyed by repo ROOT, so the selection survives the registry being rebuilt and needs no
          // cross-reference into config.json. An unknown project is a 404 rather than an orphan
          // entry nobody will ever read.
          root = await projectRootFor(resolvedId);
          if (root === null) return c.json({ error: `unknown project: ${projectId}` }, 404);
        }
        // A user naming an account that does not exist gets told so — the opposite of how RUN
        // resolution treats a dangling stored id, and deliberately: a run has no better answer
        // than the default, a person does.
        if (profileId !== null && profileId !== DEFAULT_AGENT_ACCOUNT_ID) {
          const account = await resolveWorkspaceProfile(provider, profileId);
          if ('error' in account) return c.json({ error: account.error }, 400);
        }
        let store: AgentAccountStore;
        try {
          store = await mergeWriteAgentAccounts((current) => {
            // One rule, two targets: the machine default is the same per-provider shape as a repo's
            // selection, so it clears the same way rather than growing its own spelling.
            const selection = root === null ? current.defaults : current.selections[root] ?? {};
            // `null` and the reserved `default` both mean "back to the discovered account", which
            // is stored as ABSENCE — the default id is never written to the file.
            if (profileId === null || profileId === DEFAULT_AGENT_ACCOUNT_ID) delete selection[provider];
            else selection[provider] = profileId;
            // The machine default keeps an emptied object where a repo selection is deleted, and
            // that asymmetry is the schema's, not an oversight: `defaults` is one FIXED field with
            // `.default(() => ({}))`, so `mergeWriteAgentAccounts` re-materializes it on the next
            // write no matter what this one omits (verified). `selections` is a growing MAP, where
            // an emptied entry is a row per repo ever touched that says nothing. The rule stated
            // for `agentDefaults.models` — "absence is the same answer" — applies there because
            // that key is `.optional()`, so deleting it actually sticks.
            if (root === null) current.defaults = selection;
            else if (Object.keys(selection).length === 0) delete current.selections[root];
            else current.selections[root] = selection;
          });
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        return c.json({ selections: store.selections, defaults: store.defaults });
      },
    )

    .delete(
      '/workspace/agent-profiles/:id',
      paramZodValidator(agentProfileRouteParamsSchema),
      async (c) => {
        if (!capabilities().localHandoff) return c.json(hostedProfileRefusal, 409);
        const id = c.req.param('id');
        let removed = false;
        // Captured inside the mutator, because after the write there is nothing left to ask which
        // provider this account belonged to — and the eviction below is keyed by it.
        let removedProvider: ProviderId | undefined;
        try {
          await mergeWriteAgentAccounts((store) => {
            const before = store.accounts.length;
            removedProvider = store.accounts.find((a) => a.id === id)?.provider;
            store.accounts = store.accounts.filter((a) => a.id !== id);
            removed = store.accounts.length < before;
            if (!removed) return;
            // Scrub every reference IN THE SAME MUTATOR — the reason selections share this file.
            // A two-call delete-then-scrub can be observed mid-way by another cezar process on
            // this machine, which would then resolve a dangling id; harmless today (it degrades
            // to the default) but only by luck.
            for (const [root, selection] of Object.entries(store.selections)) {
              for (const key of Object.keys(selection) as Array<keyof typeof selection>) {
                if (selection[key] === id) delete selection[key];
              }
              if (Object.keys(selection).length === 0) delete store.selections[root];
            }
          });
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        if (!removed) return c.json({ error: `unknown account: ${id}` }, 404);
        // Only this account's answer: it is about to stop existing, and holding it would let a
        // re-added account with the same id read the deleted one's state.
        providerAuth.forgetProfileStatus(removedProvider, id);
        return c.json({ removed: true as const, id });
      },
    );

  // ---- workspace projects (multi-project spec) -----------------------------
  // The registered-project list for the cockpit sidebar. Same-origin (unlike
  // health), so absolute `root`s are fine here. `listProjects()` TTL-caches
  // its per-root status/branch probes, so a burst of renders never shells git
  // N times. Never 404s: empty or unreadable registry → `projects: []`.
  /** The configured checkout root, as WRITTEN (`~` kept — callers that touch
   *  the filesystem expand it). An unreadable workspace degrades to the
   *  default rather than failing the request: every caller here is a route
   *  that must keep answering. */
  const workspaceProjectsDir = async (): Promise<string> => {
    try {
      return (await loadWorkspaceConfig()).projectsDir;
    } catch {
      return defaultWorkspaceConfig().projectsDir;
    }
  };

  const workspaceBrowseRoot = async (): Promise<string> => {
    try {
      return (await loadWorkspaceConfig()).browseRoot;
    } catch {
      return defaultWorkspaceConfig().browseRoot;
    }
  };

  // ---- chained family: project registry (workspace-level) ----
  const projectsRoutes = new Hono<ProjectApiEnv>()
    .get('/projects', async (c) => {
      let projects: ProjectListEntry[] = [];
      let projectsDir = defaultWorkspaceConfig().projectsDir;
      try {
        projectsDir = (await loadWorkspaceConfig()).projectsDir;
        projects = await workspaceProjects.listVisibleProjects();
      } catch {
        // unreadable workspace — degrade to the empty registry + defaults
      }
      const body: ProjectsResponse = {
        projects,
        bootProject: await resolveBootProject(projects),
        projectsDir,
      };
      return c.json(body);
    })

    .post('/projects', jsonZodValidator(() => registerProjectSchema, { message: 'root must be a non-empty path' }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const registered = await registerFolder(parsed.data.root, 'local');
      if (registered.status !== 200) return c.json(registered.body, registered.status);
      return c.json(registered.body, 200);
    })

    .delete('/projects/:projectId', async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('removing projects'), 409);
      }
      const raw = c.req.param('projectId');
      // Same gate the scoped-route resolver applies, and the same 404 wording —
      // a malformed id is an unknown project, not a validation essay.
      const resolved = await workspaceProjects.resolveProjectId(raw, true);
      if ('error' in resolved) return c.json(resolved, 404);
      // `default` is the boot alias everywhere else in the API; honour it here
      // too rather than 404ing a spelling the cockpit is allowed to use.
      const { id, bootId } = resolved;

      let entry: WorkspaceProject | undefined;
      try {
        entry = (await loadWorkspaceConfig()).projects.find((p) => p.id === id);
      } catch {
        // unreadable workspace — there is nothing to remove, and saying so is
        // more useful than a 500 the user cannot act on
      }
      if (!entry) return c.json({ error: `unknown project: ${id}` }, 404);

      // The boot project is refused, not removed: `cezar serve` re-registers the
      // repo it was started in on every boot, so "removing" it would undo itself
      // at the next restart while breaking this session's sidebar in the
      // meantime. The pane disables the button and says the same thing.
      if (id === bootId) {
        return c.json(
          {
            error: `cezar is serving ${entry.name} right now — it re-registers itself at every start, so it cannot be removed from here`,
          },
          409,
        );
      }

      // A background warm-up may be building this project right now: count its runs, and dispose
      // it, only once that build has landed (#667).
      await contexts.settle(id);
      const active = activeRunCount(id);
      if (active > 0) {
        return c.json(
          {
            error: `${entry.name} has ${active} running task${active === 1 ? '' : 's'} — cancel or finish ${active === 1 ? 'it' : 'them'} before removing the project`,
            runningTasks: active,
          },
          409,
        );
      }

      let removed: boolean;
      try {
        removed = await removeProject(id);
      } catch (err) {
        // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      // Lost a race with another writer (or another cezar process): the entry is
      // gone, which is what the caller wanted, but say it honestly.
      if (!removed) return c.json({ error: `unknown project: ${id}` }, 404);
      // In-process handles for a project no route can reach any more: store
      // closed (index flushed), manager's timers and usage subscription dropped.
      contexts.dispose(id);
      workspaceEvents.emit('project-removed', { id });
      const body: RemoveProjectResponse = { removed: true, id };
      return c.json(body);
    })

    // Edit the per-project registry fields the cockpit owns: the concurrency ceiling (spec
    // 2026-07-22-per-project-concurrency) and the grouping tags (spec
    // 2026-08-10-global-tasks-and-project-tags). A PATCH (not PUT) because it touches named
    // fields and leaves the rest of the entry alone, and a distinct route from POST
    // (register-a-folder) to keep register vs. edit semantics clear.
    //
    // The body schema is the CONTRACT's, passed directly rather than restated behind a thunk:
    // it is already in scope, and a second copy is a second thing to keep in step. Its bounds
    // mirror `workspaceProjectSchema` (config.ts) exactly, so a value this route accepts can
    // never be degraded away by the next load's `.catch`.
    //
    // Deliberately NOT the home of the agent-account selection: that lives in
    // `~/.cezar/agent-accounts.json` beside the accounts it names, so a cezar version that has
    // never heard of accounts cannot drop it (see workspace/agent-accounts.ts).
    .patch('/projects/:projectId', jsonZodValidator(updateProjectInputSchema), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('editing projects'), 409);
      }
      const raw = c.req.param('projectId');
      // Same gate + 404 wording as DELETE: a malformed id is an unknown project.
      const resolved = await workspaceProjects.resolveProjectId(raw);
      if ('error' in resolved) return c.json(resolved, 404);
      const parsed = { data: c.req.valid('json') };
      // `default` is the boot alias the cockpit is allowed to use everywhere else.
      const { id } = resolved;
      const { maxParallel, tags, webhook } = parsed.data;

      // Read-first (mirroring DELETE, server.ts:1252-1258): a well-formed but
      // unknown id must 404 WITHOUT rewriting the config — otherwise it would both
      // do a needless full-config tmp+rename and, on a read-only home, surface the
      // write failure as a 500 where the honest answer is 404.
      let known = false;
      try {
        known = (await loadWorkspaceConfig()).projects.some((p) => p.id === id);
      } catch {
        // unreadable workspace — treat as unknown; the read-only case answers 404,
        // not a 500 the caller cannot act on (same reasoning as DELETE).
      }
      if (!known) return c.json({ error: `unknown project: ${id}` }, 404);

      let updated: WorkspaceProject | undefined;
      try {
        await mergeWriteWorkspaceConfig((config) => {
          const entry = config.projects.find((p) => p.id === id);
          if (!entry) return; // lost a race with a concurrent remove — answered below
          // Each key is applied only when the body NAMED it: a PATCH that says
          // nothing about a field must leave it exactly as it was, which is what
          // keeps the tags editor from clearing a concurrency ceiling (and the
          // pre-tags `{ maxParallel }` body from clearing tags). null clears;
          // a value sets. Mutated in place so `.passthrough()` keys survive.
          if (maxParallel !== undefined) {
            if (maxParallel === null) delete entry.maxParallel;
            else entry.maxParallel = maxParallel;
          }
          if (tags !== undefined) {
            // Normalized on the way IN, so every reader — this API, the CLI, the
            // global Tasks page — sees one spelling per tag and never has to
            // fold case itself.
            const normalized = normalizeProjectTags(tags);
            if (normalized === undefined) delete entry.tags;
            else entry.tags = normalized;
          }
          if (webhook !== undefined) {
            // The token is write-only (#589): the form never has it back, so an omitted token
            // keeps the stored one and only `''` clears it. An omitted `triggers` keeps the stored
            // selection the same way, so a URL or token edit never resets it (#1356).
            // Since #1576 this edits the first webhook with task notifications on.
            applyTaskWebhookInput(entry, webhook);
          }
          updated = entry;
        });
      } catch (err) {
        // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      // Raced with a concurrent removal between the read and the write.
      if (!updated) return c.json({ error: `unknown project: ${id}` }, 404);

      // The new ceiling takes effect WITHOUT a restart: refresh the shared
      // semaphore's snapshot and pump every manager — the same live-apply hook
      // `PUT /api/workspace/config` fires for a workspace-cap change.
      await deps.semaphore?.refresh();
      const body: UpdateProjectResponse = {
        project: toProjectListEntry(updated, await probeProjectStatus(updated.root)),
      };
      return c.json(body);
    })

    // "Send test" (#589): one `task.test` delivery to the STORED webhook, now, with the timeout
    // the real deliveries use and no retries — the settings page wants the answer, not a queue.
    // Refused in single-project mode like every other registry edit route.
    .post('/projects/:projectId/webhook/test', async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('editing projects'), 409);
      }
      const raw = c.req.param('projectId');
      const entry = await workspaceProjects.resolveRegistryEntry(raw);
      if (!entry) return c.json({ error: `unknown project: ${raw}` }, 404);
      // Since #1576: the first webhook with task notifications on.
      const webhook = taskWebhookList(entry)[0];
      if (!webhook) return c.json({ error: NO_WEBHOOK_ERROR }, 400);
      const body: TestProjectWebhookResponse = await sendTestDelivery(entry.id, webhook);
      return c.json(body);
    })

    // ---- project webhooks (hearsay-tools/cezarion#1576) ----
    // Several webhooks per project, each with its own task-state selection and an explicit
    // "Expose to agents" switch. Registry edits like the PATCH above: refused in single-project
    // mode, 404 on an unknown project or webhook, and a write that names nothing else leaves the
    // rest of the entry alone. The first write stores `webhooks` and drops the old `webhook` key.
    .post('/projects/:projectId/webhooks', jsonZodValidator(createProjectWebhookInputSchema), async (c) => {
      const input = c.req.valid('json');
      const answer = await editProjectWebhooks(c.req.param('projectId'), (webhooks) => {
        if (webhooks.length >= PROJECT_WEBHOOKS_MAX) return { error: `a project holds at most ${PROJECT_WEBHOOKS_MAX} webhooks`, status: 409 };
        if (nameTaken(webhooks, input.name)) return { error: webhookNameTakenError(input.name), status: 409 };
        const webhook = createdWebhook(webhooks, input);
        return { webhooks: [...webhooks, webhook], webhook };
      });
      if ('error' in answer) return c.json({ error: answer.error }, answer.status);
      const body: ProjectWebhookResponse = answer.body;
      return c.json(body, 201);
    })

    .patch('/projects/:projectId/webhooks/:webhookId', paramZodValidator(projectWebhookParamsSchema), jsonZodValidator(updateProjectWebhookInputSchema), async (c) => {
      const { projectId, webhookId } = c.req.valid('param');
      const input = c.req.valid('json');
      const answer = await editProjectWebhooks(projectId, (webhooks) => {
        const index = webhooks.findIndex((webhook) => webhook.id === webhookId);
        if (index < 0) return { error: `unknown webhook: ${webhookId}`, status: 404 };
        if (input.name !== undefined && nameTaken(webhooks, input.name, webhookId)) return { error: webhookNameTakenError(input.name), status: 409 };
        const webhook = editedWebhook(webhooks[index]!, input);
        return { webhooks: webhooks.map((entry, at) => (at === index ? webhook : entry)), webhook };
      });
      if ('error' in answer) return c.json({ error: answer.error }, answer.status);
      const body: ProjectWebhookResponse = answer.body;
      return c.json(body);
    })

    .delete('/projects/:projectId/webhooks/:webhookId', paramZodValidator(projectWebhookParamsSchema), async (c) => {
      const { projectId, webhookId } = c.req.valid('param');
      const answer = await editProjectWebhooks(projectId, (webhooks) => {
        const webhook = webhooks.find((entry) => entry.id === webhookId);
        if (!webhook) return { error: `unknown webhook: ${webhookId}`, status: 404 };
        return { webhooks: webhooks.filter((entry) => entry !== webhook), webhook };
      });
      if ('error' in answer) return c.json({ error: answer.error }, answer.status);
      const project = answer.body.project;
      const body: UpdateProjectResponse = { project: defined({ ...project, webhook: project.webhook && defined(project.webhook) }) };
      return c.json(body);
    })

    // "Send test" for one webhook: one `task.test` delivery, now, no retries.
    .post('/projects/:projectId/webhooks/:webhookId/test', paramZodValidator(projectWebhookParamsSchema), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('editing projects'), 409);
      }
      const { projectId, webhookId } = c.req.valid('param');
      const entry = await workspaceProjects.resolveRegistryEntry(projectId);
      if (!entry) return c.json({ error: `unknown project: ${projectId}` }, 404);
      const webhook = projectWebhooks(entry).find((candidate) => candidate.id === webhookId);
      if (!webhook) return c.json({ error: `unknown webhook: ${webhookId}` }, 404);
      const body: TestProjectWebhookResponse = await sendTestDelivery(entry.id, webhook);
      return c.json(body);
    })

    .get('/projects/checkout/:checkoutId/progress', paramZodValidator(checkoutProgressParamsSchema), c => c.json({ progress: checkoutProgress.get(c.req.valid('param').checkoutId) }))

    .post('/projects/checkout', jsonZodValidator(() => checkoutSchema, { message: 'url must be a GitHub repository' }), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('adding projects'), 409);
      }
      const parsed = { data: c.req.valid('json') };
      const { url, name, checkoutId } = parsed.data;
      const result = await checkoutRepo({
        url,
        name,
        checkoutId,
        projectsDir: expandTilde(await workspaceProjectsDir()),
        onProgress: (event) => { checkoutProgress.record(event); workspaceEvents.emit('checkout-progress', event); },
        // A closed dialog / navigated-away tab aborts the request; the clone is
        // killed and its partial directory removed rather than left running.
        signal: c.req.raw.signal,
        ...(deps.cloneRunner ? { run: deps.cloneRunner } : {}),
      });
      if (!result.ok) {
        // `reason` rides along on the 503 (`gh` unavailable) — the spec's
        // `{ error, reason }` degradation, mirroring the GitHub pane.
        return c.json(
          'reason' in result ? { error: result.error, reason: result.reason } : { error: result.error },
          result.status,
        );
      }
      const registered = await registerFolder(result.target, 'checkout');
      if (registered.status !== 200) {
        // The clone SUCCEEDED and its files are legitimately the user's, so this
        // path deliberately does NOT clean up — an unregisterable checkout is a
        // registry problem, not a reason to delete a repo we just fetched. Say
        // where it is so they can register it by hand.
        const { body } = registered;
        const error = 'error' in body && body.error ? body.error : 'could not register the checkout';
        return c.json({ error: `${error} (the clone is at ${result.target})` }, registered.status);
      }
      return c.json(registered.body, 200);
    })

    // ---- new project (spec 2026-10-15-create-new-project) ------------------
    // "Add project → New project": a fresh git repo at `<projectsDir>/<name>`,
    // optionally backed by a new PRIVATE GitHub repository (never public — the
    // body has no visibility field to set), optionally from a template. Same
    // progress stream and cache, same `registerFolder` commit, same
    // `{ error, reason }` degradation as the clone route above.
    //
    // A hosted cockpit creates LOCAL projects only: GitHub creation would act
    // with the host's `gh` account on a remote viewer's behalf, and the owner
    // list would show that viewer the host's login and organisations.
    .get('/projects/github-owners', async (c) => {
      if (!capabilities().localHandoff) {
        const body: GithubOwnersResponse = { available: false, reason: HOSTED_GITHUB_OWNERS_REASON };
        return c.json(body);
      }
      return c.json(await listGithubOwners(deps.projectCommandRunner));
    })

    .post('/projects/create', jsonZodValidator(() => createProjectInputSchema, { message: 'project name must be a valid GitHub repository name — letters, digits, ".", "-" and "_" only, no spaces' }), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('adding projects'), 409);
      }
      const { name, github, checkoutId } = c.req.valid('json');
      if (github && !capabilities().localHandoff) {
        return c.json({ error: HOSTED_GITHUB_CREATE_REFUSAL }, 409);
      }
      const projectsDir = expandTilde(await workspaceProjectsDir());
      // `registerFolder` re-checks hosted containment, but only AFTER the
      // repository exists; asked here first, an out-of-root checkout root
      // refuses before anything is created.
      if (!capabilities().localHandoff && !(await isInsideHostedBrowseRoot(join(projectsDir, name)))) {
        return c.json({ error: 'folder is outside the browsable root' }, 400);
      }
      const result = await createProject({
        name,
        github,
        checkoutId,
        projectsDir,
        onProgress: (event) => { checkoutProgress.record(event); workspaceEvents.emit('checkout-progress', event); },
        // Cancels only the steps before `gh repo create` (create-project.ts).
        signal: c.req.raw.signal,
        ...(deps.projectCommandRunner ? { run: deps.projectCommandRunner } : {}),
      });
      if (!result.ok) {
        return c.json(
          'reason' in result ? { error: result.error, reason: result.reason } : { error: result.error },
          result.status,
        );
      }
      // GitHub-backed projects register as `checkout` (they have an origin the
      // clone flow would also produce); a local-only repo is `local`.
      const registered = await registerFolder(result.target, result.slug ? 'checkout' : 'local');
      // A new entry (200), or the existing one for the same root (409 "already registered") — what
      // creating a registered project whose folder had been deleted produces. The user asked for
      // that project and it is there, so both are a success. (An if/else chain, not a helper:
      // only narrowing `registered` keeps the error bodies out of the route's 200 type.)
      let project: CreateProjectResponse['project'];
      if (registered.status === 200) project = registered.body.project;
      else if (registered.status === 409 && 'project' in registered.body) project = registered.body.project;
      else {
        // As with a clone: the repository is the user's now, so it stays — and a GitHub warning
        // rides along, since its finishing commands are the only record of what is left to do.
        const { body } = registered;
        const error = 'error' in body && body.error ? body.error : 'could not register the new project';
        const warning = result.warning ? `\n${result.warning}` : '';
        return c.json({ error: `${error} (the project is at ${result.target})${warning}` }, registered.status);
      }
      const body: CreateProjectResponse = { project, ...(result.warning ? { warning: result.warning } : {}) };
      return c.json(body, 200);
    });

  /** Hosted containment for a path that may not exist yet: lexical for the
   *  path itself, realpath for its nearest existing ancestor (a symlink inside
   *  the browse root may point out of it). Same rule as `registerFolder`. */
  const isInsideHostedBrowseRoot = async (candidate: string): Promise<boolean> => {
    const browseRoot = resolveBrowseRoot(await workspaceBrowseRoot());
    if (!(await isLexicallyInsideBrowseRoot(browseRoot, candidate))) return false;
    let existing = candidate;
    while (!(await stat(existing).then(() => true, () => false))) {
      const parent = dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
    return isInsideBrowseRoot(browseRoot, existing);
  };

  // Register an existing folder (multi-project spec, "Add project" — the
  // folder-browser dialog's commit step, step 4.2). Workspace-level like its
  // GET twin. Everything here is a guard; the registry write itself is one
  // idempotent `registerProject` call.

  /**
   * The register-a-folder half of `POST /api/projects`, factored out so the
   * checkout route (step 4.3) commits its fresh clone through the SAME guards
   * and the same `project-added` emission rather than a second copy of them.
   * Returns the status + body for the caller to answer with.
   */
  const registerFolder = async (
    spelled: string,
    source: 'local' | 'checkout',
  ): Promise<
    // Discriminated on `status`, not one object with a union `body`: a flat
    // `{ status: 200 | 400 | 409 | 500; body: RegisterProjectResponse | { error } }` made
    // `c.json(body, status)` type the route's 200 as carrying the ERROR bodies too, which is a
    // shape neither POST route can answer with (`contract-parity.workspace.test.ts` pins it).
    // Split here so the success branch narrows at the call site instead.
    | { status: 200; body: RegisterProjectResponse }
    | { status: 400 | 409 | 500; body: RegisterProjectResponse | { error: string } }
  > => {
    if (capabilities().singleProject) {
      return { status: 409, body: singleProjectRefusal('adding projects') };
    }
    // `~` is expanded for the same reason `/api/fs/browse` expands it: the
    // dialog hands back absolute paths, but a hand-written body (curl, a
    // future CLI) spells home the way a shell does.
    const requested = expandTilde(spelled);
    if (!requested.startsWith('/')) {
      return {
        status: 400,
        body: { error: `not a folder: ${spelled} is not an absolute path` },
      };
    }
    // Hosted mode: the same root the picker is narrowed to, re-checked — see
    // `isInsideBrowseRoot`. Local mode deliberately has NO containment: a
    // project under `/srv/code` is a normal local setup and `cezar serve`
    // registers it today.
    //
    // Containment is asked in two halves, around the stat, and the split is
    // deliberate.
    //
    // The LEXICAL half runs BEFORE the stat, and that order is the security
    // property: an out-of-root path must answer the SAME way whether or not it
    // exists, or the route becomes the existence oracle fs-browse narrows the
    // tree to prevent. Lexical, not realpath, because a realpath check answers
    // `false` for a path that IS inside the root and merely absent — which
    // would tell a hosted user who typo'd a folder under their own checkout
    // root that it is "outside the browsable root".
    const hostedBrowseRoot = capabilities().localHandoff
      ? null
      : resolveBrowseRoot(await workspaceBrowseRoot());
    if (hostedBrowseRoot !== null) {
      if (!(await isLexicallyInsideBrowseRoot(hostedBrowseRoot, requested))) {
        // No resolved path in the message (fs-browse's rule): saying where the
        // root is would hand a remote viewer the layout the narrowing hides.
        return {
          status: 400,
          body: { error: 'folder is outside the browsable root' },
        };
      }
    }
    // Existence is checked HERE rather than left to `registerProject` (which
    // degrades a failed realpath to a plain resolve): a registry full of
    // `missing` rows the user never had is worse than a 400 they can act on.
    const info = await stat(requested).catch(() => null);
    if (!info?.isDirectory()) return { status: 400, body: { error: `no such folder: ${spelled}` } };
    // The REALPATH half, now that the path is known to exist: a symlink inside
    // the root pointing out of it spells as contained and is not. Same message
    // as the lexical rejection, so the two halves stay indistinguishable from
    // outside.
    if (hostedBrowseRoot !== null && !(await isInsideBrowseRoot(hostedBrowseRoot, requested))) {
      return {
        status: 400,
        body: { error: 'folder is outside the browsable root' },
      };
    }
    // The boot-time auto-registration guard, applied to the manual gesture
    // too: `$HOME` and cezar's own task worktrees are exactly as wrong a
    // project root when a human clicks "Add project" as when `cezar serve`
    // would have registered them. Reachable from the dialog, which starts at
    // `~` and can add the folder it is showing.
    if (!(await shouldRegisterProject(requested))) {
      return {
        status: 400,
        body: {
          error: `not a project folder: ${spelled} is your home directory or a cezar task worktree`,
        },
      };
    }
    // Asked BEFORE the write, because `registerProject` is idempotent and
    // cannot tell us afterwards whether it appended or just bumped
    // `lastOpenedAt`. Same realpath key the registry dedupes on.
    const real = await realpath(requested).catch(() => requested);
    let known = false;
    try {
      known = (await loadWorkspaceConfig()).projects.some((p) => p.root === real);
    } catch {
      // unreadable workspace — treat as unknown; the write below will fail loudly
    }
    let project: ProjectListEntry;
    try {
      const entry = await registerProject(requested, source);
      project = toProjectListEntry(entry, await probeProjectStatus(entry.root));
    } catch (err) {
      // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
    if (known) {
      // 409 with the EXISTING entry (spec): the dialog treats it as "you
      // already have this one" and navigates there rather than dead-ending.
      return {
        status: 409,
        body: { project, error: `already registered as ${project.id}` },
      };
    }
    // Only a genuinely new project is an event — a re-add is a no-op for every
    // open cockpit's sidebar.
    workspaceEvents.emit('project-added', { project });
    return { status: 200, body: { project } };
  };

  // Deregister a project (multi-project spec, step 4.4 — Settings → Projects,
  // the per-row "Remove"). READ THIS BEFORE TOUCHING THE HANDLER: the ONLY
  // durable effect allowed here is dropping one entry from
  // `~/.cezar/config.json`. There is deliberately no `rm`, no `rmdir`, no
  // `RunStore.open` (which would `mkdir` `<root>/.ai/cezar/runs` and therefore
  // WRITE into a folder the user just asked us to forget) anywhere below —
  // `removeProject` is a registry filter and `contexts.dispose` only tears down
  // in-process handles. Re-registering the same root later finds every task,
  // worktree and transcript exactly where it was. The confirmation copy in the
  // cockpit promises precisely this; the promise is kept here.
  //
  // A run this server is responsible for blocks the removal with a 409 (spec):
  // deregistering mid-run would strand a live agent process under a root no
  // route can resolve any more — the run would keep burning tokens with no
  // cockpit able to show, message or cancel it.
  const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running', 'waiting']);

  /**
   * How many of `projectId`'s runs this process is actively responsible for.
   *
   * Counted from the ALREADY-BUILT context only (`peek`, never `context()`):
   * a project with no context in this process has no manager, therefore no
   * agent to strand — and building one to answer the question would recover
   * and resume runs on a project being deleted, which is the exact opposite of
   * what the caller asked for. Reading the run index off disk instead was
   * rejected for the same reason as the `rm` above: `RunStore.open` creates
   * directories, and a stale `running` row left by a crashed process would
   * become a 409 the user could never clear.
   */
  const activeRunCount = (projectId: string): number => {
    const ctx = contexts.peek(projectId);
    if (!ctx) return 0;
    return ctx.store.listRuns().filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length;
  };

  // Workspace-level, server-selected target and executable. The empty JSON body is strict.
  const applicationUpdateRoutes = new Hono()
    .post('/workspace/application-update/apply', jsonZodValidator(applicationUpdateInputSchema), async (c) => {
      if (!capabilities().localHandoff) return c.json({ error: 'Application updates require a local cockpit.' }, 409);
      if (!deps.applicationUpdate) return c.json({ error: 'Application update is unavailable.' }, 409);
      try { return c.json({ state: await deps.applicationUpdate.apply() }); }
      catch (error) { return c.json({ error: error instanceof ApplicationUpdateConflictError || error instanceof ApplicationUpdateFailureError ? error.message : 'Application update preparation failed.' }, error instanceof ApplicationUpdateConflictError ? 409 : error instanceof ApplicationUpdateFailureError ? error.status : 500); }
    })
    .post('/workspace/application-update/restart', jsonZodValidator(applicationUpdateInputSchema), async (c) => {
      if (!capabilities().localHandoff) return c.json({ error: 'Application updates require a local cockpit.' }, 409);
      if (!deps.applicationUpdate) return c.json({ error: 'Application update is unavailable.' }, 409);
      try { return c.json({ state: await deps.applicationUpdate.restart() }); }
      catch (error) { return c.json({ error: error instanceof ApplicationUpdateConflictError ? error.message : 'Application restart is unavailable.' }, error instanceof ApplicationUpdateConflictError ? 409 : 500); }
    });

  // ---- GUI clone (multi-project spec, step 4.3) ----------------------------
  // "Add project → Clone from GitHub": clone into the checkout root, then
  // register the result through `registerFolder` above (same guards, same
  // `project-added`). Everything dangerous — where the clone may land, and
  // what a failed clone is allowed to delete — lives in src/server/checkout.ts.
  //
  // Long-running by design (the spec's contract): the response lands when the
  // clone finishes, and the dialog's liveness comes from `checkout-progress`
  // events on the workspace stream. `checkoutId` is the cockpit's own
  // correlation token, echoed on every event so two tabs cloning at once never
  // render each other's progress.

  // ---- workspace settings (multi-project spec, step 2.7) -------------------
  // WORKSPACE-level routes: single-mount (never mirrored under /api/p/),
  // same-origin. The config routes carry the settings UI's slice of
  // `~/.cezar/config.json` — global knobs only; the registry stays on
  // /api/projects above, and schemaVersion (a migration cursor, not a
  // setting) is deliberately omitted.
  const workspaceConfigBody = (config: WorkspaceConfig): WorkspaceConfigResponse => ({
    browseRoot: config.browseRoot,
    projectsDir: config.projectsDir,
    archiveOnMerge: config.archiveOnMerge ?? null,
    effectiveArchiveOnMerge: resolveGlobalArchiveOnMerge(config).enabled,
    archiveOnMergeSource: resolveGlobalArchiveOnMerge(config).source,
    composerDefaults: {
      autonomous: config.composerDefaults.autonomous ?? null,
      worktree: config.composerDefaults.worktree ?? null,
      inheritedAutonomous:
        process.env.CEZ_AUTONOMOUS_DEFAULT === '0'
          ? false
          : process.env.CEZ_AUTONOMOUS_DEFAULT === '1'
            ? true
            : 'source-dependent',
      inheritedWorktree: effectiveComposerDefault(
        undefined,
        process.env.CEZ_WORKTREE_DEFAULT,
        true,
      ),
    },
    resources: {
      maxParallel: config.resources.maxParallel,
      maxMonitoringSessions: config.resources.maxMonitoringSessions,
      monitoringWakeIntervalMinutes: config.resources.monitoringWakeIntervalMinutes,
      autoResumeOnUsageLimit: config.resources.autoResumeOnUsageLimit,
      memoryLimitMb: config.resources.memoryLimitMb,
      worktreeRetentionDefault: config.resources.worktreeRetentionDefault,
    },
    // SPREAD, never `runner: maybeUndefined`: hono would type the key as always-present while
    // `JSON.stringify` drops it, which is the exact drift `contract-parity` catches. And absent has
    // to keep meaning "no opinion" here, or the fallback collapses into "always claude".
    agentDefaults: {
      ...(config.agentDefaults.runner !== undefined ? { runner: config.agentDefaults.runner } : {}),
      ...(config.agentDefaults.models !== undefined ? { models: config.agentDefaults.models } : {}),
    },
  });
  // ---- chained family: workspace settings + GUI prefs (workspace-level) ----
  const workspaceConfigRoutes = new Hono<ProjectApiEnv>()
    .get('/workspace/config', async (c) => c.json(workspaceConfigBody(await loadWorkspaceConfig())))

    .put('/workspace/config', jsonZodValidator(() => workspaceConfigUpdateSchema), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const { browseRoot, projectsDir, archiveOnMerge, composerDefaults, resources, agentDefaults } = parsed.data;
      for (const [configuredRoot, create] of [
        [browseRoot, false],
        [projectsDir, true],
      ] as const) {
        if (configuredRoot === undefined) continue;
        // Validated ON CHANGE, never at load (spec): browse roots must already
        // exist; checkout roots use `mkdir -p`. Both get a real write probe.
        // Any failure → 400 and NO change persisted.
        const expanded = expandTilde(configuredRoot);
        if (!expanded.startsWith('/')) {
          return c.json({ error: `not writable: ${configuredRoot} is not an absolute path` }, 400);
        }
        if (!create) {
          try {
            if (!(await stat(expanded)).isDirectory()) {
              return c.json({ error: `browse folder is not a directory: ${configuredRoot}` }, 400);
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              return c.json({ error: `browse folder does not exist: ${configuredRoot}` }, 400);
            }
            return c.json({ error: `browse folder unavailable: ${err instanceof Error ? err.message : String(err)}` }, 400);
          }
        }
        const probeError = await probeWritableDir(expanded, create);
        if (probeError !== null) return c.json({ error: `not writable: ${probeError}` }, 400);
      }
      let written: WorkspaceConfig;
      try {
        written = await mergeWriteWorkspaceConfig((config) => {
          // Roots are stored as written (`~` kept); only the probe expands them.
          if (browseRoot !== undefined) config.browseRoot = browseRoot;
          if (projectsDir !== undefined) config.projectsDir = projectsDir;
          if (archiveOnMerge === null) delete config.archiveOnMerge;
          else if (archiveOnMerge !== undefined) config.archiveOnMerge = archiveOnMerge;
          if (composerDefaults?.autonomous === null) delete config.composerDefaults.autonomous;
          else if (composerDefaults?.autonomous !== undefined) {
            config.composerDefaults.autonomous = composerDefaults.autonomous;
          }
          if (composerDefaults?.worktree === null) delete config.composerDefaults.worktree;
          else if (composerDefaults?.worktree !== undefined) {
            config.composerDefaults.worktree = composerDefaults.worktree;
          }
          if (resources?.maxParallel !== undefined) config.resources.maxParallel = resources.maxParallel;
          if (resources?.maxMonitoringSessions !== undefined) {
            config.resources.maxMonitoringSessions = resources.maxMonitoringSessions;
          }
          if (resources?.monitoringWakeIntervalMinutes !== undefined) {
            config.resources.monitoringWakeIntervalMinutes = resources.monitoringWakeIntervalMinutes;
          }
          if (resources?.autoResumeOnUsageLimit !== undefined) {
            config.resources.autoResumeOnUsageLimit = resources.autoResumeOnUsageLimit;
          }
          if (resources?.memoryLimitMb !== undefined) config.resources.memoryLimitMb = resources.memoryLimitMb;
          if (resources?.worktreeRetentionDefault !== undefined) {
            config.resources.worktreeRetentionDefault = resources.worktreeRetentionDefault;
          }
          // `null` CLEARS back to "no opinion" — a partial patch cannot say that by omission,
          // and leaving a stale runner behind would keep overriding repos that never chose.
          if (agentDefaults?.runner === null) delete config.agentDefaults.runner;
          else if (agentDefaults?.runner !== undefined) config.agentDefaults.runner = agentDefaults.runner;
          for (const runner of PROVIDER_IDS) {
            const model = agentDefaults?.models?.[runner];
            if (model === undefined) continue;
            const models = config.agentDefaults.models ?? {};
            if (model === null) delete models[runner];
            else models[runner] = model;
            // An empty object would persist a key that says nothing; absence is the same answer.
            if (Object.keys(models).length === 0) delete config.agentDefaults.models;
            else config.agentDefaults.models = models;
          }
        });
      } catch (err) {
        // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      if (archiveOnMerge !== undefined) deps.archiveOnMergeChanged?.();
      // A resource change takes effect WITHOUT a restart: refresh the shared
      // semaphore's in-memory snapshot and pump every manager (step 2.5's hook).
      if (resources !== undefined) await deps.semaphore?.refresh();
      return c.json(workspaceConfigBody(written));
    })

    // Global GUI state (`~/.cezar/ui-state.json`) — same parse/key-cap/shallow-
    // merge semantics as the per-repo /api/v1/ui-state route below (the shared half
    // is `uiStateBodySchema`), but backed by the workspace file.
    .get('/workspace/ui-state', async (c) => c.json(await readWorkspaceUiState()))

    // The tighter body cap rides on `use` rather than inline on the route: `bodyLimit` is typed
    // as a bare MiddlewareHandler, and passing one to `.put()` collapses the route's schema, so
    // the PUT went missing from `AppType` and `hc` could not see its body at all. `use` runs at
    // the same point (before the handler, so the cap still precedes any read) and leaves the
    // chain's type accumulation alone. Method-agnostic here, which the GET does not mind.
    .use('/workspace/ui-state', bodyLimit({ maxSize: UI_STATE_BODY_LIMIT }))

    .put('/workspace/ui-state', jsonZodValidator(setWorkspaceUiStateInputSchema), async (c) => {
      const parsed = { data: c.req.valid('json') };
      try {
        return c.json(
          await mergeWriteWorkspaceUiState((state) => ({
            ...state,
            ...parsed.data,
          })),
        );
      } catch (err) {
        // A read-only home degrades to an unsaved pref, never a crash.
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    });

  // Partial updates only — absent keys stay untouched. Bounds mirror the
  // workspace schema (src/workspace/config.ts, step 1.2) exactly, so a value
  // this route accepts can never be degraded away by the next load's `.catch`.

  // ---- chained family: filesystem browse (workspace-level) ----
  const fsBrowseRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/fs/browse',
      queryZodValidator(browseQuerySchema),
      async (c) => {
        if (capabilities().singleProject) {
          return c.json(singleProjectRefusal('folder browsing'), 409);
        }
        const query = c.req.valid('query');
        const root = resolveBrowseRoot(await workspaceBrowseRoot());
        const result = await browseDirectory({
          root,
          path: query.path,
          showHidden: query.showHidden === '1',
        });
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.body);
      },
    );

  // ---- chained family: launch-key (project-scoped) ----
  const launchKeyRoutes = new Hono<ProjectApiEnv>()
    .get('/launch-key', (c) => c.json({ key: c.get('project').launchKey }));

  // ---- chained family: skills (project-scoped) ----
  const skillsRoutes = new Hono<ProjectApiEnv>()
    .get('/skills', queryZodValidator(waitQuery), async (c) => {
      const repoRoot = c.get('project').root;
      // The default read stays fast and starts the team load in the background.
      // The cockpit follows it with `wait=1`, off the render path, so a cold
      // cache converges without polling or a manual reload (spec 005 / #555).
      if (c.req.valid('query').wait === '1') await waitForTeamSkills(repoRoot);
      return c.json(await discoverSkills(repoRoot, { builtin: builtinSkillsOf(c.get('project').manager) }));
    })

    // Every team skill the configured sources offer, including those this project switched
    // off, so the Skills catalog can show each with its toggle: one entry per source copy, so a
    // name two sources offer comes twice (#1494). Empty without `skillsRepos`.
    // `wait=1` lets the panel wait out a cold team-skill cache, same as `GET /skills` (spec 005).
    .get('/skills/importable', queryZodValidator(waitQuery), async (c) => {
      const repoRoot = c.get('project').root;
      if (c.req.valid('query').wait === '1') await waitForTeamSkills(repoRoot);
      return c.json(getTeamSkillsCached(repoRoot));
    })

    // Refresh team skills (spec 005): clone/fetch the configured skills repos,
    // then return the merged catalog. Degrades quietly — offline just means the
    // team entries stay as they were (or absent).
    .post('/skills/refresh', async (c) => {
      const { root: repoRoot } = c.get('project');
      await refreshTeamSkills(repoRoot);
      return c.json(await discoverSkills(repoRoot, { builtin: builtinSkillsOf(c.get('project').manager) }));
    });

  // ---- chained family: GUI prefs / ui-state (project-scoped) ----
  const uiStateRoutes = new Hono<ProjectApiEnv>()
    .get('/ui-state', async (c) => c.json(await readUiState(c.get('project').root)))

    // On `use`, not inline on the route — see the workspace ui-state PUT above.
    .use('/ui-state', bodyLimit({ maxSize: UI_STATE_BODY_LIMIT }))

    .put('/ui-state', jsonZodValidator(uiStateBody), async (c) => {
      const { root: repoRoot, dataDir } = c.get('project');
      // `.passthrough()` keeps unknown prefs (BACKWARD_COMPATIBILITY.md), but a
      // single request may not stuff an unbounded key set (#429) — the shared
      // schema+cap half of both ui-state routes lives in `uiStateBody`.
      const parsed = { data: c.req.valid('json') };
      const merged = { ...(await readProjectUiState(repoRoot)), ...parsed.data };
      try {
        await mkdir(dataDir, { recursive: true });
        await writeProjectUiState(repoRoot, merged);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return c.json(merged);
    });

  // ---- chained family: workflows (project-scoped) --------------------------
  // One chained expression, mounted by `createApp` into BOTH the legacy `api`
  // table and the versioned `v1` one — see `healthRoutes` for why the chain
  // shape (not the statement shape) is what carries the types.
  const workflowsRoutes = new Hono<ProjectApiEnv>()
    .get('/workflows', async (c) => c.json(await loadWorkflows(c.get('project').root)))

    // Save an approved plan as a reusable chain (spec 008): YAML in
    // `.ai/cezar/workflows/<slug>.yaml` — from then on it's in the dropdown
    // like any other workflow.
    .post('/workflows', jsonZodValidator(saveWorkflowSchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const steps = parsed.data.steps ?? skillsToSteps(parsed.data.skills ?? []);
      const issue = stepsIssue(steps);
      if (issue) return c.json({ error: issue }, 400);
      const slug = slugify(parsed.data.name) || 'chain';
      const dir = join(repoRoot, WORKFLOWS_DIR);
      const path = join(dir, `${slug}.yaml`);
      // Pure skill stacks are written in the portable compact form (spec 012) —
      // `name` + `skills:` — so the file imports cleanly in any repo.
      const stack = skillStackOf(steps);
      const doc = {
        name: parsed.data.name,
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        ...(stack ? { skills: stack } : { steps }),
      };
      try {
        await mkdir(dir, { recursive: true });
        // `wx` = fail if the file exists — no silent overwrite of a chain.
        await writeFile(path, stringifyYaml(doc), {
          encoding: 'utf8',
          flag: parsed.data.overwrite ? 'w' : 'wx',
        });
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
          return c.json({ error: `workflow file already exists: ${path}`, exists: true }, 409);
        }
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 500);
      }
      return c.json({ path, name: parsed.data.name }, 201);
    })

    // Delete a saved workflow (spec 012 follow-up): file workflows only —
    // built-ins have no file and always come back.
    .delete('/workflows/:name', async (c) => {
      const { root: repoRoot } = c.get('project');
      const name = c.req.param('name');
      const { workflows } = await loadWorkflows(repoRoot);
      const wf = workflows.find((w) => w.name === name);
      if (!wf) return c.json({ error: `unknown workflow: ${name}` }, 404);
      if (wf.source !== 'file' || !wf.path) {
        return c.json({ error: 'built-in workflows cannot be deleted' }, 400);
      }
      const dir = resolve(repoRoot, WORKFLOWS_DIR);
      const target = resolve(wf.path);
      if (!target.startsWith(dir + sep)) {
        return c.json({ error: 'refusing to delete a file outside the workflows dir' }, 400);
      }
      try {
        await unlink(target);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return c.json({ ok: true, path: target });
    })

    // Import support for the builder (spec 012): parse + validate a pasted
    // workflow YAML (either form) and hand back the normalized definition. The
    // server owns YAML parsing — the GUI stays dependency-free.
    .post('/workflows/parse', jsonZodValidator(parseWorkflowSchema), async (c) => {
      const parsed = { data: c.req.valid('json') };
      let raw: unknown;
      try {
        raw = parseYaml(parsed.data.yaml);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `not valid YAML: ${message}` }, 400);
      }
      const doc = workflowFileSchema.safeParse(raw);
      if (!doc.success) {
        return c.json({ error: doc.error.issues.map((i) => i.message).join('; ') }, 400);
      }
      const normalized = normalizeWorkflowDoc(doc.data);
      const issue = stepsIssue(normalized.steps);
      if (issue) return c.json({ error: issue }, 400);
      return c.json(normalized);
    });

  // ---- chained family: plan (project-scoped) ----
  const planRoutes = new Hono<ProjectApiEnv>()
    .post('/plan', jsonZodValidator(planSchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const blocked = await providerActionError([(await loadConfig(repoRoot)).defaultRunner]);
      if (blocked) return c.json({ error: blocked }, 409);
      return c.json(await planChain(repoRoot, parsed.data.task, builtinSkillsOf(c.get('project').manager)));
    });

  // ---- GitHub automations --------------------------------------------------

  /**
   * One manual "test filter" check, in server memory only.
   *
   * Declared here rather than inferred from `contract/src/automations.ts`: the contract's
   * `automationCheckSchema` is checked against what this route ANSWERS
   * (`contract-parity.automations.test.ts`), and a schema that annotated the handler it is
   * compared with would be true by construction.
   */
  type ManualCheck = {
    id: string;
    automationId: string;
    mode: 'preview' | 'execute';
    status: 'queued' | 'running' | 'complete' | 'error';
    createdAt: string;
    completedAt?: string;
    matches?: number;
    truncated?: boolean;
    error?: string;
  };
  const manualChecks = new Map<string, ManualCheck>();

  /**
   * The automations gate (#801): with `CEZ_AUTOMATIONS` unset, every route of the feature
   * answers 409 before touching a store, a lease or GitHub.
   *
   * Written as MIDDLEWARE rather than a line in each handler so the family cannot drift: a route
   * added to either chain below inherits the gate from its path, where a per-handler check is one
   * omission away from an ungated endpoint.
   *
   * Registered against EXPLICIT paths, never `use('*')`. Both chains are mounted with
   * `.route('/', …)` alongside a dozen unrelated sub-apps, and `route()` re-registers a sub-app's
   * middleware under the mount prefix — so a `'*'` here would gate the entire `/api/v1` surface,
   * including `/health`. The two-line pairing (`/automations` and `/automations/*`) is what makes
   * a path match both the collection and everything under it.
   */
  const requireAutomations = async (c: Context, next: Next) => {
    if (!capabilities().automations) return c.json({ error: AUTOMATIONS_OFF }, 409);
    await next();
  };

  /** The schedule runner for a route's project: launches into that project's own run manager. */
  const scheduleHandle = (project: ProjectContext): ScheduleRunnerHandle => {
    const timeZone = localTimeZone();
    return {
      projectId: project.id,
      store: project.automationStore,
      timeZone,
      launch: (definition, occurrence, receiptId) => launchScheduledRun({
        root: project.root,
        manager: project.manager,
        store: project.store,
        definition,
        occurrence,
        receiptId,
        projectName: basename(project.root),
        timeZone,
      }),
      onChange: (automationId, revision) => emitAutomationChange(project, automationId, revision),
      // A route's write settles a crash-left reservation first, as the timer does (#1465).
      reconcile: async () => { reconcileAutomationReceipts(project.automationStore, project.store); },
    };
  };

  /** The automations family's behavior, shared with the session tools (#1465). */
  const automationService = createAutomationService({
    timeZone: localTimeZone,
    discovery: { models: modelCatalog, providers: () => providerStatus() },
    scheduleHandle: (project) => scheduleHandle(project as ProjectContext),
    emitChange: (project, automationId, revision, deleted) => emitAutomationChange(project as ProjectContext, automationId, revision, deleted),
    changed: automationsChanged,
    // Awaits the driver's settled probe (per-repo cache + in-flight dedupe, 5 s timeout, never
    // throws): a "still being checked" answer would leave the cockpit's GitHub option disabled
    // because it does not refetch when the probe completes. `/health` keeps `detectCached`.
    githubAvailability: async (root) => {
      const forge = resolveProjectForge(await getRepoInfo(root));
      return forge ? forge.detect() : { available: false, reason: 'No GitHub remote is configured' };
    },
    hasGithubRemote: async (root) => Boolean(resolveProjectForge(await getRepoInfo(root))),
  });
  // #1465: every project's manager gets the schedule tools over this service. A manager reads
  // them at call time, so a session recovered before its project's context finished building
  // reaches them once this runs. The tools themselves stay behind CEZ_AUTOMATIONS=1.
  const attachAutomationTools = (project: ProjectContext) => project.manager.setAutomationTools?.(
    createAutomationToolService(automationService, project, { timeZone: localTimeZone }),
  );
  attachAutomationTools(bootContext);
  for (const id of contexts.ids()) {
    const ctx = contexts.peek(id);
    if (ctx) attachAutomationTools(ctx);
  }
  contexts.onContextBuilt(attachAutomationTools);

  // ---- chained family: GitHub automations (project-scoped) ----
  // Every handler below reads `c.get('project')` — the definitions, their runtime state and the
  // execution log are per-project files — so the family is project-scoped and mounted with the
  // rest of the mirrored table. The one exception is the manual-check read, which touches no
  // project at all; it is its own workspace-level family below.
  const automationsRoutes = new Hono<ProjectApiEnv>()
    .use('/automations', requireAutomations)
    .use('/automations/*', requireAutomations)
    .use('/automation-log', requireAutomations)
    .use('/automation-log/*', requireAutomations)
    .get('/automations', queryZodValidator(automationListQuerySchema), async (c) => {
      return c.json(await automationService.list(c.get('project'), c.req.valid('query')));
    })

    .post('/automations', jsonZodValidator(() => automationCreateSchema), async (c) => {
      const result = await automationService.create(c.get('project'), c.req.valid('json'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      const once = onceCreateAnswer(result.automation);
      return c.json({ automation: result.automation, ...(once ? { once } : {}) }, 201);
    })

    .get('/automations/:id', (c) => {
      const result = automationService.get(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json(result.body);
    })

    .put('/automations/:id', jsonZodValidator(() => automationUpdateSchema), async (c) => {
      const result = await automationService.update(c.get('project'), c.req.param('id'), c.req.valid('json'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ automation: result.automation });
    })

    .delete('/automations/:id', async (c) => {
      const result = await automationService.remove(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.body(null, 204);
    })

    .post('/automations/:id/enable', async (c) => {
      const result = await automationService.enable(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ automation: result.automation });
    })

    .post('/automations/:id/pause', async (c) => {
      const result = await automationService.pause(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ automation: result.automation });
    })

    // One-time schedules only (#1465): archive without launching. 409 for any other automation.
    .post('/automations/:id/cancel', async (c) => {
      const result = await automationService.cancel(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ automation: result.automation });
    })

    // Run now: a schedule fired once by hand, paused or not, outside the timer and under the same
    // lease. A repeating schedule keeps `nextRunAt` and `enabled`; a one-time schedule is consumed
    // (archived) by it. A GitHub automation's equivalent is `check`.
    .post('/automations/:id/run', async (c) => {
      const result = await automationService.runNow(c.get('project'), c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ runId: result.runId }, 202);
    })

    // The body is validated as MIDDLEWARE, which is what puts it in the route type — and moves
    // the 400 ahead of this route's 404: `POST /automations/<unknown>/check` with a malformed
    // body now answers 400 rather than 404. Nothing else about either answer changed.
    .post('/automations/:id/check', jsonZodValidator(() => automationCheckRequestSchema), async (c) => {
      const project = c.get('project');
      const store = project.automationStore;
      const automation = store.get(c.req.param('id'));
      if (!automation) return c.json({ error: 'not found' }, 404);
      if (!isGithubAutomation(automation)) return c.json({ error: 'a schedule has nothing to preview; use run' }, 409);
      const parsed = { data: c.req.valid('json') };
      // `string`, not `randomUUID`'s template-literal type: the wire carries an opaque id, and
      // leaking `${string}-${string}-…` into the route type would make the contract describe the
      // generator rather than the answer.
      const id: string = randomUUID();
      const check: ManualCheck = { id, automationId: automation.id, mode: parsed.data.mode, status: 'queued', createdAt: new Date().toISOString() };
      if (manualChecks.size >= 200) manualChecks.delete(manualChecks.keys().next().value!);
      manualChecks.set(id, check);
      void (async () => {
        check.status = 'running';
        try {
          const repoRemote = (await getRepoInfo(project.root))?.remote;
          const remote = parseRemote(repoRemote ?? '');
          if (!remote || forgeKindOfRemote(repoRemote) !== 'github') throw new Error('No GitHub remote is configured');
          const scheduler = new ProjectAutomationScheduler({
            projectId: project.id,
            store,
            timeZone: localTimeZone(),
            github: { owner: remote.owner, repo: remote.repo, poller: new GithubPoller() },
            launch: parsed.data.mode === 'execute'
              ? (definition, candidate, receiptId) => launchAutomationRun({ root: project.root, manager: project.manager, store: project.store, definition, candidate, receiptId })
              : undefined,
            onChange: (automationId, revision) => emitAutomationChange(project, automationId, revision),
          });
          const result = await scheduler.check(automation, parsed.data.mode);
          Object.assign(check, { status: 'complete', completedAt: new Date().toISOString(), matches: result.candidates.length, truncated: result.truncated });
        } catch (error) {
          Object.assign(check, { status: 'error', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return c.json({ checkId: id }, 202);
    })

    .get('/automation-log', queryZodValidator(automationLogQuerySchema), (c) => {
      return c.json({ records: c.get('project').automationStore.logs(c.req.valid('query')) });
    })

    .post('/automation-log/:receiptId/retry', async (c) => {
      const project = c.get('project');
      const store = project.automationStore;
      const receipt = [...store.latestReceipts().values()].find((row) => row.receiptId === c.req.param('receiptId'));
      if (!receipt) return c.json({ error: 'not found' }, 404);
      if (receipt.status !== 'launch-error' || receipt.runId) return c.json({ error: 'receipt is not retryable' }, 409);
      const scheduled = store.get(receipt.automationId);
      // A schedule receipt carries its occurrence instead of a GitHub candidate; it is fired
      // again by hand through the runner, under the lease, as the same receipt.
      if (scheduled && isScheduleAutomation(scheduled) && receipt.occurrenceAt) {
        const outcome = await new ScheduleRunner(scheduleHandle(project)).retry(scheduled, receipt);
        // Gone, or no longer a schedule, once re-read under the lease: nothing was launched.
        if (outcome.result === 'skipped') return c.json({ error: 'not found' }, 404);
        if (outcome.result === 'manual') {
          emitAutomationChange(project, scheduled.id, store.get(scheduled.id)?.revision ?? scheduled.revision);
          return c.json({ receiptId: receipt.receiptId, runId: outcome.runId }, 202);
        }
        if (outcome.result === 'lease-held') return c.json({ error: SCHEDULE_LEASE_HELD_REASON }, 409);
        if (outcome.result === 'duplicate') return c.json({ error: 'receipt is not retryable' }, 409);
        const latest = store.latestReceipts().get(receipt.receiptKey);
        return c.json({ error: latest?.error ?? 'the run could not be launched' }, 409);
      }
      if (!receipt.candidate) return c.json({ error: 'receipt predates retry context and cannot be retried safely' }, 409);
      const definition = scheduled;
      if (!definition) return c.json({ error: 'automation not found' }, 404);
      if (!isGithubAutomation(definition)) return c.json({ error: 'receipt is not retryable' }, 409);
      const lease = store.acquireLease();
      if (!lease) return c.json({ error: 'automation polling lease is held by another process' }, 409);
      const reserved = { ...receipt, status: 'reserved' as const, error: undefined, updatedAt: new Date().toISOString() };
      store.appendReceipt(reserved);
      try {
        const launched = await launchAutomationRun({ root: project.root, manager: project.manager, store: project.store, definition, candidate: receipt.candidate, receiptId: receipt.receiptId });
        store.appendReceipt({ ...reserved, status: 'launched', runId: launched.runId, updatedAt: new Date().toISOString() });
        emitAutomationChange(project, definition.id, definition.revision);
        return c.json({ receiptId: receipt.receiptId, runId: launched.runId }, 202);
      } catch (error) {
        store.appendReceipt({ ...reserved, status: error instanceof AutomationCandidateChangedError ? 'released' : 'launch-error', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      } finally {
        lease.release();
      }
    });

  // ---- chained family: manual automation checks (workspace-level) ----
  // Workspace-level because the handler reads no project: a check lives in the server-memory map
  // above, keyed by an unguessable id that the project-scoped POST hands back. Mounting it under
  // `/api/v1/p/:projectId` too would be a second spelling of a lookup that consults no project.
  const automationChecksRoutes = new Hono()
    .use('/automation-checks/*', requireAutomations)
    .get('/automation-checks/:checkId', (c) => {
      const check = manualChecks.get(c.req.param('checkId'));
      return check ? c.json(check) : c.json({ error: 'not found' }, 404);
    });

  // ---- runs ----------------------------------------------------------------

  // Additive `usage` field (#348): the latest CPU/RSS/proc-count sample of the
  // run's live process tree — absent for finished runs and when `ps` yields
  // nothing. The stored record itself is never touched.
  const withUsage = (run: RunRecord, finishBlocked?: string | null): ApiRun => {
    const usage = currentUsage(run.id);
    const sessionStep = [...run.steps].reverse().find(step => step.sessionId);
    const sessionId = sessionStep?.sessionId;
    const backend = sessionStep?.backend ?? run.runner ?? 'claude';
    // Runners whose take-over command depends on a server-side binary override (CEZ_*_BIN).
    const command = (backend === 'cursor' || backend === 'omp') && sessionId ? resumeCommand(backend, sessionId) : null;
    return { ...run, ...(usage ? { usage } : {}), ...(command ? { cliResumeCommand: command } : {}),
      ...(finishBlocked !== undefined ? { finishBlocked } : {}) };
  };

  // A list row (#817) with the same live `usage` sample `withUsage` attaches. The sampler is
  // process-wide, so a workspace-level answer can carry it for every project's runs at once — a
  // cold project's stored summaries included. Appended last, exactly where `toRunSummary` puts it.
  const withLiveUsage = (summary: RunSummary): RunSummary => {
    const usage = currentUsage(summary.id);
    return usage ? { ...summary, usage } : summary;
  };

  /**
   * Gate every run control by family ownership: refuse foreign or quarantined writers with 409;
   * adopt proven dead owners without resuming agents. Reads remain available. Stop carries its
   * cancellation through adoption.
   */
  const requireRunControl = async (c: Context<ProjectApiEnv>, next: Next) => {
    const id = c.req.param('id');
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || id === undefined) return next();
    const { store, manager } = c.get('project');
    if (store.runOwnership(id) === 'orphaned') {
      const stop = c.req.method === 'POST' && c.req.path.endsWith('/cancel');
      if (await manager.adoptOrphanedRun(id, { stop }) && stop && store.getRun(id)?.status === 'cancelled') c.set('stoppedOnAdoption', true);
    }
    const refusal = store.writeRefusal(id);
    if (!refusal) return next();
    // The delegation route in this family answers in the delegation error shape it always uses.
    return c.req.path.endsWith('/worker-destroy')
      ? c.json({ code: 'incompatible_state' as const, error: refusal }, 409)
      : c.json({ error: refusal }, 409);
  };

  // ---- chained family: runs lifecycle + artifacts (project-scoped) ----
  const delegationService = deps.delegation?.service ?? new DelegationService();
  delegationService.setDiscovery({ models: modelCatalog, providers: providerStatus });
  const runsRoutes = new Hono<ProjectApiEnv>()
    .use('/runs/:id', requireRunControl)
    .use('/runs/:id/*', requireRunControl)
    // Legacy (older clients): every full record. The cockpit and `cez task` read `/run-summaries`.
    .get('/runs', (c) => c.json(c.get('project').store.listAllRunsForLegacyRoute().map(run => withUsage(run))))
    // The slim list (#817): the same runs in the same order as `GET /runs`, from the stored
    // `toRunSummary` column with memory laid over it (#779), so the list decodes no record.
    // `?archived=recent` (#864) is the window the cockpit reads: every unarchived run plus the newest
    // `ARCHIVED_WINDOW` archived roots. The default stays every run, for clients that list them all.
    .get('/run-summaries', queryZodValidator(runSummariesQuerySchema), (c) => {
      const archivedWindow = c.req.valid('query').archived === 'recent' ? ARCHIVED_WINDOW : undefined;
      return c.json(c.get('project').store.listRunSummaries({ archivedWindow }).runs.map(withLiveUsage));
    })
    // The archived roots past that window, a page at a time, newest first (#864).
    .get('/run-summaries/archived', queryZodValidator(archivedRunsQuerySchema), (c) => {
      const { before, limit, q } = c.req.valid('query');
      const project = c.get('project');
      // The page shows each task's origin line, so `q` matches what it names: the automation's
      // name, or its recorded id while automations are off, as the cockpit's filter does (#1616).
      const automationNames = new Map(capabilities().automations
        ? project.automationStore.list().map((automation) => [automation.id, automation.name] as const) : []);
      const page = project.store.listArchivedRuns({
        limit: limit ?? ARCHIVED_RUNS_PAGE_DEFAULT,
        automationNames,
        ...(before !== undefined ? { before } : {}),
        ...(q !== undefined ? { q } : {}),
      });
      if ('error' in page) return c.json({ error: page.error }, 400);
      const body: ArchivedRunsResponse = { ...page, runs: page.runs.map(withLiveUsage) };
      return c.json(body);
    })
    .get('/runs/:id/relationships', paramZodValidator(runIdParamSchema), queryZodValidator(workerEmptyRequestSchema), (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.valid('param').id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Off the parent's receipts, not a scan of the project index (#659): archived/off-page
      // workers still belong to this parent, and the cockpit asks on every run event, so the
      // read has to cost O(workers) whatever the store holds — and nothing at all for the
      // ordinary run that owns none, delegation on or off.
      // Human reads use the bound project, never agent credentials or private evidence.
      const ownedWorkers = store.listOwnedWorkers(run.id);
      const workers = ownedWorkers.flatMap(worker => {
        const owned = worker.delegation;
        if (owned?.role !== 'worker') return [];
        return [{ workerId: worker.id, parentRunId: run.id, status: worker.status, workspace: owned.workspace,
          ...(worker.currentStepId === undefined ? {} : { currentStepId: worker.currentStepId }),
          ...(owned.destroy ? { destroy: workerDestroyView(worker) } : {}),
        }];
      });
      // #864: the titles of the runs this answer names, since the cockpit's run list no longer
      // carries archived workers (or a parent past its archived window).
      const parent = run.delegation?.role === 'worker' ? store.getRun(run.delegation.parentRunId) : undefined;
      const titles = [...(parent ? [parent] : []), ...ownedWorkers].map((related) => ({
        id: related.id, title: related.title,
        ...(related.titleSummary === undefined ? {} : { titleSummary: related.titleSummary }),
        ...(related.titleOrigin === undefined ? {} : { titleOrigin: related.titleOrigin }),
      }));
      // #816: every owned worker, bounded by the 1,024 creation ceiling rather than sliced, and
      // the root's capacity from the same derivation the spawn policy enforces.
      return c.json(runRelationshipsSchema.parse({
        ...(run.delegation?.role === 'worker' ? { parentRunId: run.delegation.parentRunId } : {}), workers,
        ...(titles.length > 0 ? { titles } : {}),
        ...(run.delegation?.role === 'root' ? { capacity: workerCapacity(run, id => store.getRun(id)) } : {}),
      }));
    })
    .post('/runs/:id/worker-destroy', queryZodValidator(workerEmptyRequestSchema, { code: 'invalid_input', message: 'Invalid cleanup query' }), paramZodValidator(runIdParamSchema, { code: 'invalid_input', message: 'Invalid worker ID' }), jsonZodValidator(workerEmptyRequestSchema, { absent: {}, malformed: null, code: 'invalid_input', message: 'Invalid cleanup input' }), async c => {
      const project = c.get('project');
      delegationService.registerProject(project);
      try {
        const result = await delegationService.destroyForHuman(project.id, c.req.valid('param').id);
        return result.state === 'incomplete' ? c.json(result, 409) : c.json(result, 200);
      } catch (error) { const failure = delegationFailure(error); return c.json(failure.body, failure.status); }
    })

    // Registered before the `/:id/...` routes so "archive-finished" and "read-all"
    // never match as a run id.
    .post('/runs/archive-finished', jsonZodValidator(archiveFinishedRequestSchema, { absent: {}, malformed: null }), (c) =>
      c.json(c.get('project').store.archiveFinished(c.req.valid('json').scope, c.req.valid('json').automation)))

    // The read-receipt sweep (#unread-done-items) — the mark-read twin of the archive
    // sweep above, and under the same registration-order guard.
    .post('/runs/read-all', jsonZodValidator(markAllReadRequestSchema, { absent: {}, malformed: null }), (c) =>
      c.json({ read: c.get('project').store.markAllRead(c.req.valid('json').automation) }))

    .post('/runs/:id/archive', jsonZodValidator(archiveSchema, { absent: ({}) }), async (c) => {
      const { store } = c.get('project');
      const id = c.req.param('id');
      // An empty/absent body archives (the common case); a malformed body degrades
      // to `{}` just as before, but a wrong-typed `archived` is now a 400 (#429).
      // Archiving also retires any pending usage-limit resume, but that rule belongs to
      // `setArchived` itself — the bulk sweep must obey it too (spec
      // 2026-08-03-auto-resume-after-usage-limit).
      const parsed = { data: c.req.valid('json') };
      const run = store.setArchived(id, parsed.data.archived !== false);
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })

    // Pin one task to the top of this project's list, or unpin it (#935). The archive route's
    // twin in every respect: an absent body pins (the common case), the answer is the updated
    // record, and the change rides the existing `run` SSE because `setPinned` touches. No new
    // event and no new response shape.
    .post('/runs/:id/pin', paramZodValidator(runIdParamSchema), jsonZodValidator(pinRunInputSchema, { absent: {}, malformed: null }), (c) => {
      const { store } = c.get('project');
      const run = store.setPinned(c.req.valid('param').id, c.req.valid('json').pinned !== false);
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })

    // Task webhook opt-in for one run (#589), valid in every state — handing a finished task to a
    // bot for follow-up is a real case. Turning it on sends one `task.subscribed` delivery with
    // the note; the note never reaches the agent session. Either direction leaves a durable
    // `handoff` event so the thread shows when and why. Idempotent: repeating `true` with a
    // new note is how "Send a note…" works.
    .post('/runs/:id/notify', paramZodValidator(runIdParamSchema), jsonZodValidator(notifyRunInputSchema), async (c) => {
      const project = c.get('project');
      const { id } = c.req.valid('param');
      const { notify, message } = c.req.valid('json');
      if (!project.store.getRun(id)) return c.json({ error: 'not found' }, 404);
      if (notify) {
        const entry = await projectRegistryEntry(project.id).catch(() => undefined);
        if (taskWebhookList(entry).length === 0) return c.json({ error: NO_WEBHOOK_ERROR }, 400);
      }
      const run = project.store.updateRun(id, { notify: notify ? true : undefined });
      if (!run) return c.json({ error: 'not found' }, 404);
      project.store.appendEvent(id, {
        type: 'handoff',
        notify,
        ...(message === undefined ? {} : { message }),
      });
      if (notify) taskWebhooks.attach(project).subscribed(id, message);
      return c.json(run);
    })

    // The per-task off switch for that resume (the workspace setting is Settings → Resources).
    // Idempotent: a run with nothing pending answers 200 too, because "this task will not
    // resume itself" is equally true either way.
    .delete('/runs/:id/auto-resume', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      manager.cancelAutoResume(id);
      return c.json({ cancelled: true as const });
    })

    .post('/runs/:id/read', (c) => {
      // No body: opening a thread marks it read, full stop. Stamps `seenAt = now` and
      // returns the updated record (which also rides the `run` SSE via `touch`).
      const run = c.get('project').store.setRead(c.req.param('id'));
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })

    .post('/runs/:id/unread', (c) => {
      // The mark-unread twin (#775) — bodyless like its read counterpart: clearing the
      // receipt is the whole action, so there is nothing to say about it. Sits under
      // `/runs/:id/`, so the `read-all` registration-order caveat above does not apply.
      const run = c.get('project').store.setUnread(c.req.param('id'));
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })

    .post('/runs', jsonZodValidator(createRunInputSchema), async (c) => {
      const { id: projectId, root: repoRoot, manager, store } = c.get('project');
      const body = c.req.valid('json');
      const clientRequest = clientRequestOf(body);
      if (clientRequest) {
        const replay = replayedRun(store, clientRequest);
        if (replay && 'error' in replay) return c.json({ error: replay.error }, replay.status);
        if (replay) return c.json(replay.run, 200 as const);
      }
      const locked = modelLockRefusal(repoRoot, body);
      if (locked) return c.json({ error: locked.error }, locked.status);
      const resolved = await resolveStartWorkflow(repoRoot, body);
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
      const { workflow } = resolved;
      const runner = body.runner ?? (await loadConfig(repoRoot)).defaultRunner;
      const blocked = await providerGateRefusal(providerActionError, workflow, runner);
      if (blocked) return c.json({ error: blocked.error }, blocked.status);
      const badProfile = await agentProfileRefusal(resolveWorkspaceProfile, runner, body.agentProfile);
      if (badProfile) return c.json({ error: badProfile.error }, badProfile.status);
      const noWebhook = await notifyRefusal(body.notify, projectId, projectRegistryEntry);
      if (noWebhook) return c.json({ error: noWebhook.error }, noWebhook.status);
      const started = launchRun(manager, workflow, startRunInput(body), clientRequest);
      if ('error' in started) return c.json({ error: started.error }, started.status);
      return c.json(started.run, started.status);
    })

    .get('/runs/:id', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (run) return c.json(withUsage(run, manager.finishBlockedReason(run.id) ?? null));
      // A row in runs.db this version cannot decode (#779): listed until read, so say why it will not open.
      return c.json({ error: store.isUnreadable(id) ? UNREADABLE_RUN_ERROR : 'not found' }, 404);
    })

    .get(
      '/runs/:id/history',
      paramZodValidator(runIdParamSchema),
      queryZodValidator(runHistoryQuerySchema),
      async (c) => {
        const { store, dataDir } = c.get('project');
        const { id } = c.req.valid('param');
        if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
        try {
          return c.json(
            await readRunHistoryPage(dataDir, id, c.req.valid('query').cursor),
          );
        } catch (error) {
          if (error instanceof HistoryCursorError) return c.json({ error: error.message }, error.status);
          throw error;
        }
      },
    )

    .get(
      '/runs/:id/history-context',
      paramZodValidator(runIdParamSchema),
      async (c) => {
        const { store, dataDir } = c.get('project');
        const { id } = c.req.valid('param');
        if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
        return c.json(await deriveRunContextEvents(dataDir, id));
      },
    )

    // Editable titles (#389). The UI displays `titleSummary ?? title`, so a
    // user edit sets BOTH: `title` (the record's own name — the raw task stops
    // being it the moment the user renames the run) and `titleSummary` (what
    // actually displays). The auto-summarizer only ever fills an *unset*
    // titleSummary (TurnBookkeeper.recordTurnEnd), so an edit wins over any past or
    // future auto-summary. Answers the updated record.
    .patch('/runs/:id', jsonZodValidator(patchRunSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      // The prompt is editable only while the run is still queued (#472). Checked
      // BEFORE the title write so a rejected PATCH is a no-op rather than a partial
      // one. `title` itself keeps working on any status — no regression to #389.
      if (parsed.data.task !== undefined) {
        const foldedChars = foldedLength(parsed.data.task, store.getRun(id)?.queuedMessages ?? []);
        if (foldedChars > MAX_FOLDED_TASK_CHARS) {
          return c.json(
            {
              error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${foldedChars})`,
            },
            400,
          );
        }
        if (!manager.editTask(id, parsed.data.task)) {
          return c.json({ error: 'run already started' }, 409);
        }
      }
      if (parsed.data.title !== undefined) {
        // titleOrigin 'user' permanently stops the namer's live updates for this run
        // (spec 2026-07-17-task-auto-naming).
        store.updateRun(id, {
          title: parsed.data.title,
          titleSummary: parsed.data.title,
          titleOrigin: 'user',
        });
      }
      if (parsed.data.archiveWhenDone !== undefined || parsed.data.autoMergePr !== undefined) {
        store.updateRun(id, {
          ...(parsed.data.archiveWhenDone === undefined ? {} : { archiveWhenDone: parsed.data.archiveWhenDone }),
          ...(parsed.data.autoMergePr === undefined ? {} : { autoMergePr: parsed.data.autoMergePr }),
        });
      }
      return c.json(store.getRun(id));
    })

    .post('/runs/:id/cancel', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      // Still asked of the manager after an adoption stopped the run: a worker's stop bookkeeping is its.
      const cancelled = manager.cancel(id) || c.get('stoppedOnAdoption') === true;
      return c.json({ cancelled });
    })

    // Live-session participation (spec 002): deliver a user message (text +
    // pasted screenshots) into the run's open claude session.
    .post('/runs/:id/permissions', paramZodValidator(permissionRunIdParamSchema), jsonZodValidator(permissionDecisionSchema), (c) => {
      const { store, manager } = c.get('project');
      const { id } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const { requestId, optionId } = c.req.valid('json');
      if (!manager.respondPermission(id, requestId, optionId)) {
        return c.json({ error: 'permission request is no longer available or option is invalid' }, 409);
      }
      return c.json({ delivered: true as const });
    })

    .post('/runs/:id/messages', jsonZodValidator(messageSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      // Stacking onto a queued prompt mutates an existing task and invokes no provider.
      // Provider availability still gates live delivery after the record leaves `queued`, but
      // must not strand prompt authoring just because an unrelated fallback provider is
      // disconnected (provider-auth spec: disabling never blocks existing-task mutations).
      // In the dequeue race, the ladder below safely turns this into a starting-state buffer.
      if (run.status !== 'queued') {
        const blocked = await providerActionError([providerForActiveRun(run)]);
        if (blocked) return c.json({ error: blocked }, 409);
      }
      const content: PastedContent[] = [
        ...parsed.data.images.map(toPastedContent),
        ...(parsed.data.text.trim() ? [{ type: 'text', text: parsed.data.text } satisfies ContentBlock] : []),
      ];
      // Three-rung delivery ladder (#472). Branch on the ENGINE's answer rather
      // than a status read here: the handler cannot observe the dequeue safely
      // (the record is written a tick later), the engine can.
      //   live session → delivered · still queued → folded into the prompt
      //   starting up  → buffered  · anything else → 409, exactly as before
      if (manager.sendMessage(id, content)) return c.json({ delivered: true });

      const currentRun = store.getRun(id);
      const stack = currentRun?.queuedMessages ?? [];
      // Bounds apply only to a message that is actually about to be stacked. Without this
      // gate an over-long message posted to a *finished* run would answer `400 prompt too
      // long` when the truthful answer is `409 session closed`. The status read is safe
      // here because it only decides whether to reject EARLY — `enqueueMessage` still
      // re-checks against the engine's own queue before writing anything.
      if (currentRun?.status === 'queued') {
        if (stack.length >= MAX_QUEUED_MESSAGES) {
          return c.json({ error: `too many queued messages — ${MAX_QUEUED_MESSAGES} message limit` }, 400);
        }
        const stackedImages = stack.reduce((n, m) => n + (m.images?.length ?? 0), 0);
        if (stackedImages + parsed.data.images.length > MAX_QUEUED_ATTACHMENTS) {
          return c.json({ error: `too many queued attachments — ${MAX_QUEUED_ATTACHMENTS} attachment limit across the stack` }, 400);
        }
        const prospective = foldedLength(currentRun.task, [...stack, { text: parsed.data.text }]);
        if (prospective > MAX_FOLDED_TASK_CHARS) {
          return c.json(
            {
              error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${prospective})`,
            },
            400,
          );
        }
      }

      const queued = manager.enqueueMessage(id, content);
      if (queued) return c.json({ queued: true, message: queued });
      if (manager.deferMessage(id, content)) return c.json({ deferred: true });
      return c.json({ error: 'session closed' }, 409);
    })

    // Edit / remove a stacked message (#472). Registered before any conflicting
    // `/:id` route so `queued-messages` never matches as a run id.
    .patch('/runs/:id/queued-messages/:msgId', jsonZodValidator(queuedMessagePatchSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      const msgId = c.req.param('msgId');
      const stack = run.queuedMessages ?? [];
      const existing = stack.find((m) => m.id === msgId);
      if (!existing) return c.json({ error: 'not found' }, 404);

      const effectiveText = parsed.data.text ?? existing.text;
      const effectiveImageCount = parsed.data.images?.length ?? existing.images?.length ?? 0;
      if (!effectiveText.trim() && effectiveImageCount === 0) {
        return c.json({ error: 'message needs text or at least one attachment' }, 400);
      }

      const others = stack.filter((m) => m.id !== msgId);
      const stackedImages = others.reduce((n, m) => n + (m.images?.length ?? 0), 0);
      if (stackedImages + effectiveImageCount > MAX_QUEUED_ATTACHMENTS) {
        return c.json({ error: `too many queued attachments — ${MAX_QUEUED_ATTACHMENTS} attachment limit across the stack` }, 400);
      }
      const prospective = foldedLength(run.task, [...others, { text: effectiveText }]);
      if (prospective > MAX_FOLDED_TASK_CHARS) {
        return c.json(
          {
            error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${prospective})`,
          },
          400,
        );
      }

      const images: PastedContent[] | undefined = parsed.data.images?.map(toPastedContent);
      const message = manager.editQueuedMessage(id, msgId, {
        ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
        ...(images !== undefined ? { images } : {}),
      });
      if (!message) return c.json({ error: 'run already started' }, 409);
      return c.json({ message });
    })

    .delete('/runs/:id/queued-messages/:msgId', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const msgId = c.req.param('msgId');
      if (!(run.queuedMessages ?? []).some((m) => m.id === msgId)) {
        return c.json({ error: 'not found' }, 404);
      }
      if (!manager.removeQueuedMessage(id, msgId)) return c.json({ error: 'run already started' }, 409);
      return c.json({ removed: true });
    })

    // "Finish": gracefully close a waiting session — the run completes as done.
    .post('/runs/:id/finish', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const finished = manager.finish(id);
      if (!finished) return c.json({ error: manager.finishBlockedReason(id) ?? 'no open session' }, 409);
      return c.json({ finished: true });
    })

    // "Continue" (spec 003): reopen a finished run's session in-process.
    .post('/runs/:id/continue', jsonZodValidator(continueSchema, { absent: ({}) }), async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Bounded resume text (#429); an empty/absent body still just re-runs on the
      // run's current backend, and a runner/model override reopens on that engine (#401).
      const parsed = { data: c.req.valid('json') };
      if (
        agentModelsLocked(repoRoot) &&
        (parsed.data.model?.trim() || parsed.data.effort?.trim())
      ) {
        return c.json({ error: AGENT_MODELS_LOCKED_ERROR }, 409);
      }
      // Untouched tasks execute their original workflow, including step-level runners.
      // Resolve the same fallback as POST /runs, and pass it through so validation
      // and execution use the same provider even when the record inherited config.
      const untouched = isUntouchedCancelledRun(run);
      const originalProvider = untouched
        ? run.runner ?? (await loadConfig(repoRoot)).defaultRunner
        : providerForExistingRun(run);
      const provider = parsed.data.runner ?? originalProvider;
      const required = untouched
        ? providersRequiredByWorkflow(run.workflowDef!, provider)
        : [provider];
      const blocked = await providerActionError(required);
      if (blocked) return c.json({ error: blocked }, 409);
      // The follow-up pill names an account the user just picked, so an id that has been deleted
      // since the thread loaded is answered honestly — the same asymmetry `POST /runs` keeps: a
      // USER can act on "unknown account", and reopening the session on another login silently
      // would cross the very billing boundary accounts exist to draw.
      if (parsed.data.agentProfile !== undefined) {
        const account = await resolveWorkspaceProfile(provider, parsed.data.agentProfile);
        if ('error' in account) return c.json({ error: account.error }, 400);
      }
      const result = manager.continueRun(id, {
        text: parsed.data.text,
        images: parsed.data.images?.map(toPastedContent),
        runner: untouched ? provider : parsed.data.runner,
        ...(untouched ? { originalRunner: originalProvider } : {}),
        model: parsed.data.model,
        effort: parsed.data.effort,
        agentProfile: parsed.data.agentProfile,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ continued: true });
    })

    // "Open in terminal" (spec 003): hand the session off to a real terminal —
    // in the task's worktree when it still exists (spec 006).
    .post('/runs/:id/open-in-cli', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Hosted mode: there is no "my machine" to open a terminal on. The UI
      // hides the button when localHandoff is false — this is defense in depth.
      if (!capabilities().localHandoff) {
        return c.json(
          {
            error:
              'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE); resume the session from a machine that has the checkout',
          },
          409,
        );
      }
      const sessionStep = [...run.steps].reverse().find((s) => s.sessionId);
      const sessionId = sessionStep?.sessionId;
      if (!sessionId) return c.json({ error: 'no agent session to resume' }, 409);
      const backend = sessionStep?.backend ?? run.runner ?? 'claude';
      const blocked = await providerActionError([backend]);
      if (blocked) return c.json({ error: blocked }, 409);
      const cwd = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : repoRoot;
      const command = resumeCommand(backend, sessionId);
      // Fails closed on an id we do not recognise — see resumeCommand (#431).
      if (!command) return c.json({ error: 'the recorded session id has an unexpected shape' }, 409);
      // The account that OWNS this session, not the project's current one (spec 2026-07-29).
      const account = await handoffEnv(backend, sessionStep?.profileId);
      if ('error' in account) return c.json({ error: account.error }, 409);
      const fallback = handoffFallbackCommand(cwd, command, account.env);
      // Fail closed for the same reason as the session id: a terminal opened without the
      // account's config dir resumes nothing and says nothing about why.
      if (fallback === null) {
        return c.json({ error: 'this account\'s folder cannot be used in a terminal command' }, 409);
      }
      const opened = await openTerminal(cwd, command, account.env);
      if (!opened) {
        return c.json({ error: 'no terminal emulator found', command: fallback }, 409);
      }
      return c.json({ opened: true, command });
    })

    // Open a run's worktree (or the repo root) in the chosen local app.
    .post('/runs/:id/open-in', jsonZodValidator(openInSchema), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (!capabilities().localHandoff) {
        return c.json(
          {
            error: 'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)',
          },
          409,
        );
      }
      // Follows the safeParse convention (#429); the downstream allowlist match is the real
      // injection guard, this just validates the shape.
      const parsedBody = { data: c.req.valid('json') };
      const { target, path: relPath } = parsedBody.data;
      const dir = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : repoRoot;

      if (target === 'default') {
        return openRunDefaultApp(c, run, relPath, openFile, NO_WORKTREE);
      }
      const cliRunner = agentCliRunner(target);
      if (cliRunner) {
        return openRunCli(c, run, cliRunner, dir, repoRoot, {
          providerActionError, resumeCommand, handoffEnv, handoffFallbackCommand, openTerminal,
        });
      }
      return openRunApp(c, target, dir, openApp);
    })

    // Handoff journal (spec 007): the per-task handoff.md as markdown, with cezar's records from the
    // run store (hearsay-tools/cezarion#1809). 404 only when the task is unknown; no file returns ''.
    .get('/runs/:id/handoff', (c) => {
      const { dataDir, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      return c.text(renderHandoffRecords(readHandoff(dataDir, run.id), run.handoffRecords), 200, {
        'content-type': 'text/markdown; charset=utf-8',
      });
    })

    .get('/runs/:id/images/:file', paramZodValidator(attachmentFileParamSchema), (c) => {
      const { dataDir, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const file = c.req.valid('param').file;
      const path = resolveAttachmentPath(dataDir, run.id, file);
      if (!path) return c.json({ error: 'not found' }, 404);
      const ext = file.split('.').pop() ?? '';
      const image = IMAGE_TYPES[ext];
      // An image answers exactly as it always has — the cockpit renders it in an `<img>`.
      // Everything else is a user-supplied file (#950) and leaves under the download headers.
      const type = image ?? FILE_TYPES[ext] ?? 'application/octet-stream';
      return new Response(readFileSync(path), {
        headers: {
          'content-type': type,
          'cache-control': 'private, max-age=31536000, immutable',
          ...(image
            ? {}
            : {
                'x-content-type-options': 'nosniff',
                // Engine-generated names are `pasted-3.pdf`-shaped, but a header value is not the
                // place to find out otherwise: anything exotic degrades to an underscore rather
                // than to a quote that could split the header.
                'content-disposition': `attachment; filename="${file.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
              }),
        },
      });
    })

    // Task diff (spec 006): what this run changed — its worktree vs its base.
    .get('/runs/:id/diff', async (c) => {
      const { dataDir, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const blocker = autosaveCleanupBlocker(dataDir, run.id);
      if (blocker) return c.json({ error: blocker }, 409);
      if (!run.worktreePath || !existsSync(run.worktreePath)) {
        return c.text('(no worktree — this task ran directly in the repo working tree)');
      }
      return c.text(await worktreeDiff(run.worktreePath, run.baseBranch ?? 'HEAD'));
    })

    .get('/runs/:id/changes', async (c) => {
      const { root: repoRoot, dataDir, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const blocker = autosaveCleanupBlocker(dataDir, run.id);
      if (blocker) return c.json({ error: blocker }, 409);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await collectChanges(workingDirectory, run.baseBranch ?? 'HEAD', {
        taskBranch: run.branch,
        // Anchors a repointed worktree at the branch as this run found it (#751).
        runStartedAt: run.startedAt,
        // A read-only GET against the user's real checkout must never modify its index.
        intentToAdd: run.worktreePath ? undefined : false,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.changes);
    })

    // The run's own commits (<base>..HEAD on the worktree branch) — the Commits tab.
    .get('/runs/:id/commits', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await collectRunCommits(workingDirectory, run.baseBranch ?? 'HEAD');
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ commits: result.commits });
    })

    // One of the run's commits, structured like the Changes tab (reuses collectCommitChanges).
    .get('/runs/:id/commit/:sha', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await collectCommitChanges(workingDirectory, c.req.param('sha'));
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.commit);
    })

    .get('/runs/:id/file-link', paramZodValidator(artifactParamsSchema.omit({ artifactId: true })), queryZodValidator(fileLinkQuerySchema), async (c) => {
      const { root, dataDir, store } = c.get('project');
      const run = store.getRun(c.req.valid('param').id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const query = c.req.valid('query');
      const loaded = await loadFileLink({ dataDir, runId: run.id, projectRoot: root, workingDirectory: run.worktreePath ?? root, path: query.path });
      if (query.raw === '1') {
        if (!loaded.imageBytes || loaded.preview.type !== 'file') return c.json({ error: 'Only bounded raster images can be served inline.' }, 409);
        return c.body(new Uint8Array(loaded.imageBytes).buffer, 200, {
          'content-type': rasterMime(loaded.preview.path)!, 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store',
        });
      }
      return c.json(loaded.preview);
    })
    .get('/runs/:id/artifacts', paramZodValidator(artifactParamsSchema.omit({ artifactId: true })), async (c) => {
      const { dataDir, store } = c.get('project');
      const id = c.req.valid('param').id;
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      return c.json({ artifacts: await listArtifacts(artifactDirectory(dataDir, id), id) });
    })
    .get('/runs/:id/artifacts/:artifactId', paramZodValidator(artifactParamsSchema), async (c) => {
      const { dataDir, store } = c.get('project');
      const { id, artifactId } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const entry = await readArtifact(artifactDirectory(dataDir, id), id, artifactId);
      if (!entry) return c.json({ error: 'Published file is missing or unavailable.' }, 404);
      return c.json(artifactPreview(entry.metadata, entry.bytes));
    })
    .get('/runs/:id/artifacts/:artifactId/download', paramZodValidator(artifactParamsSchema), async (c) => {
      const { dataDir, store } = c.get('project');
      const { id, artifactId } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const entry = await readArtifact(artifactDirectory(dataDir, id), id, artifactId);
      if (!entry) return c.json({ error: 'Published file is missing or unavailable.' }, 404);
      return c.body(new Uint8Array(entry.bytes).buffer, 200, {
        'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="${entry.metadata.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store',
      });
    })
    .get('/runs/:id/artifacts/:artifactId/image', paramZodValidator(artifactParamsSchema), async (c) => {
      const { dataDir, store } = c.get('project');
      const { id, artifactId } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const entry = await readArtifact(artifactDirectory(dataDir, id), id, artifactId);
      if (!entry) return c.json({ error: 'Published file is missing or unavailable.' }, 404);
      const mime = rasterMime(entry.metadata.name);
      if (!mime) return c.json({ error: 'Only raster images can be served inline.' }, 409);
      return c.body(new Uint8Array(entry.bytes).buffer, 200, {
        'content-type': mime, 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store',
      });
    })

    // Files tab: directory listing (path omitted or a dir) or file content
    // (size-capped, binary flagged). Traversal-safe — readWorktreePath rejects
    // anything escaping the worktree. `raw=1` (R5 Step 1.6) serves the BYTES of
    // image files only, for the preview's inline <img> — never HTML/JS/etc., so
    // no worktree file can become a same-origin document, and never past the
    // size cap. The no-script CSP neutralizes SVG opened as a top-level URL.
    //
    // An `Accept` that asks for images reaches the same raw branch without the flag — which is
    // what an `<img>` sends — while the flag still wins whenever it is present and `*<slash>*`
    // (every `fetch`) still gets the JSON listing. See `negotiate`.
    .get('/runs/:id/files', queryZodValidator(worktreeFilesQuerySchema), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const query = c.req.valid('query');
      c.header('vary', 'Accept');
      const wantsRaw =
        query.raw !== undefined
          ? query.raw === '1'
          : negotiate(c.req.header('accept'), FILE_FORMATS) === 'image/*';
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await readWorktreePath(workingDirectory, query.path ?? '');
      if (result.kind === 'invalid' || result.kind === 'missing') {
        return c.json({ error: result.error }, 409);
      }
      if (result.kind === 'dir') {
        return c.json({
          // `as const` or the literal widens to `string` during Hono's route-type inference,
          // which erases the discriminant a consumer narrows on — `entry.type === 'dir'` then
          // leaves `never` and every field access on it fails. The wire was always 'dir'.
          type: 'dir' as const,
          path: result.path,
          entries: result.entries,
        });
      }
      if (wantsRaw) {
        const mime = imageMimeType(result.path);
        if (mime === null || result.tooLarge) {
          // `?raw=1` ASKED for bytes, so it hears why it cannot have them — that 409 and its
          // wording are the protected surface (§2). An `Accept` is only a preference, so a
          // resource with no image representation falls THROUGH to the JSON answer below rather
          // than turning a browser's navigation to a text file into an error.
          if (query.raw !== undefined) {
            const error =
              mime === null
                ? `raw serving is limited to images: ${result.path}`
                : `file too large to serve raw (${result.size} bytes): ${result.path}`;
            return c.json({ error }, 409);
          }
        } else {
          const bytes = await readFile(join(workingDirectory, result.path));
          return c.body(new Uint8Array(bytes).buffer as ArrayBuffer, 200, {
            'content-type': mime,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          });
        }
      }
      return c.json({
        type: 'file' as const,
        path: result.path,
        size: result.size,
        binary: result.binary,
        tooLarge: result.tooLarge,
        ...(result.content !== undefined ? { content: result.content } : {}),
      });
    })

    .post('/runs/:id/git/commit', jsonZodValidator(gitCommitSchema), async (c) => {
      const { dataDir, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const blocker = autosaveCleanupBlocker(dataDir, run.id);
      if (blocker) return c.json({ error: blocker }, 409);
      const worktree = worktreeOf(run);
      if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
      const parsed = { data: c.req.valid('json') };
      const result = await commitAll(worktree, parsed.data.message);
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ committed: true, sha: result.sha });
    })

    .post('/runs/:id/git/push', async (c) => {
      const { root: repoRoot, dataDir, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const blocker = autosaveCleanupBlocker(dataDir, run.id);
      if (blocker) return c.json({ error: blocker }, 409);
      const worktree = worktreeOf(run);
      if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
      const result = await pushCurrentBranch(worktree);
      if (!result.ok) return c.json({ error: result.error }, 409);
      const repoBase = forgeWebRoot((await getRepoInfo(repoRoot))?.remote) ?? undefined;
      resolveForgeRoot(repoRoot, deps.forgeFactory).branchPushed(ownPullRequestNumbers(run, repoBase));
      return c.json({
        pushed: true,
        branch: result.branch,
        remote: result.remote,
        upstreamSet: result.upstreamSet,
      });
    })

    // Draft PR from the review gate (spec 009): final autosave → push →
    // `gh pr create --draft`; on success the run completes as done with the PR
    // badge. Failures come back as 409 with a `manual` merge command the GUI
    // shows next to the toast. CEZ_DRY_RUN=1 fakes the URL (no push, no gh).
    .post('/runs/:id/pr', async (c) => {
      const { root: repoRoot, dataDir, store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      if (manager.isActive(id)) return c.json({ error: 'run is still active — wait for the review gate' }, 409);
      const release = manager.claimForPublish(id);
      if (!release) return c.json({ error: 'its worktree or branch is being cleaned up — retry in a moment' }, 409);
      try {
        // Reclaim (#483, issue 08 §B4) removed the directory and kept the branch, and Not landed
        // offers this on exactly those rows: restore the checkout first, as Continue does.
        await rematerializeReclaimedWorktree(repoRoot, store, id);
        const run = store.getRun(id);
        if (!run) return c.json({ error: 'not found' }, 404);
        if (!run.worktreePath || !existsSync(run.worktreePath) || !run.branch) {
          return c.json(
            {
              error: 'no worktree/branch to publish — this task ran in the repo working tree',
            },
            400,
          );
        }
        const outcome = await resolveForgeRoot(repoRoot, deps.forgeFactory).createPR({
          repoRoot,
          run,
          handoffText: readHandoff(dataDir, id),
        });
        if (!outcome.ok) {
          return c.json({ error: outcome.error, manual: `git merge ${run.branch}` }, 409);
        }
        store.updateRun(id, {
          pullRequestUrl: outcome.url,
          status: 'done',
          finishedAt: run.finishedAt ?? new Date().toISOString(),
        });
        store.appendEvent(id, {
          type: 'note',
          message: `draft PR created: ${outcome.url}${outcome.dryRun ? ' (dry run — no real PR)' : ''}`,
        });
        return c.json({ url: outcome.url, dryRun: outcome.dryRun }, 201);
      } finally {
        release();
      }
    })

    // Archived tasks keep their worktree for inspection; this is the explicit
    // "🧹 Remove worktree" cleanup (spec 006).
    .post('/runs/:id/remove-worktree', async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (manager.isActive(id)) return c.json({ error: 'run is active — cancel it first' }, 409);
      if (run.delegation?.role === 'worker' || !store.canDeleteRun(id)) return c.json({ error: 'owned resources require verified worker cleanup' }, 409);
      const release = manager.claimForPublish(id);
      if (!release) return c.json({ error: 'worktree cleanup pending — retry after cleanup is confirmed' }, 409);
      try {
        if (run.worktreePath) await releaseThenRemoveWorktree({ previewHost: deps.previewHost }, id, repoRoot, run.worktreePath, run.branch);
        store.updateRun(id, { worktreePath: undefined, branch: undefined });
        return c.json({ removed: true });
      } finally { release(); }
    })

    .delete('/runs/:id', async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const id = c.req.param('id');
      if (manager.isActive(id)) return c.json({ error: 'run is active — cancel it first' }, 409);
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Delete cleans up after itself: worktree + branch go with the run (spec 006).
      if (!store.canDeleteRun(id)) return c.json({ error: 'owned resources require verified worker cleanup and explicit child history deletion first' }, 409);
      const release = manager.claimForPublish(id);
      if (!release) return c.json({ error: 'worktree cleanup pending — retry after cleanup is confirmed' }, 409);
      try {
        if (run.delegation?.role !== 'worker' && run.worktreePath) await releaseThenRemoveWorktree({ previewHost: deps.previewHost }, id, repoRoot, run.worktreePath, run.branch);
        return store.deleteRun(id) ? c.json({ deleted: true }) : c.json({ error: 'history cleanup incomplete — retry deletion' }, 409);
      } finally { release(); }
    });

  // ---- chained family: open-targets (project-scoped) ----
  const openTargetsRoutes = new Hono<ProjectApiEnv>()
    .get('/open-targets', (c) => c.json({ targets: capabilities().localHandoff ? detectOpenTargets() : [] }))

    // Open the PROJECT ROOT itself (Settings → "Project folder" → Open with). The run route
    // above opens a task worktree and needs a run to name one; this is the repo the cockpit is
    // scoped to, which the scope middleware has already resolved — so no path is accepted from
    // the client and there is nothing to contain.
    .post('/open-in', jsonZodValidator(openProjectInSchema), async (c) => {
      const { root } = c.get('project');
      if (!capabilities().localHandoff) {
        return c.json(
          { error: 'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)' },
          409,
        );
      }
      const { target } = c.req.valid('json');
      // Refused here rather than left to the menu, on the same principle as the accounts route:
      // a `cli:<runner>` handoff would START AN AGENT in the checkout everything else runs in a
      // worktree to protect. Which app APPLIES is a property of the route, not of one client.
      if (agentCliRunner(target) !== null) {
        return c.json({ error: 'agent CLIs open a task worktree, not the project folder' }, 400);
      }
      if (!detectOpenTargets().some((candidate) => candidate.id === target)) {
        return c.json({ error: `no such app on this machine: ${target}` }, 400);
      }
      const opened = await openApp(target, root);
      if (!opened) return c.json({ error: `could not open ${target}`, path: root }, 409);
      return c.json({ opened: true as const, path: root });
    });

  // Agent screenshots and user attachments — what the run manager persisted out of tool
  // results and pasted messages (`persistAttachment`). `basename` pins reads inside the
  // run's own dir.
  const IMAGE_TYPES: Record<string, string> = {
    img: 'application/octet-stream', // Legacy catch-all image uploads retain inline headers.
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  /**
   * What a NON-image attachment is served as (#950). These are user-supplied bytes coming back
   * from the cockpit's own origin, so the content type is the narrowest true one and it never
   * travels alone: `nosniff` stops a browser from upgrading it to something executable, and an
   * attachment disposition stops it from being rendered as a document in the cockpit's origin at
   * all. Anything not named here keeps the pre-existing `application/octet-stream` default.
   */
  const FILE_TYPES: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/plain; charset=utf-8',
  };
  // ---- session git view (redesign R5 Step 1.2 — §"Git/session API additions").
  // Structured sibling of the text-blob /diff above (which stays untouched —
  // protected surface). Isolated runs read their worktree; worktree-off runs
  // read the repo checkout they executed in. Every predictable git failure
  // degrades to 409 + human-readable reason, 404 only for unknown ids.
  const worktreeOf = (run: RunRecord): string | null =>
    run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : null;
  const workingDirectoryOf = (run: RunRecord, repoRoot: string): string | null =>
    run.worktree === false
      ? repoRoot
      : worktreeOf(run);
  const NO_WORKTREE = 'no worktree — this task ran directly in the repo working tree';

  // ---- chained family: worktrees (project-scoped) ----
  const worktreesRoutes = new Hono<ProjectApiEnv>()
    .get('/worktrees', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      // The keep-limit the panel reports is the one the enforcer will actually
      // apply — inherited from the workspace default when this repo sets none.
      const keep = await resolveWorktreeRetention(repoRoot);
      const withWorktree = store.listRunsWithWorktree();
      // Listing is on-disk dirs only; parent liveness for #575 reads the store by id
      // so a live `worktree: false` parent is not treated as gone (#570 honesty).
      const runs = withWorktree.filter((r) => r.worktreePath && existsSync(r.worktreePath));
      // The rows the enforcer would reclaim right now: reclaimable AND past the newest `keep`.
      const pastKeep = new Set(selectReclaimableWorktrees(withWorktree, keep, (id) => store.getRun(id)));
      const worktrees = await Promise.all(
        runs.map(async (r) => ({
          runId: r.id,
          title: r.title ?? r.id,
          status: r.status,
          branch: r.branch ?? null,
          // POSIX `du` — degrades to null (Windows / du missing / error); never blocks.
          sizeBytes: await worktreeSizeBytes(r.worktreePath as string),
          finishedAt: r.finishedAt ?? null,
          reclaimable: isReclaimable(r, (id) => store.getRun(id)),
          pastKeep: pastKeep.has(r.id),
        })),
      );
      // Total is null when any size degraded, so the panel never shows a wrong sum.
      const totalBytes = worktrees.some((w) => w.sizeBytes === null)
        ? null
        : worktrees.reduce((sum, w) => sum + (w.sizeBytes ?? 0), 0);
      return c.json({ worktrees, totalBytes, keep });
    })

    .post('/worktrees/reclaim', jsonZodValidator(() => reclaimBodySchema, { absent: ({}), message: 'invalid body' }), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      // The body is validated (an empty or `{}` one is accepted) but carries nothing this
      // handler reads; retention is best-effort, so 200 always.
      const { manager } = c.get('project');
      const reclaimed = await reclaimWorktrees(repoRoot, store, await resolveWorktreeRetention(repoRoot), {
        claim: (run) => manager.claimWorktreeReclaim(run.id),
        previewHost: deps.previewHost,
      });
      if (reclaimed.length > 0) forgetRepoBranches(repoRoot);
      return c.json({ reclaimed });
    })

    // One row's reclaim (issue 08 §B4): the DIRECTORY only, by retention's own rule and helper —
    // the `cez/<id8>` branch is kept, which is what makes this safe to offer on every finished
    // row. `/runs/:id/remove-worktree` (directory AND branch) stays the task screen's action.
    .post('/worktrees/:runId/reclaim', paramZodValidator(reclaimRunParamsSchema), async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const run = store.getRun(c.req.valid('param').runId);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Claimed, not merely checked: the claim holds Continue off until the directory is gone.
      const release = manager.claimWorktreeReclaim(run.id);
      if (!release) {
        return c.json({ error: 'this worktree is in use or already reclaimed — only a finished task\'s worktree can be reclaimed' }, 409);
      }
      const worktreeReclaimedAt = await reclaimWorktree(repoRoot, store, run, { requireClean: true, previewHost: deps.previewHost }).finally(release);
      if (!worktreeReclaimedAt) {
        // Reclaim keeps only what is committed, so it leaves a dirty checkout alone; say which case this was.
        const dirty = run.worktreePath && existsSync(run.worktreePath) ? (await getStatus(run.worktreePath).catch(() => [])).length : 0;
        return c.json({
          error: dirty > 0
            ? `the worktree has ${dirty} uncommitted file${dirty === 1 ? '' : 's'} that exist nowhere else — commit or discard them first`
            : 'the worktree directory could not be removed',
        }, 409);
      }
      forgetRepoBranches(repoRoot);
      return c.json({ runId: run.id, worktreeReclaimedAt });
    });

  // ---- chained family: SSE streams (project-scoped) ----
  const sseRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/runs/:id/events',
      paramZodValidator(runIdParamSchema),
      queryZodValidator(runEventsQuerySchema),
      async (c) => {
      const { store, dataDir } = c.get('project');
      const { id } = c.req.valid('param');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const query = c.req.valid('query');
      if (query.cursor) {
        try {
          await validateLiveCursor(dataDir, id, query.cursor);
        } catch (error) {
          if (error instanceof HistoryCursorError) return c.json({ error: error.message }, error.status);
          throw error;
        }
      }
      const lastEventId = Number.parseInt(c.req.header('Last-Event-ID') ?? '', 10);
      const requestedAfter = Math.max(
        query.afterSeq ?? 0,
        Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0,
      );
      return streamSSENoBuffer(c, async (stream) => {
        const controller = new AbortController();
        const stop = () => controller.abort();
        const onRun = (run: RunRecord) => {
          if (run.id === id) void stream.writeSSE({ event: 'run', data: JSON.stringify(run) });
        };
        store.on('run', onRun);
        stream.onAbort(() => { stop(); store.off('run', onRun); });
        const feed = subscribeRunFeed({ store, dataDir }, {
          projectId: c.get('project').id, runId: id, afterSeq: requestedAfter,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        }, {
          event: async event => {
            await stream.writeSSE({ id: String(event.seq), event: isV2WireEventType(event.type) ? 'ui-event' : 'run-event', data: JSON.stringify(event) });
          },
          reset: () => { stop(); void stream.close(); },
        // The legacy full-replay endpoint predates the finite batch limit. Preserve its
        // ability to deliver a large persisted event; new multiplex clients rehydrate it.
        }, controller.signal, Infinity);
        const run = store.getRun(id);
        if (run) await stream.writeSSE({ event: 'run', data: JSON.stringify(run) });
        try {
          while (!stream.aborted && !controller.signal.aborted) {
            await stream.writeSSE({ event: 'ping', data: '' });
            await stream.sleep(15_000);
          }
        } finally {
          stop(); store.off('run', onRun);
          await feed;
        }
      });
    },
    )

    // Global SSE: run-summary updates for the list view + inbox changes.
    // Scoped `/p/:projectId/events` carries that project's stream in today's
    // shape; the legacy unprefixed alias stays bound to the boot project ONLY
    // (spec "Legacy aliases" — widening it would be a silent behavioral break;
    // the all-project stream arrives as `/api/workspace/events` in step 2.8).
    .get('/events', (c) => {
      const { dataDir, store } = c.get('project');
      return streamSSENoBuffer(c, async (stream) => {
        const onRun = (run: RunRecord) => void stream.writeSSE({ event: 'run', data: JSON.stringify(run) });
        const onDeleted = (id: string) =>
          void stream.writeSSE({
            event: 'run-deleted',
            data: JSON.stringify({ id }),
          });
        // Live resource telemetry (#348): the sampler ticks ~every 2 s only
        // while some run has a registered process; each tick is relayed as one
        // `usage` message (runId → {cpuPct, rssBytes, procCount}). Never
        // persisted — the NDJSON transcripts stay usage-free. The sampler is
        // module-global, so a snapshot carries EVERY project's runs — split it
        // by ownership and relay only this project's rows, never a stamped
        // whole (multi-project spec, step 2.4: filtered, not stamped).
        const offUsage = onUsage((usage) => {
          const owned: typeof usage = {};
          for (const [runId, sample] of Object.entries(usage)) {
            if (store.getRun(runId)) owned[runId] = sample;
          }
          void stream.writeSSE({ event: 'usage', data: JSON.stringify(owned) });
        });
        store.on('run', onRun);
        store.on('deleted', onDeleted);
        stream.onAbort(() => {
          store.off('run', onRun);
          store.off('deleted', onDeleted);
          offUsage();
        });
        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      });
    });

  // ---- chained family: workspace SSE stream (workspace-level) ----
  const workspaceEventsRoutes = new Hono<ProjectApiEnv>()
    .get('/workspace/events', (c) => {
      return streamSSENoBuffer(c, async (stream) => {
        // One detach bundle per attached project — the id guard makes a double
        // attach (connect-time snapshot vs. the built hook) impossible.
        const attached = new Map<string, { store: RunStore; detach: () => void }>();
        const attach = (project: string, ctx: Pick<ProjectContext, 'store' | 'dataDir'>): void => {
          if (attached.has(project)) return;
          const { store } = ctx;
          const onRun = (run: RunRecord) =>
            void stream.writeSSE({
              event: 'run',
              data: JSON.stringify({ ...run, project }),
            });
          const onDeleted = (id: string) =>
            void stream.writeSSE({
              event: 'run-deleted',
              data: JSON.stringify({ id, project }),
            });
          store.on('run', onRun);
          store.on('deleted', onDeleted);
          attached.set(project, {
            store,
            detach: () => {
              store.off('run', onRun);
              store.off('deleted', onDeleted);
            },
          });
        };

        // The boot context never lives in the lazy map — seed it under its
        // registry id (`resolveBootProject`, NOT `bootContext.id`, which may be
        // the reserved alias when registration was suppressed).
        attach(await resolveBootProject(), bootContext);
        // NB: snapshot + hook subscription happen in one sync block, so no
        // context can slip between them.
        for (const id of contexts.ids()) {
          const ctx = contexts.peek(id);
          if (ctx) attach(ctx.id, ctx);
        }
        const offBuilt = contexts.onContextBuilt((ctx) => attach(ctx.id, ctx));

        // `usage` is FILTERED per project, never a stamped whole (spec "SSE
        // streams"): the module-global sampler's snapshot is split by each
        // attached project's owned runIds, one event per project that has live
        // rows. No event for a row-less project — the workspace stream carries
        // no empty-record clears (that is the per-project streams' contract).
        const offUsage = onUsage((usage) => {
          const rows = Object.entries(usage);
          for (const [project, { store }] of attached) {
            const owned: typeof usage = {};
            for (const [runId, sample] of rows) {
              if (store.getRun(runId)) owned[runId] = sample;
            }
            if (Object.keys(owned).length > 0) {
              void stream.writeSSE({
                event: 'usage',
                data: JSON.stringify({ project, usage: owned }),
              });
            }
          }
        });

        // Workspace-level events (project-added / project-removed /
        // checkout-progress plus host-wide unstamped provider-status) — relayed
        // verbatim under their own names. A removal also drops the project's
        // attach entry: the id guard in `attach` would otherwise pin the
        // DISPOSED context forever, so a project removed and re-added on the
        // same slug would rebuild a fresh context whose events never reach this
        // already-open stream.
        const offWorkspace = workspaceEvents.on((event, data) => {
          if (event === 'project-removed') {
            const removed = (data as { id?: string }).id;
            if (removed !== undefined && attached.has(removed)) {
              attached.get(removed)?.detach();
              attached.delete(removed);
            }
          }
          void stream.writeSSE({ event, data: JSON.stringify(data) });
        });

        stream.onAbort(() => {
          offBuilt();
          offUsage();
          offWorkspace();
          for (const { detach } of attached.values()) detach();
          attached.clear();
        });

        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ generation: serverGeneration }) });

        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      });
    });

  /** A ref-status list: `null` means malformed (the caller answers 400), `[]` means "not asked
   *  for". Absent and empty are the same request — neither names a number. */
  const parseRefNumbers = (raw: string | undefined): number[] | null => {
    const parts = (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > GH_REF_STATUS_MAX) return null;
    const numbers: number[] = [];
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isInteger(n) || n <= 0 || String(n) !== part) return null;
      numbers.push(n);
    }
    return numbers;
  };

  const githubRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/github',
      // `limit` stays a bare string: the handler's `Number.parseInt`/`Number.isFinite` fallback to
      // 30 already accepts `?limit=banana`, and a numeric schema would 400 it instead. The
      // cursors and done flags page each side on its own (hearsay-tools/cezarion#1183); the
      // schema refuses a done side that also carries its cursor, and both sides done.
      queryZodValidator(githubListQuerySchema),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const query = c.req.valid('query');
        const limit = Number.parseInt(query.limit ?? '', 10);
        return c.json(await resolveForgeRoot(repoRoot, deps.forgeFactory).list({
          refresh: query.refresh === '1',
          limit: Number.isFinite(limit) ? limit : 30,
          issuesCursor: query.issuesCursor,
          prsCursor: query.prsCursor,
          issuesDone: query.issuesDone === '1',
          prsDone: query.prsDone === '1',
        }));
      },
    )
    .get('/github/projects', queryZodValidator(githubProjectsQuerySchema), async (c) => {
      return c.json(await resolveForgeRoot(c.get('project').root, deps.forgeFactory).projects(c.req.valid('query').generation));
    })
    .get('/github/comments/:kind/:number', queryZodValidator(refreshQuery), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = commentsParams.safeParse({
        kind: c.req.param('kind'),
        number: c.req.param('number'),
      });
      if (!parsed.success) return c.json({ error: 'invalid kind or number' }, 400);
      return c.json(
        await resolveForgeRoot(repoRoot, deps.forgeFactory).comments(parsed.data.kind, parsed.data.number, { refresh: c.req.valid('query').refresh === '1' }),
      );
    })
    // One issue/PR by number, any state (#692) — the task page's item tabs. Same in-payload
    // degrade as the siblings: `item: null` is "no such number", `available: false` is "could not
    // ask"; never a 5xx.
    .get(
      '/github/items/:kind/:number',
      paramZodValidator(githubItemParamsSchema, { message: 'invalid kind or number' }),
      queryZodValidator(refreshQuery),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const { kind, number } = c.req.valid('param');
        return c.json(await resolveForgeRoot(repoRoot, deps.forgeFactory).item(kind, number, { refresh: c.req.valid('query').refresh === '1' }));
      },
    )
    // Lazy checks glyphs for on-screen PR rows (#664). Additive sibling of /api/github — the list
    // call dropped `statusCheckRollup` (the dominant cost), so the glyph is hydrated here per
    // visible row. `prs` is a comma-separated list of positive integers, capped at GH_CHECKS_MAX;
    // anything malformed is a 400. Same in-payload availability degrade as the list (never a 5xx).
    // `prs` is the one genuinely REQUIRED query key on this server, so it is the one validated
    // strictly — `.min(1)` because `?prs=` answered `missing prs query` before it answered
    // `invalid prs query`, and both spellings must keep their own words.
    .get('/github/checks', queryZodValidator(githubChecksQuerySchema, { message: 'missing prs query' }), async (c) => {
      const { root: repoRoot } = c.get('project');
      const raw = c.req.valid('query').prs;
      const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0 || parts.length > GH_CHECKS_MAX) return c.json({ error: 'invalid prs query' }, 400);
      const numbers: number[] = [];
      for (const part of parts) {
        const n = Number(part);
        if (!Number.isInteger(n) || n <= 0 || String(n) !== part) return c.json({ error: 'invalid prs query' }, 400);
        numbers.push(n);
      }
      return c.json(await resolveForgeRoot(repoRoot, deps.forgeFactory).checks(numbers));
    })

    // Comment counts for loaded list rows (hearsay-tools/cezarion#1183). The list defers them
    // (`commentsDeferred`) because they were ~0.4 s of every page; the cockpit asks here after
    // paint. Same shape and in-payload degrade as /github/checks: at most 100 positive numbers,
    // 400 on anything malformed, never a 5xx.
    .get('/github/comment-counts', queryZodValidator(githubCommentCountsQuerySchema, { message: 'invalid comment-counts query' }), async (c) => {
      const { kind, numbers, refresh } = c.req.valid('query');
      return c.json(await resolveForgeRoot(c.get('project').root, deps.forgeFactory).commentCounts(kind, numbers.split(',').map(Number), { refresh: refresh === '1' }));
    })

    // Search across ALL states (#730). Additive sibling of `/github`, which lists the OPEN set
    // only (`gh issue/pr list` defaults to `--state open`) — so the tab's in-memory filter can
    // never match a closed or merged item, and this is the path it falls back to. Same in-payload
    // availability degrade as the list (never a 5xx); malformed params are a 400. Deliberately
    // uncached: it is typed-into, not polled, and the driver's own cap bounds the work.
    .get(
      '/github/search',
      queryZodValidator(
        githubSearchQuerySchema,
        { message: 'invalid search query' },
      ),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const { kind, q, limit } = c.req.valid('query');
        const forge = resolveForgeRoot(repoRoot, deps.forgeFactory);
        if (!forge.searchItems) return c.json({ available: false, reason: 'GitHub is unavailable', items: [] });
        return c.json(await forge.searchItems(kind, q, limit === undefined ? {} : { limit }));
      },
    )

    // Batched status for the PR/issue chips a task table paints. Additive sibling of
    // /github/checks and shaped like it: comma-separated positive integers, capped at
    // GH_REF_STATUS_MAX per kind, malformed input is a 400, and an unreachable forge degrades in
    // the payload. Unlike /github/checks BOTH keys are optional — a table may hold only issues —
    // but at least one must name something, or the request asks for nothing.
    .get(
      '/github/ref-status',
      queryZodValidator(githubRefsQuerySchema),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const { prs, issues } = c.req.valid('query');
        const parsedPrs = parseRefNumbers(prs);
        const parsedIssues = parseRefNumbers(issues);
        if (parsedPrs === null || parsedIssues === null) return c.json({ error: 'invalid ref-status query' }, 400);
        if (parsedPrs.length === 0 && parsedIssues.length === 0) {
          return c.json({ error: 'missing prs or issues query' }, 400);
        }
        return c.json(await resolveForgeRoot(repoRoot, deps.forgeFactory).refStatus({ prs: parsedPrs, issues: parsedIssues }));
      },
    )

    .get(
      '/github/prs/:number/merge-state',
      paramZodValidator(mergeNumberParams, { message: 'invalid pull request number' }),
      queryZodValidator(refreshQuery),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsed = { data: c.req.valid('param') };
        const forge = resolveProjectForge(await getRepoInfo(repoRoot));
        if (!forge?.prMergeState) return c.json({ available: false, reason: 'GitHub merge state is unavailable' });
        return c.json(await forge.prMergeState(parsed.data.number, { refresh: c.req.valid('query').refresh === '1' }));
      },
    )

    .post(
      '/github/prs/:number/merge',
      paramZodValidator(mergeNumberParams, { message: 'invalid pull request number' }),
      jsonZodValidator(() => mergeBodySchema, { message: 'invalid merge request' }),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsedNumber = { data: c.req.valid('param') };
        const body = { data: c.req.valid('json') };
        const forge = resolveProjectForge(await getRepoInfo(repoRoot));
        if (!forge?.mergePR) return c.json({ error: 'GitHub merge is unavailable' }, 409);
        const result = await forge.mergePR(parsedNumber.data.number, body.data);
        if (result.merged) {
          return c.json(result);
        }
        return c.json(
          {
            error: result.error,
            ...(result.code ? { code: result.code } : {}),
            ...(result.current ? { current: result.current } : {}),
          },
          result.status,
        );
      },
    )

    .get(
      '/github/prs/:number/changes',
      // Split out of one `safeParse` over both inputs, because a path param and the query string
      // are separate validation targets to Hono and only a split makes each visible to the route
      // type. Both keep the single 400 sentence the combined parse answered. `refresh` stays
      // STRICT here (`?refresh=true` is a 400 today, unlike everywhere else on this server).
      paramZodValidator(prChangesParams, { message: 'invalid pull request number or refresh flag' }),
      queryZodValidator(prChangesQuery, { message: 'invalid pull request number or refresh flag' }),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsed = { data: c.req.valid('param') };
        const forge = resolveForgeRoot(repoRoot, deps.forgeFactory);
        if (!forge.prDiff) return c.json({ available: false, reason: 'GitHub is unavailable' });
        try {
          return c.json(
            await forge.prDiff(parsed.data.number, { refresh: c.req.valid('query').refresh === '1' }),
          );
        } catch (err) {
          if (err instanceof GithubPrNotFoundError) return c.json({ error: err.message }, 404);
          throw err;
        }
      },
    );

  // The full comment thread for one issue/PR (#499). Additive sibling of /api/github — lazy
  // (fetched only while a detail view is open), zod-validated params, 400 on garbage, and the
  // same in-payload availability degrade (gh missing / offline / 404 all render as a hint).
  const commentsParams = z.object({
    kind: z.enum(['issue', 'pr']),
    number: z.coerce.number().int().positive(),
  });

  const branchClassifyInput = (project: ClassifyProject) => classifyInputFor(project, deps.branchForge ?? githubBranchForge);

  // ---- chained family: repo / git (project-scoped) ----
  const repoRoutes = new Hono<ProjectApiEnv>()
    .get('/repo', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info)
        return c.json({
          info: null,
          status: [],
          log: [],
          branches: [],
          baseBranch: null,
          tracking: null,
        });
      const [status, rawLog, branches, config] = await Promise.all([
        getStatus(info.root),
        getLogWithParents(info.root),
        getBranches(info.root),
        loadConfig(repoRoot),
      ]);
      const [tracking, sources] = await Promise.all([
        getTracking(info.root, config.baseBranch ?? info.branch),
        attributeLog(info.root, rawLog, c.get('project').store.listBranchOwners()),
      ]);
      // `source` is spread conditionally: absent, never `null`, when no task is known.
      const log = rawLog.map(({ parents: _parents, ...entry }, i) => {
        const source = sources[i];
        return source ? { ...entry, source } : entry;
      });
      return c.json({
        info,
        status,
        log,
        branches,
        baseBranch: config.baseBranch ?? null,
        tracking,
      });
    })

    // Every local branch, classified (issue 08 §A/§B2) — cached on the refs state, so the
    // sidebar's counts do not shell out on every render.
    .get('/repo/branches', async (c) => {
      const input = await branchClassifyInput(c.get('project'));
      if (!input) return c.json({ base: '', prStateKnown: false, branches: [], counts: { notLanded: 0, cleanup: 0 } });
      return c.json(await readRepoBranches(input));
    })

    // The same classification's counts alone (hearsay-tools/cezarion#2029): the always-mounted Git
    // sidebar reads these, so it never pays for a diff stat per branch.
    .get('/repo/branches/counts', async (c) => {
      const input = await branchClassifyInput(c.get('project'));
      if (!input) return c.json({ base: '', prStateKnown: false, counts: { notLanded: 0, cleanup: 0 }, allBranches: 0 });
      return c.json(await readRepoBranchCounts(input));
    })

    // Delete local branches (issue 08 §B3). The server re-classifies and never trusts the
    // client's class: nothing here can delete work that is not on the base without the typed
    // confirmation, and nothing in use can be deleted at all.
    .post('/repo/branches/delete', jsonZodValidator(deleteBranchesInputSchema), async (c) => {
      const input = await branchClassifyInput(c.get('project'));
      if (!input) return c.json({ error: 'not a git repository', refused: [] }, 409);
      const body = c.req.valid('json');
      // The cockpit's checkout switch and pull hold this, not the worktree lock: without it a switch
      // could check a candidate out after the delete read the worktree list, and `update-ref` would
      // delete the branch HEAD now names.
      const release = claimRepoGitMutation(input.root);
      if (!release) return c.json({ error: 'a branch switch or pull is running — try again when it finishes', refused: [] }, 409);
      const result = await deleteBranches(input, body.names, body.confirm).finally(release);
      if (result.deleted.length === 0) {
        return c.json({ error: result.refused[0]?.reason ?? 'nothing was deleted', refused: result.refused }, 409);
      }
      return c.json(result, 200);
    })

    .get('/repo/diff', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.text('not a git repository');
      return c.text(await getDiff(info.root));
    })

    // One commit's message + stat + patch — the Repo view expands it inline.
    // `?structured=1` is the ADDITIVE sibling (R5 Step 1.7): the new repo view's commit-diff
    // shape `{sha, subject, author, when, files, stat}` with 409 + reason on failure. The
    // legacy text answer below is a protected surface (BACKWARD_COMPATIBILITY.md) — its
    // shape, including the in-band failure sentences, stays exactly as it was.
    //
    // `Accept: application/json` reaches the same structured answer without the flag, and
    // `Accept: text/plain` asks for the blob; the flag still wins whenever it is present, and a
    // request with no opinion still gets the blob. See `negotiate`.
    .get('/repo/commit/:sha', queryZodValidator(commitQuerySchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      c.header('vary', 'Accept');
      const { structured } = c.req.valid('query');
      const wantsJson =
        structured !== undefined
          ? structured === '1'
          : negotiate(c.req.header('accept'), COMMIT_FORMATS) === 'application/json';
      const info = await getRepoInfo(repoRoot);
      if (wantsJson) {
        if (!info) return c.json({ error: 'not a git repository' }, 409);
        const result = await collectCommitChanges(info.root, c.req.param('sha'));
        if (!result.ok) return c.json({ error: result.error }, 409);
        return c.json(result.commit);
      }
      if (!info) return c.text('not a git repository');
      try {
        return c.text(await getCommit(info.root, c.req.param('sha')));
      } catch (err) {
        return c.text(`(git show failed: ${err instanceof Error ? err.message : String(err)})`);
      }
    })

    // Structured sibling of the text-blob /api/repo/diff above (protected
    // surface, untouched): the same {files, stat} shape the session /changes
    // route serves, here for the MAIN working tree's uncommitted changes vs
    // HEAD (redesign R5 Step 1.3 — §"Git/session API additions").
    .get('/repo/changes', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      // The user's REAL working tree — never stage into their index (a GET must not write).
      const result = await collectChanges(info.root, 'HEAD', {
        intentToAdd: false,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.changes);
    })

    .get('/repo/pull', async (c) => {
      const { root } = c.get('project');
      const result = await localPullBranches(root);
      if ('error' in result) return c.json(result, 409);
      return c.json(result);
    })
    .post('/repo/pull', jsonZodValidator(repoPullInputSchema), async (c) => {
      const { root, store, manager } = c.get('project');
      const info = await getRepoInfo(root);
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      const config = await loadConfig(root);
      const result = await pullRepoCheckout(info.root, c.req.valid('json'), config.baseBranch,
        // Every id, not the live set: the manager may still hold a run whose record already
        // settled (a worker's execution winding down). Ids only, nothing decoded.
        () => store.listRunIds().some((id) => manager.isActive(id)));
      if (!result.ok) return c.json(result.value, 409);
      return c.json(result.value, 200);
    })

    .post('/repo/branch', jsonZodValidator(() => repoBranchSchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      const release = claimRepoGitMutation(info.root);
      if (!release) return c.json({ error: 'A Git operation is already in progress for this repository.' }, 409);
      try {
        const input = c.req.valid('json');
        const result = await createOrSwitchBranch(info.root, input.name, input.from);
        forgetRepoBranches(info.root);
        if (!result.ok) return c.json({ error: result.error }, 409);
        return c.json({ branch: result.branch, created: result.created });
      } finally {
        release();
      }
    });

  /** #917: setup commands run on the host before every task, so only a local cockpit edits them. */
  const WORKTREE_SETUP_HOSTED_ERROR = 'Worktree setup commands can be edited only on the machine running cezar.';

  // The Settings → Agents knobs in one read (R6 Step 1.5) — an ADDITIVE
  // sibling of PUT /api/config below; /api/health keeps its protected shape.
  const configAnswer = async (repoRoot: string, config: CezConfig) => {
    const archive = resolveArchiveOnMerge(config, await loadWorkspaceConfig());
    const nativeModels = await readAgentModelDefaults(repoRoot);
    const setup = resolveWorktreeSetup(config.worktreeSetup);
    const modelsLocked = agentModelsLocked(repoRoot);
    return {
      archiveOnMerge: config.archiveOnMerge ?? null,
      effectiveArchiveOnMerge: archive.enabled,
      archiveOnMergeSource: archive.source,
      baseBranch: config.baseBranch ?? null,
      defaultRunner: config.defaultRunner,
      systemPrompt: config.systemPrompt ?? null,
      // Native defaults seed each runner independently. A Cezar preset remains
      // selectable unless the operator opts into the fixed-model policy.
      defaultModels: modelsLocked
        ? nativeModels
        : { ...nativeModels, ...(config.defaultModels ?? {}) },
      modelsLocked,
      maxParallel: config.maxParallel,
      memoryLimitMb: config.memoryLimitMb ?? null,
      // Count-based worktree retention (#483): keep the last N finished worktrees
      // on disk. 0 = unlimited. Always materialized (schema default 10).
      worktreeRetention: config.worktreeRetention,
      // Live title updates (task auto-naming spec): tri-state — null means "no
      // config key, the CEZ_TITLE_UPDATES env default (ON) decides".
      liveTitleUpdates: config.liveTitleUpdates ?? null,
      // Optional review gate (#489): tri-state — null means "no config key, the
      // CEZ_REVIEW_GATE env default (OFF) decides".
      reviewGate: config.reviewGate ?? null,
      // Worktree setup (#917): an invalid value is reported, never shown as "no setup".
      worktreeSetup: setup.kind === 'commands' ? { commands: setup.commands, timeoutSeconds: setup.timeoutSeconds } : null,
      worktreeSetupIssue: setup.kind === 'invalid' ? setup.issue : null,
    };
  };
  // ---- chained family: per-repo config (project-scoped) ----
  const configRoutes = new Hono<ProjectApiEnv>()
    .get('/config', async (c) => {
      const repoRoot = c.get('project').root;
      return c.json(await configAnswer(repoRoot, await loadConfig(repoRoot)));
    })

    .put('/config', jsonZodValidator(() => setConfigSchema), async (c) => {
      const { root: repoRoot, dataDir } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      if (agentModelsLocked(repoRoot) && parsed.data.defaultModels !== undefined) {
        return c.json({ error: AGENT_MODELS_LOCKED_ERROR }, 409);
      }
      // Setup commands run on the host before every task (#917): a local-machine capability, like
      // Agent config writes. Checked before any write, so a refused body changes nothing.
      if (parsed.data.worktreeSetup !== undefined && !capabilities().localHandoff) {
        return c.json({ error: WORKTREE_SETUP_HOSTED_ERROR }, 409);
      }
      const configPath = join(dataDir, 'config.json');
      let raw: Record<string, unknown> = {};
      try {
        const existing: unknown = JSON.parse(await readFile(configPath, 'utf8'));
        if (existing && typeof existing === 'object') raw = existing as Record<string, unknown>;
      } catch {
        // missing or malformed — start fresh
      }
      if (parsed.data.baseBranch !== undefined) {
        if (parsed.data.baseBranch === null) delete raw.baseBranch;
        else raw.baseBranch = parsed.data.baseBranch;
      }
      if (parsed.data.defaultRunner !== undefined) raw.defaultRunner = parsed.data.defaultRunner;
      if (parsed.data.systemPrompt !== undefined) {
        // '' and null both clear: an emptied textarea means "no extra prompt".
        if (parsed.data.systemPrompt === null || parsed.data.systemPrompt === '') {
          delete raw.systemPrompt;
        } else {
          raw.systemPrompt = parsed.data.systemPrompt;
        }
      }
      if (parsed.data.maxParallel !== undefined) raw.maxParallel = parsed.data.maxParallel;
      if (parsed.data.worktreeRetention !== undefined) {
        // null clears back to the default (10); a number (including 0 = unlimited)
        // is stored as-is.
        if (parsed.data.worktreeRetention === null) delete raw.worktreeRetention;
        else raw.worktreeRetention = parsed.data.worktreeRetention;
      }
      if (parsed.data.liveTitleUpdates !== undefined) {
        if (parsed.data.liveTitleUpdates === null) delete raw.liveTitleUpdates;
        else raw.liveTitleUpdates = parsed.data.liveTitleUpdates;
      }
      if (parsed.data.archiveOnMerge !== undefined) {
        if (parsed.data.archiveOnMerge === null) delete raw.archiveOnMerge;
        else raw.archiveOnMerge = parsed.data.archiveOnMerge;
      }
      if (parsed.data.reviewGate !== undefined) {
        if (parsed.data.reviewGate === null) delete raw.reviewGate;
        else raw.reviewGate = parsed.data.reviewGate;
      }
      if (parsed.data.memoryLimitMb !== undefined) {
        // null or 0 both mean "no ceiling" — drop the key back to the default.
        if (parsed.data.memoryLimitMb === null || parsed.data.memoryLimitMb === 0) {
          delete raw.memoryLimitMb;
        } else {
          raw.memoryLimitMb = parsed.data.memoryLimitMb;
        }
      }
      if (parsed.data.worktreeSetup !== undefined) {
        // null or no commands = no setup: delete the key rather than store an empty list.
        const setup = parsed.data.worktreeSetup;
        if (setup === null || setup.commands.length === 0) delete raw.worktreeSetup;
        else raw.worktreeSetup = {
          commands: setup.commands,
          ...(setup.timeoutSeconds !== undefined ? { timeoutSeconds: setup.timeoutSeconds } : {}),
        };
      }
      if (parsed.data.defaultModels !== undefined) {
        // Per-runner merge, so setting codex's preset never clobbers claude's.
        const current =
          raw.defaultModels && typeof raw.defaultModels === 'object'
            ? { ...(raw.defaultModels as Record<string, unknown>) }
            : {};
        for (const [runner, model] of Object.entries(parsed.data.defaultModels)) {
          if (model === undefined) continue;
          if (model === null || model === '') delete current[runner];
          else current[runner] = model;
        }
        if (Object.keys(current).length === 0) delete raw.defaultModels;
        else raw.defaultModels = current;
      }
      try {
        await mkdir(dataDir, { recursive: true });
        await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      if (parsed.data.archiveOnMerge !== undefined) deps.archiveOnMergeChanged?.();
      // Pre-R6 answer shape ({baseBranch, defaultRunner}) + additive R6 fields.
      return c.json(await configAnswer(repoRoot, await loadConfig(repoRoot)));
    });

  // ---- chained family: agent-config (project-scoped) -----------------------
  // Agent config is project-scoped (spec #404, adapted to the multi-project
  // route seam from #521): handlers resolve the selected repo through the
  // same ProjectContext as every other mirrored route. Chained (not statements)
  // so `AppType` carries it — see `healthRoutes`.
  const agentConfigRoutes = new Hono<ProjectApiEnv>()
    .get('/agent-config', async (c) => {
      const editable = capabilities().localHandoff;
      return c.json(await listAgentConfig(c.get('project').root, process.env, editable));
    })

    .get('/agent-config/:id', async (c) => {
      const id = c.req.param('id');
      const def = findConfigFile(id);
      if (!def) return c.json({ error: 'unknown config file' }, 404);
      if (def.tracked === 'outside-repo' && !capabilities().localHandoff) {
        return c.json(
          {
            error: 'this file lives in your home directory and is not served in hosted mode (CEZ_REMOTE)',
          },
          409,
        );
      }
      const read = await readConfigFile(id, c.get('project').root);
      if (read === null) return c.json({ error: 'unknown config file' }, 404);
      if ('error' in read) return c.json({ error: read.error }, 500);
      return c.json(read);
    })

    .put('/agent-config/:id', jsonZodValidator(setAgentConfigSchema), async (c) => {
      // Config files may define hooks and MCP commands, so writes remain a
      // local-machine capability and are re-gated on every request.
      if (!capabilities().localHandoff) {
        return c.json(
          {
            error:
              'editing agent config is disabled in hosted mode (CEZ_REMOTE) — edit it from the machine that owns the checkout',
          },
          409,
        );
      }
      const parsed = { data: c.req.valid('json') };
      const out = await writeConfigFile(
        c.req.param('id'),
        parsed.data.content,
        parsed.data.version,
        c.get('project').root,
      );
      if (out === null) return c.json({ error: 'unknown config file' }, 404);
      if (!out.ok) return c.json({ error: out.error }, out.status);
      return c.json(out.read);
    });

  // ---- assemble the chained families --------------------------------------
  // Every chained family is registered ONCE and mounted into the versioned table. There is no
  // second, unversioned spelling: `/api/*` was removed once the whole API was reachable under
  // `/api/v1` (BACKWARD_COMPATIBILITY.md). One surface means one thing to keep working, and
  // it is the one the typed client describes.
  //
  // ---- chained family: voice mode (project-scoped, gated on CEZ_VOICE) ----
  const voiceRoutes = createVoiceRoutes({
    voiceEnabled: () => capabilities().voice,
    engine: () => selectVoiceEngine(process.env),
    recent: new RecentVoiceActions(),
  });

  // MOUNT ORDER IS REGISTRATION ORDER. Hono matches in the order routes were added, so each
  // family keeps its internal order and the families keep theirs relative to each other.
  //
  // Written as ONE chained expression because that is the only shape Hono can infer route types
  // from — it is what puts these routes in `AppType`, and so in the typed client.
  // ---- chained family: agent webhooks (hearsay-tools/cezarion#1576, project-scoped) ----
  // What `cez webhook` calls from inside a task: list the webhooks the owner exposed to agents in
  // this project, and send one report through one of them. A webhook closed to agents answers
  // the same 404 as an unknown one, so this interface cannot even confirm it exists.
  const agentWebhooksRoutes = new Hono<ProjectApiEnv>()
    .get('/agent-webhooks', async (c) => {
      const project = c.get('project');
      const body: AgentWebhooksResponse = { webhooks: agentWebhooks(await registryEntry(project.id, project.root).catch(() => undefined)) };
      return c.json(body);
    })

    .post('/agent-webhooks/:webhook', paramZodValidator(agentWebhookParamsSchema.pick({ webhook: true })), jsonZodValidator(sendAgentReportInputSchema), async (c) => {
      const project = c.get('project');
      const { webhook: ref } = c.req.valid('param');
      const entry = await registryEntry(project.id, project.root).catch(() => undefined);
      const webhook = agentWebhook(entry, ref);
      if (!entry || !webhook) return c.json({ error: `no webhook named "${ref}" is open to agents in this project — run \`cez webhook list\`` }, 404);
      const outcome = await sendAgentReport({
        projectId: entry.id,
        webhook,
        input: c.req.valid('json'),
        store: project.store,
        origin: taskWebhooks.currentOrigin(),
        fetch: deps.taskWebhookFetch,
      });
      const body: SendAgentReportResponse = { ...outcome, webhook: { id: webhook.id, name: webhook.name } };
      return c.json(body);
    });

  const v1 = new Hono<ProjectApiEnv>()
    .use('*', resolveProjectScope)
    .route('/', launchKeyRoutes)
    .route('/', skillsRoutes)
    .route('/', uiStateRoutes)
    .route('/', workflowsRoutes)
    .route('/', planRoutes)
    .route('/', automationsRoutes)
    .route('/', agentWebhooksRoutes)
    .route('/', runsRoutes)
    .route('/', openTargetsRoutes)
    .route('/', worktreesRoutes)
    .route('/', sseRoutes)
    .route('/', githubRoutes)
    .route('/', repoRoutes)
    .route('/', configRoutes)
    .route('/', agentConfigRoutes)
    .route('/', voiceRoutes);
  projectRoutePaths = new Set(v1.routes.filter((route) => route.method !== 'ALL')
    .flatMap((route) => [V1_PREFIX, V1_SCOPED_PREFIX].map((prefix) => `${route.method} ${prefix}${route.path}`)));

  // ---- chained family: the cross-project run index (workspace-level) -------
  /**
   * How many ARCHIVED root runs each project may contribute, newest first (#864). The index is a
   * FINDER, not a listing: every unarchived ROOT run is in it (so a project's pills miss nothing
   * live or unread), and older archived runs are reached through `GET /workspace/runs-search` and
   * the project's own archived pages. Owned workers are never in it: the pills, ⌘K and the global
   * Tasks page list no workers, and a parent's wait label comes from its own delegation. `truncated` names the projects this bit, so a consumer never
   * has to pretend the list is complete.
   */
  const RUNS_INDEX_PER_PROJECT = ARCHIVED_WINDOW;

  /** `RunRecord` → the wire row. Optional keys are spread CONDITIONALLY: writing
   *  `titleSummary: run.titleSummary` types a key as always-present that `JSON.stringify` then
   *  drops when it is undefined, which is exactly the drift the parity guard fails on. */
  /**
   * Every number a run MENTIONS — a superset of what its chip will show.
   *
   * Deliberately not `taskReference()`'s rule: which of a run's references is displayed is the
   * cockpit's decision (#407, #526), and re-deriving it here would be a second rule that drifts
   * from the first. This feeds a CACHE READ, which costs nothing per number, so asking about one
   * the client will not paint is free and asking about one it will is the whole point.
   */
  const mentionedReferenceNumbers = (run: RunSummary): number[] => {
    const numbers: number[] = (run.pullRequests ?? []).map(pr => pr.number);
    for (const url of [run.pullRequestUrl, run.referencedPullRequestUrl, run.referencedIssueUrl]) {
      const number = url ? refNumberFromUrl(url) : null;
      if (number !== null) numbers.push(number);
    }
    for (const number of [run.prNumber, run.issueNumber, run.markerRefs?.pr, run.markerRefs?.issue]) {
      if (typeof number === 'number' && Number.isInteger(number) && number > 0) numbers.push(number);
    }
    return numbers;
  };

  /**
   * `GET /workspace/runs-index` — every registered project's recent tasks in one slim answer, so
   * ⌘K can find a task without knowing which project it lives in.
   *
   * Workspace-level and single-mount for the obvious reason: a project-scoped spelling of "all
   * projects" is a contradiction. The per-project source is chosen the same way the automation
   * coordinator's boot fan-out chooses it (`bootContext` for the boot project, `contexts.peek`
   * for anything this process already owns, disk otherwise) — and never `contexts.context()`,
   * which would build a context, prune worktrees and `recover()` running agents. Typing in a
   * search box must not resume work; see `runs/run-index.ts`.
   */
  const coldRepoHandles = new ColdRepoHandles(deps.forgeFactory);

  /**
   * Every registered project whose runs can be read, and its owned store when this process holds
   * one (`bootContext` for the boot project, `contexts.peek` otherwise) — never a built context.
   * Without a store, the caller reads the project cold from `dataDir` with `handle`. The source
   * rule both workspace run routes share, so the index and the search can never disagree on it.
   */
  const projectRunSources = async (): Promise<Array<{
    project: ProjectListEntry; store: RunStore | undefined; dataDir: string; handle: RepoHandle | null | undefined;
  }>> => {
    let projects: ProjectListEntry[] = [];
    try {
      projects = await workspaceProjects.listVisibleProjects();
    } catch {
      // unreadable workspace — no rows, never a 500. The palette degrades to the active
      // project's own run list, which it holds either way.
    }
    const bootId = await resolveBootProject(projects);
    coldRepoHandles.retainRoots(new Set(projects
      .filter((project) => project.status !== 'missing' && project.id !== bootId && !contexts.peek(project.id))
      .map((project) => project.root)));
    // No folder, no runs to read. `not-git` still has an `.ai/cezar` worth indexing.
    return projects.filter((project) => project.status !== 'missing').map((project) => {
      const owned = project.id === bootId ? bootContext : contexts.peek(project.id);
      // A cold project's repository identity only: asking for an owned one starts a discovery
      // nothing reads.
      return { project, store: owned?.store, dataDir: join(project.root, '.ai/cezar'), handle: owned ? undefined : coldRepoHandles.get(project.root) };
    });
  };

  /**
   * One project's contribution to a workspace run route. An owned store throws what its database
   * throws (busy, damaged); like a cold project that cannot be read, it then contributes nothing,
   * so one project never fails every project's index or search (#864).
   */
  const readProjectRuns = (projectId: string, read: () => { runs: RunSummary[]; truncated: boolean }) => {
    try {
      return read();
    } catch (error) {
      console.warn(`[cez] runs of project ${projectId} could not be read for the workspace run index: ${error instanceof Error ? error.message : String(error)}`);
      return { runs: [], truncated: false };
    }
  };

  const runsIndexRoutes = new Hono()
    .get('/workspace/runs-index', async (c) => {
      const runs: RunIndexEntry[] = [];
      const truncated: string[] = [];
      // Statuses the server already holds, shipped WITH the rows that carry the references. The
      // cockpit would otherwise ask for them a beat after the table paints — one round trip per
      // project, and a visible flash of un-coloured chips before it lands. Cache-only, so this
      // never touches `gh` and never slows the index down; anything cold stays absent and the
      // lazy `/github/ref-status` route fills it in.
      const referenceStatuses: RunsIndexResponse['referenceStatuses'] = {};
      for (const { project, store: owned, dataDir, handle } of await projectRunSources()) {
        // Both sources answer the same window, newest first: every unarchived run, plus the
        // newest archived roots (#864). An owned project lays its held records over its rows; a
        // cold one reads its stored summaries, at most one archived root past the window.
        //
        // Archived runs are INCLUDED. The active project's rows reach the palette through
        // `GET /run-summaries`, which carries them too, and excluding them here would mean a task
        // is findable while you stand in its project and vanishes the moment you leave — the
        // exact asymmetry a cross-project finder exists to remove.
        const window = readProjectRuns(project.id, () => owned
          ? owned.listRunSummaries({ archivedWindow: RUNS_INDEX_PER_PROJECT, roots: true })
          : readRunIndexFromDisk(dataDir, { handle, archivedWindow: RUNS_INDEX_PER_PROJECT, roots: true }));
        if (window.truncated) truncated.push(project.id);
        const recent = window.runs.map(withLiveUsage);
        const mentioned: number[] = [];
        for (const run of recent) {
          runs.push({ projectId: project.id, ...run });
          mentioned.push(...mentionedReferenceNumbers(run));
        }
        if (mentioned.length > 0) {
          const cached = resolveForgeRoot(project.root, deps.forgeFactory).cachedRefStatuses(mentioned);
          // Only when something was actually warm. A project key holding two empty maps is noise
          // that every consumer would have to look past, and it would blur the one rule this
          // payload has: absent means nothing is known.
          if (Object.keys(cached.prs).length > 0 || Object.keys(cached.issues).length > 0) {
            referenceStatuses[project.id] = cached;
          }
        }
      }
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const body: RunsIndexResponse = {
        runs,
        perProjectLimit: RUNS_INDEX_PER_PROJECT,
        truncated,
        referenceStatuses,
      };
      return c.json(body);
    })
    /**
     * `GET /workspace/runs-search` (#864) — every registered project's ROOT runs, archived or not,
     * that match `q`, newest first: what lets ⌘K find a run past a project's window. Same source
     * rule and the same side-effect-free contract as the index above.
     */
    .get('/workspace/runs-search', queryZodValidator(runsSearchQuerySchema), async (c) => {
      const { q, limit = RUNS_SEARCH_PER_PROJECT_MAX } = c.req.valid('query');
      const runs: RunIndexEntry[] = [];
      const truncated: string[] = [];
      const tokens = searchTokens(q);
      for (const { project, store: owned, dataDir, handle } of await projectRunSources()) {
        // The palette filters its rows by project name too, so a token naming this project is
        // already satisfied here: `shop database` searches shop for `database` (#864 review). A
        // query that only names the project adds nothing past the index's rows for it.
        const name = project.name.toLowerCase();
        const rest = tokens.filter((token) => !name.includes(token));
        if (rest.length === 0) continue;
        const scoped = rest.join(' ');
        const found = readProjectRuns(project.id, () => owned ? owned.searchRunSummaries(scoped, limit) : searchRunIndexFromDisk(dataDir, scoped, { handle, limit }));
        if (found.truncated) truncated.push(project.id);
        for (const run of found.runs) runs.push({ projectId: project.id, ...withLiveUsage(run) });
      }
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const body: RunsSearchResponse = { runs, truncated };
      return c.json(body);
    });

  // Workspace-level families answer for the whole workspace, so they are single-mount: never a
  // project-scoped spelling, which would be a second surface to protect with no consumer.
  const liveRoutes = createLiveRoutes({ serverGeneration, resolveBootProject,
    projectFailure: workspaceProjects.liveFailure,
    resolveProject: (id) => workspaceProjects.resolveLiveProject(id),
  });
  const workspaceV1 = new Hono()
    .route('/', liveRoutes)
    .route('/', healthRoutes)
    .route('/', modelsRoutes)
    .route('/', providersRoutes)
    .route('/', projectsRoutes)
    .route('/', agentProfilesRoutes)
    .route('/', createSelfUpdateRoutes(deps, () => capabilities().localHandoff, () => [deps.store, ...contexts.ids().flatMap((id) => contexts.peek(id)?.store ?? [])]))
    .route('/', applicationUpdateRoutes)
    .route('/', workspaceConfigRoutes)
    .route('/', fsBrowseRoutes)
    .route('/', automationChecksRoutes)
    .route('/', runsIndexRoutes)
    .route('/', workspaceEventsRoutes);

  // ---- mount ---------------------------------------------------------------
  // Scoped first, then the unscoped alias bound to the boot project. The paths are disjoint (no
  // route starts with `/p/`), so order between the two never decides a match — but the SPA
  // catch-all below must still come last. `route()` re-registers the sub-app's routes under
  // each prefix, handlers shared, internal order preserved.
  //
  // Workspace families mount LAST and that is load-bearing: mounting the project table also
  // mounts its `use('*')` scope resolver over the whole prefix, and Hono runs matched middleware
  // in registration order. `/health` in particular answers for the workspace, has no project to
  // resolve, and is the CORS-open discovery route — it must not sit behind the resolver.
  const routed = app
    .route(V1_SCOPED_PREFIX, v1)
    .route(V1_PREFIX, v1)
    .route(V1_PREFIX, workspaceV1);

  // ---- SPA catch-all -------------------------------------------------------
  // Last, so every route above still wins. Any other GET gets the cockpit shell:
  // react-router owns the route map, including the 404, so `/tasks/:id/changes`
  // cold-loads and survives a refresh instead of 404ing. `/api/*` and the static
  // files above resolve to `passthrough` and fall through to Hono's own 404 —
  // an unknown API path must never answer with HTML.
  // Without a web/dist build this serves the built-in build-hint page (dev-only
  // state — the published tarball ships web/dist), never a 404.
  routed.get('*', (c) => serveShell(c) ?? c.notFound());

  return routed;
}

/** The host a thread link names (#589): the bound one, or loopback for a wildcard bind. */
/** The built-in skills a project's manager offers (#774). Test apps inject partial managers. */
function builtinSkillsOf(manager: Partial<Pick<RunManager, 'builtinSkills'>>): Skill[] {
  return manager.builtinSkills?.() ?? [];
}

function taskWebhookHost(bindHost: string | undefined): string {
  if (!bindHost || bindHost === '0.0.0.0' || bindHost === '::') return '127.0.0.1';
  return bindHost.includes(':') ? `[${bindHost}]` : bindHost;
}

/** The origin a local client reaches this cockpit at: `CEZ_COCKPIT_URL` and the task webhook's links (#774, #594). */
export function cockpitOriginFor(bindHost: string | undefined, port: number): string {
  return `http://${taskWebhookHost(bindHost)}:${port}`;
}

const webhookNameTakenError = (name: string) => `this project already has a webhook named "${name.trim()}" — pick another name`;

export function startServer(deps: ServerDeps, port: number, listener?: Server): ServerType & { shutdownForRestart: () => Promise<void> } {
  const workspaceEvents = deps.workspaceEvents ?? new WorkspaceEventBus();
  // The subscription hub rides the same HTTP server (one port, zero config):
  // createApp registers the topics, the `upgrade` hook below owns the socket.
  const socketHub = deps.socketHub ?? createSocketHub();
  // `cezar_preview_serve` refuses the cockpit's own port: the one the listener BOUND (`--port 0`).
  let listeningPort: number | undefined;
  const cezarPort = deps.cezarPort ?? (() => listeningPort);
  const workspaceProjects = deps.workspaceProjects ?? createWorkspaceProjects({ bootRoot: deps.repoRoot, bootProjectId: deps.bootProjectId, bindHost: deps.bindHost });
  const automationCoordinator = new AutomationCoordinator({ listProjects });
  const bootProjectId = deps.bootProjectId ?? 'default';
  const bootAutomationStore = automationCoordinator.store(bootProjectId, deps.repoRoot)!;
  const taskWebhooks = createTaskWebhooks(deps);
  // #774: the bound origin every agent env carries (`CEZ_COCKPIT_URL`), so `cez automation` calls
  // this cockpit instead of probing ports. Unset until `listening`; a project built after that is
  // addressed in `prepareManager`, before its recovery resumes anything.
  let cockpitOrigin: string | undefined;
  const addressManager = (project: { id: string; manager: Pick<RunManager, 'setCockpitAddress'> }) => {
    if (cockpitOrigin) project.manager.setCockpitAddress?.({ origin: cockpitOrigin, projectId: project.id });
  };
  const sharedContexts = createWorkspaceProjectContexts(deps, taskWebhooks, {
    ownership: deps.ownership,
    listProjects,
    cezarPort,
    automationStore: (projectId, root) => automationCoordinator.store(projectId, root)!,
    addressManager,
  });
  const archiveDeps: import('./archive-on-merge.ts').ArchiveOnMergeDeps = {
    projects: async () => {
      const boot = { id: bootProjectId, root: deps.repoRoot, status: 'ok' as const };
      if (workspaceProjects.singleProject()) return [boot];
      return [boot, ...(await listProjects()).filter(project => project.id !== bootProjectId && project.root !== deps.repoRoot)];
    },
    enabled: async project => resolveArchiveOnMerge(await loadConfig(project.root), await loadWorkspaceConfig()).enabled,
    repository: async project => {
      const repository = await resolveForgeRoot(project.root, deps.forgeFactory).discoverRepository();
      return repository.status === 'resolved' ? forgeRepositoryUrl('github', repository.handle.owner, repository.handle.name) : undefined;
    },
    withStore: async (project, work) => {
      if (project.root === deps.repoRoot) return work(deps.store, id => deps.manager.isActive?.(id) ?? false, () => server.listening);
      return sharedContexts.withMaintenanceStore(project.id, (store, valid) =>
        work(store, id => sharedContexts.peek(project.id)?.manager.isActive(id) ?? false, valid));
    },
    lookup: (root, identities, signal) => resolveForgeRoot(root, deps.forgeFactory).mergedPullRequests(identities, signal),
  };
  const archiveOnMerge = new ArchiveOnMergeCoordinator(archiveDeps);
  const completionActions = new CompletionActionCoordinator({
    projects: archiveDeps.projects,
    withStore: (project, work) => archiveDeps.withStore(project, (store, _active, valid) => work(store, valid)),
    forge: async project => {
      const info = await getRepoInfo(project.root);
      const driver = resolveForge(info, deps.forgeFactory);
      const repository = info?.remote ? forgeWebRoot(info.remote) : null;
      return driver && repository ? { driver, repository } : undefined;
    },
    head: (project, branch) => getBranchHead(project.root, branch),
  });
  // Injected contexts (tests) skip `prepareManager`.
  sharedContexts.onContextBuilt(addressManager);
  // #801: GitHub automations are opt-in. Off, the flag must remove the BEHAVIOR and not merely
  // the UI — no scheduler, no GitHub polling, no launched runs — so every entry point into the
  // workspace scheduler below is gated on it. Read per call rather than captured, for the same
  // reason `capabilities()` is inside `createApp`: tests flip the variable between apps.
  const automationsEnabled = () => resolveCapabilities(process.env, deps.bindHost).automations;
  let rescheduleAutomations = () => {};
  const app = createApp({
    ...deps,
    taskWebhooks,
    contexts: sharedContexts,
    automationStore: bootAutomationStore,
    workspaceEvents,
    socketHub,
    cezarPort,
    workspaceProjects,
    archiveOnMergeChanged: () => archiveOnMerge.invalidate(),
    automationsChanged: () => rescheduleAutomations(),
  });
  // SECURITY: default to loopback. This server executes agents locally and its endpoints are
  // same-origin-trusted (only /api/health is CORS-open); binding to a non-loopback host would
  // expose an agent-executing box to the network. `bindHost` exists only for a deliberate
  // hosted/VPS deployment (which also flips CEZ_REMOTE to gate the local-handoff endpoints) —
  // The CLI passes it only when explicitly requested; normal startup stays on loopback.
  const serverOptions: Parameters<typeof serve>[0] = {
    fetch: async (request, env) => {
      const result = await app.fetch(request, env);
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/v1/workspace/application-update/restart'
        && result.status === 200) {
        // Arming is server-owned. A connected caller must receive the complete
        // acknowledgement before shutdown; a caller that already disconnected
        // cannot leave its explicitly requested, armed restart stranded.
        const response = env.outgoing;
        const handoff = () => {
          response.off('finish', handoff);
          response.off('close', handoff);
          deps.applicationUpdate?.afterResponse?.();
        };
        if (response.destroyed) handoff();
        else {
          response.once('finish', handoff);
          response.once('close', handoff);
        }
      }
      return result;
    },
    port,
    hostname: deps.bindHost ?? '127.0.0.1',
  };
  // The CLI already owns this listener before recovery. Replace its temporary 503
  // handler without closing/rebinding; direct server callers retain normal startup.
  if (listener) {
    listener.removeAllListeners('request');
    listener.on('request', getRequestListener(serverOptions.fetch, defined({ hostname: serverOptions.hostname })));
  }
  const server = listener ?? serve(serverOptions);
  // EVERY registered project, remote or not: a schedule needs none. `github` is present only for
  // a github.com remote, and only then does the project's handle poll.
  const automationProjects = new Map<string, { root: string; github?: { owner: string; repo: string } }>();
  const rememberAutomationProject = async (id: string, root: string): Promise<void> => {
    const repoRemote = (await getRepoInfo(root))?.remote;
    const parsed = parseRemote(repoRemote ?? '');
    automationProjects.set(id, {
      root,
      ...(parsed && forgeKindOfRemote(repoRemote) === 'github' ? { github: { owner: parsed.owner, repo: parsed.repo } } : {}),
    });
  };
  const emitWorkspaceAutomationChange = (projectId: string) => (automationId: string, revision: number) =>
    workspaceEvents.emit('automation-change', { project: projectId, automationId, revision });
  /**
   * The boot brake for one project, at boot and for a project registered after it: an enabled
   * poll idle past its lookback is re-baselined rather than resumed from a stale cursor. Only a
   * project with a github.com remote: its polls are the only ones the timer arms, so a poll
   * without one never succeeds and would be re-baselined on every boot, forever.
   */
  const brakeIdleAutomations = (id: string, automationStore: AutomationStore | undefined): void => {
    if (!automationStore || !automationProjects.get(id)?.github) return;
    rebaselineIdleAutomations(automationStore, emitWorkspaceAutomationChange(id));
  };
  const automationScheduler = new WorkspaceAutomationScheduler({
    coordinator: automationCoordinator,
    handle: (projectId, store) => {
      const project = automationProjects.get(projectId);
      if (!project) return undefined;
      const timeZone = localTimeZone();
      const launchContext = async () => projectId === (deps.bootProjectId ?? 'default')
        ? { root: deps.repoRoot, manager: deps.manager, store: deps.store }
        : await sharedContexts.context(projectId);
      return {
        projectId,
        store,
        timeZone,
        ...(project.github ? { github: { ...project.github, poller: new GithubPoller() } } : {}),
        onChange: emitWorkspaceAutomationChange(projectId),
        // Building a lazy project's context reconciles on its own; the explicit call covers the
        // boot project and a context built before another process left the reservation.
        reconcileReceipts: async () => { reconcileAutomationReceipts(store, (await launchContext()).store); },
        // A run store that cannot open (#779) launches nothing. Firing anyway would count every
        // refusal towards the auto-pause, and the pause would outlive the restart that fixed it.
        ready: async () => {
          try {
            const { store: runs } = await launchContext();
            if (runs.unavailable) throw runs.unavailable;
          } catch (error) {
            if (error instanceof RunStoreOpenError) throw new AutomationProjectUnavailableError(error.message, { cause: error });
            throw error;
          }
        },
        launchSchedule: async (definition, occurrence, receiptId) => {
          const context = await launchContext();
          return launchScheduledRun({
            root: context.root,
            manager: context.manager,
            store: context.store,
            definition,
            occurrence,
            receiptId,
            projectName: basename(context.root),
            timeZone,
          });
        },
        launch: async (definition, candidate, receiptId) => {
          const context = await launchContext();
          return launchAutomationRun({
            root: context.root,
            manager: context.manager,
            store: context.store,
            definition,
            candidate,
            receiptId,
          });
        },
      };
    },
  });
  // The scheduler is inert until `start()` anyway (it constructs `stopped`), but the gate is
  // stated here rather than inherited from that detail: a definition saved while the flag is off
  // must not even ask the coordinator to refresh.
  rescheduleAutomations = () => {
    if (!automationsEnabled()) return;
    void automationScheduler.reschedule();
  };
  const unsubscribe = workspaceEvents.on((event, data) => {
    if (event === 'project-added') {
      const project = (data as { project?: { id?: unknown; root?: unknown; status?: unknown } }).project;
      if (project && typeof project.id === 'string' && typeof project.root === 'string' && project.status !== 'missing') {
        const { id, root } = project as { id: string; root: string };
        void rememberAutomationProject(id, root).then(() => {
          if (!automationsEnabled()) return;
          brakeIdleAutomations(id, automationCoordinator.store(id, root));
          return rescheduleAutomations();
        }).catch(() => undefined);
      }
    } else if (event === 'project-removed') {
      const id = (data as { id?: unknown }).id;
      if (typeof id === 'string') {
        automationCoordinator.remove(id);
        automationProjects.delete(id);
        rescheduleAutomations();
      }
    }
  });
  const startBackgroundServices = () => {
    archiveOnMerge.start();
    completionActions.start();
    void listProjects().then((projects) => {
      const all = projects.some((project) => project.root === deps.repoRoot)
        ? projects : [{ id: deps.bootProjectId ?? 'default', root: deps.repoRoot, status: 'ok' as const }, ...projects];
      // #781: every registered project's preview leftovers, not only the boot project's.
      void sweepRegisteredPreviewLeftovers(all, deps.previewHost).catch(() => 0);
      // #667: build every other project's context now, so the first click on one does not pay
      // its store open, worktree sweeps and recovery. The boot project is built already.
      // Not after a close that landed while the registry was being read: `disposeAll` has run, and
      // a warm-up started now would build contexts nothing will ever dispose.
      // Not in single-project mode either: every other project is out of reach there, and
      // building one would resume its interrupted runs behind the operator's back.
      if (projectWarmupEnabled() && server.listening && !resolveCapabilities(process.env, deps.bindHost).singleProject) {
        const bootId = deps.bootProjectId ?? 'default';
        void sharedContexts.warmAll(all.filter((project) => project.id !== bootId && project.root !== deps.repoRoot))
          .catch(() => undefined);
      }
      // #801: with automations off there is nothing to warm — no remote to resolve, no receipts
      // to reconcile, and above all no scheduler to start.
      if (!automationsEnabled()) return;
      void Promise.all(all.map(async (project) => {
        await rememberAutomationProject(project.id, project.root);
        const automationStore = automationCoordinator.store(project.id, project.root);
        const runStore = project.id === (deps.bootProjectId ?? 'default')
          ? deps.store
          : sharedContexts.peek(project.id)?.store;
        // A run store that could not open (#779) cannot say which receipts launched a run.
        if (automationStore && runStore && !runStore.unavailable) reconcileAutomationReceipts(automationStore, runStore);
        // After reconciliation and before the timer arms.
        brakeIdleAutomations(project.id, automationStore);
      })).then(() => automationScheduler.start()).catch(() => undefined);
    }).catch(() => undefined);
  };
  if (server.listening) startBackgroundServices();
  else server.once('listening', startBackgroundServices);
  // The boot store's preview leftovers and run deletions; lazy projects arm theirs at build.
  armPreview(deps.store, join(deps.repoRoot, '.ai/cezar'), deps.previewHost);
  const previewSockets = createPreviewSockets({
    host: deps.previewHost, cockpitOrigin: () => cockpitOrigin,
    verify: (req) => verifyWsUpgrade(req, deps.bindHost),
    resolveProject: (projectId) => workspaceProjects.lookupProject(projectId),
  });
  server.once('close', () => {
    unsubscribe(); archiveOnMerge.stop(); completionActions.stop(); automationScheduler.stop(); sharedContexts.disposeAll(); void deps.delegation?.close();
    socketHub.close();
    previewSockets.close();
    void deps.previewHost?.close().catch(() => undefined);
  });
  // The one `upgrade` listener: the subscription bus and the preview's sockets (hearsay-tools/cezarion#781).
  attachUpgradeRouter(server, [socketHubRoute(socketHub, (req) => verifyWsUpgrade(req, deps.bindHost)), ...previewSockets.routes]);
  const shutdownForRestart = async (): Promise<void> => {
    archiveOnMerge.stop(); completionActions.stop();
    sharedContexts.disposeAll(); // close every built secondary project before old process exits
    deps.store.flush();
    socketHub.close();
    // Dev servers run in their own process groups: they outlive cezar unless stopped here.
    // A failed release must not abort the restart halfway, with the store flushed and the port still bound.
    await deps.previewHost?.close().catch(() => undefined);
    previewSockets.close();
    await deps.delegation?.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
    // Last, with no request left to serve: write what is still pending and release every claim,
    // so the replacement process finds the live runs nobody's, as a clean stop leaves them (#779).
    deps.store.close();
  };
  // The task webhook's thread links name the port the listener BOUND (#594 review): `--port 0`
  // asks for an ephemeral one, so the requested number is not an address. Deliveries queue
  // behind this, so none goes out before it is set.
  const setTaskWebhookOrigin = () => {
    const address = server.address();
    const bound = address && typeof address === 'object' ? address.port : port;
    listeningPort = bound;
    cockpitOrigin = cockpitOriginFor(deps.bindHost, bound);
    taskWebhooks.setOrigin(cockpitOrigin);
    addressManager({ id: bootProjectId, manager: deps.manager });
    for (const id of sharedContexts.ids()) {
      const context = sharedContexts.peek(id);
      if (context) addressManager(context);
    }
  };
  if (server.listening) setTaskWebhookOrigin();
  else server.once('listening', setTaskWebhookOrigin);
  return Object.assign(server, { shutdownForRestart });
}

/**
 * Validate topic-bus upgrades before handshake. Local Host must be loopback. Same-authority or
 * native clients are trusted; verified dev proxies are trusted. Metadata-free foreign loopback
 * origins are untrusted and may read only loopbackReadable topics.
 */
export function verifyWsUpgrade(req: IncomingMessage, bindHost?: string): WsUpgradeVerdict {
  const host = req.headers.host;
  const hostName = hostnameOfHost(host);
  const hosted = !resolveCapabilities(process.env, bindHost).localHandoff;
  if (!hosted && !isLoopbackHostHeader(hostName)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return { trusted: true }; // non-browser client — no Origin to spoof
  // Scheme-checked, like the HTTP guard's comparison: `authorityOfOrigin` is
  // null for anything that is not an http(s) URL, so the opaque `"null"` origin
  // of a sandboxed iframe AND a `ftp://127.0.0.1`-shaped one both stay out
  // rather than reaching the loopback test below on hostname alone.
  const originAuthority = authorityOfOrigin(origin);
  const originHost = hostnameOfOrigin(origin);
  if (originAuthority === null || !originHost) return false;
  if (originAuthority === authorityOfHost(host)) return { trusted: true }; // the cockpit itself
  // The dev-proxy fallback. An explicit `cross-site`/`same-site` is an attacker
  // page on another local port and is refused even though both ends are
  // loopback; anything else needs loopback on both ends to get in at all.
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false;
  if (!isLoopbackHostHeader(originHost) || !isLoopbackHostHeader(hostName)) return false;
  // Loopback on both ends, admitted. If the browser vouches it is same-origin
  // (`Sec-Fetch-Site: same-origin`, unforgeable by page JS), this is the dev
  // proxy on Chromium → trust it. An ABSENT header is a browser that ships no
  // metadata (Safari/Firefox), where the dev proxy and a foreign local page are
  // indistinguishable: admit as UNTRUSTED so only `loopbackReadable` topics show.
  return { trusted: fetchSite === 'same-origin' };
}

/** The bare hostname of a `Host` header — see `normalizeHostname`. `''` when the
 *  header is absent, which no allowlist matches. */
function hostnameOfHost(host: string | undefined): string {
  return host ? normalizeHostname(host) : '';
}

/** The `hostname:port` authority of a `Host` header, e.g. `127.0.0.1:4321`.
 *
 *  The port is kept verbatim and is `''` when the header omits it — which is
 *  exactly when a browser also omits it from `Origin` (both drop the scheme's
 *  default port). That symmetry is what lets us compare the two without knowing
 *  our own scheme, which we cannot know behind a TLS-terminating proxy. */
function authorityOfHost(host: string | undefined): string {
  if (!host) return '';
  const port = host.match(/^\[[^\]]*\]:(\d+)$/)?.[1] ?? host.match(/^[^:]*:(\d+)$/)?.[1] ?? '';
  return `${normalizeHostname(host)}:${port}`;
}

/** The `hostname:port` authority of an `Origin` header, or `null` when it is not
 *  a parseable http(s) URL (the opaque `"null"` origin of a sandboxed iframe, a
 *  `file://` page). `URL.port` is `''` for a scheme's default port, matching
 *  `authorityOfHost`. */
function authorityOfOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${normalizeHostname(u.hostname)}:${u.port}`;
  } catch {
    return null;
  }
}

/** The hostname of an `Origin` header, or `null` when it is not a parseable URL
 *  (e.g. the opaque `"null"` origin of a sandboxed iframe). Normalized through
 *  the same path as `hostnameOfHost` so the two compare equal for IPv6 and for
 *  trailing-dot FQDNs. */
function hostnameOfOrigin(origin: string): string | null {
  try {
    return normalizeHostname(new URL(origin).hostname);
  } catch {
    return null;
  }
}

function resolveWebDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/server (built) or <pkg>/src/server (tsx dev).
  return join(here, '..', '..', 'web');
}

/**
 * The session id shape every backend actually mints: UUIDs (claude/codex) and
 * the CLIs' own slug-ish ids. No character here is special to bash, AppleScript
 * OR cmd.exe, and a leading `-` is refused so the id can never be read as an
 * option by the CLI it is passed to (same dash-guard as `isSafeGitRef`, #431).
 * Bounded, like every other input that reaches a spawned process.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,199}$/;

/** True for session ids safe to splice into the take-over command (see above). */
export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

/**
 * Build native session takeover commands. Legacy/undefined backend defaults to Claude. Refuse
 * unrecognized session-id shapes rather than embedding unsafe or platform-misquoted values.
 */
export function resumeCommand(runner: string | undefined, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  switch (runner) {
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'opencode':
      return `opencode --session ${sessionId}`;
    case 'cursor': {
      const executable = quoteExecutable(resolveCursorExecutable(), process.platform);
      return executable === null ? null : `${executable} --resume ${sessionId}`;
    }
    case 'pi':
      return `pi --session ${sessionId}`;
    case 'omp': {
      // CEZ_OMP_BIN may name a different install than `omp` on PATH; resume with the configured one.
      const executable = quoteExecutable(resolveOmpExecutable(), process.platform);
      return executable === null ? null : `${executable} --resume ${sessionId}`;
    }
    default:
      return `claude --resume ${sessionId}`;
  }
}
