/**
 * The field merge behind `PUT /workspace/config` (hearsay-tools/cezarion#2849).
 *
 * The PUT handler owns the writable-root probe and the family chain. This
 * module mutates the in-memory config the write lock already loaded. Roots stay
 * as written (`~` kept); only the probe expands them.
 */
import type { SetWorkspaceConfigInput } from '@open-mercato/cezar-contract/workspace';
import { PROVIDER_IDS } from '../core/provider-auth.ts';
import type { WorkspaceConfig } from '../workspace/config.ts';

function applyComposerDefaults(
  config: WorkspaceConfig,
  composerDefaults: SetWorkspaceConfigInput['composerDefaults'],
): void {
  if (!composerDefaults) return;
  if (composerDefaults.autonomous === null) delete config.composerDefaults.autonomous;
  else if (composerDefaults.autonomous !== undefined) {
    config.composerDefaults.autonomous = composerDefaults.autonomous;
  }
  if (composerDefaults.worktree === null) delete config.composerDefaults.worktree;
  else if (composerDefaults.worktree !== undefined) {
    config.composerDefaults.worktree = composerDefaults.worktree;
  }
}

function applyWorkspaceResources(
  config: WorkspaceConfig,
  resources: SetWorkspaceConfigInput['resources'],
): void {
  if (!resources) return;
  if (resources.maxParallel !== undefined) config.resources.maxParallel = resources.maxParallel;
  if (resources.maxMonitoringSessions !== undefined) {
    config.resources.maxMonitoringSessions = resources.maxMonitoringSessions;
  }
  if (resources.monitoringWakeIntervalMinutes !== undefined) {
    config.resources.monitoringWakeIntervalMinutes = resources.monitoringWakeIntervalMinutes;
  }
  if (resources.autoResumeOnUsageLimit !== undefined) {
    config.resources.autoResumeOnUsageLimit = resources.autoResumeOnUsageLimit;
  }
  if (resources.memoryLimitMb !== undefined) config.resources.memoryLimitMb = resources.memoryLimitMb;
  if (resources.worktreeRetentionDefault !== undefined) {
    config.resources.worktreeRetentionDefault = resources.worktreeRetentionDefault;
  }
}

function applyAgentDefaults(
  config: WorkspaceConfig,
  agentDefaults: SetWorkspaceConfigInput['agentDefaults'],
): void {
  if (!agentDefaults) return;
  // `null` CLEARS back to "no opinion" — a partial patch cannot say that by omission,
  // and leaving a stale runner behind would keep overriding repos that never chose.
  if (agentDefaults.runner === null) delete config.agentDefaults.runner;
  else if (agentDefaults.runner !== undefined) config.agentDefaults.runner = agentDefaults.runner;
  for (const runner of PROVIDER_IDS) {
    const model = agentDefaults.models?.[runner];
    if (model === undefined) continue;
    const models = config.agentDefaults.models ?? {};
    if (model === null) delete models[runner];
    else models[runner] = model;
    // An empty object would persist a key that says nothing; absence is the same answer.
    if (Object.keys(models).length === 0) delete config.agentDefaults.models;
    else config.agentDefaults.models = models;
  }
}

/** Apply a partial `PUT /workspace/config` body onto the loaded config, in place. */
export function applyWorkspaceConfigPatch(config: WorkspaceConfig, body: SetWorkspaceConfigInput): void {
  if (body.browseRoot !== undefined) config.browseRoot = body.browseRoot;
  if (body.projectsDir !== undefined) config.projectsDir = body.projectsDir;
  if (body.archiveOnMerge === null) delete config.archiveOnMerge;
  else if (body.archiveOnMerge !== undefined) config.archiveOnMerge = body.archiveOnMerge;
  applyComposerDefaults(config, body.composerDefaults);
  applyWorkspaceResources(config, body.resources);
  applyAgentDefaults(config, body.agentDefaults);
}
