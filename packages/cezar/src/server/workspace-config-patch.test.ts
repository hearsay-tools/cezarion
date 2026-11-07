import { describe, expect, it } from 'vitest';
import { defaultWorkspaceConfig } from '../workspace/config.ts';
import { applyWorkspaceConfigPatch } from './workspace-config-patch.ts';

/**
 * The field merge behind `PUT /workspace/config` (hearsay-tools/cezarion#2849). Route answers
 * stay in `workspace-api.test.ts`; this file pins the in-memory mutator the write lock calls.
 */
describe('applyWorkspaceConfigPatch', () => {
  it('leaves the loaded config when the body names no fields', () => {
    const config = defaultWorkspaceConfig();
    applyWorkspaceConfigPatch(config, {});
    expect(config).toEqual(defaultWorkspaceConfig());
  });

  it('writes roots and archiveOnMerge, and null clears the stored archive flag', () => {
    const config = defaultWorkspaceConfig();
    config.archiveOnMerge = false;
    applyWorkspaceConfigPatch(config, {
      browseRoot: '~/src',
      projectsDir: '~/clones',
      archiveOnMerge: true,
    });
    expect(config.browseRoot).toBe('~/src');
    expect(config.projectsDir).toBe('~/clones');
    expect(config.archiveOnMerge).toBe(true);
    applyWorkspaceConfigPatch(config, { archiveOnMerge: null });
    expect(config.archiveOnMerge).toBeUndefined();
  });

  it('writes, then null-clears, composerDefaults without touching omitted keys', () => {
    const config = defaultWorkspaceConfig();
    applyWorkspaceConfigPatch(config, { composerDefaults: { autonomous: true } });
    expect(config.composerDefaults.autonomous).toBe(true);
    expect(config.composerDefaults.worktree).toBeUndefined();
    applyWorkspaceConfigPatch(config, { composerDefaults: { worktree: false } });
    expect(config.composerDefaults).toEqual({ autonomous: true, worktree: false });
    applyWorkspaceConfigPatch(config, { composerDefaults: { autonomous: null, worktree: null } });
    expect(config.composerDefaults.autonomous).toBeUndefined();
    expect(config.composerDefaults.worktree).toBeUndefined();
  });

  it('writes every resources key the body names', () => {
    const config = defaultWorkspaceConfig();
    applyWorkspaceConfigPatch(config, {
      resources: {
        maxParallel: 5,
        maxMonitoringSessions: 3,
        monitoringWakeIntervalMinutes: 7,
        autoResumeOnUsageLimit: false,
        memoryLimitMb: 2048,
        worktreeRetentionDefault: 4,
      },
    });
    expect(config.resources).toMatchObject({
      maxParallel: 5,
      maxMonitoringSessions: 3,
      monitoringWakeIntervalMinutes: 7,
      autoResumeOnUsageLimit: false,
      memoryLimitMb: 2048,
      worktreeRetentionDefault: 4,
    });
  });

  it('sets, then null-clears, the machine-wide agent runner', () => {
    const config = defaultWorkspaceConfig();
    applyWorkspaceConfigPatch(config, { agentDefaults: { runner: 'codex' } });
    expect(config.agentDefaults.runner).toBe('codex');
    applyWorkspaceConfigPatch(config, { agentDefaults: {} });
    expect(config.agentDefaults.runner).toBe('codex');
    applyWorkspaceConfigPatch(config, { agentDefaults: { runner: null } });
    expect(config.agentDefaults.runner).toBeUndefined();
  });

  it('sets one runner model, leaves the others, and drops an empty models object', () => {
    const config = defaultWorkspaceConfig();
    applyWorkspaceConfigPatch(config, { agentDefaults: { models: { claude: 'sonnet' } } });
    expect(config.agentDefaults.models).toEqual({ claude: 'sonnet' });
    applyWorkspaceConfigPatch(config, { agentDefaults: { models: { cursor: 'model[effort=high]' } } });
    expect(config.agentDefaults.models).toEqual({ claude: 'sonnet', cursor: 'model[effort=high]' });
    applyWorkspaceConfigPatch(config, { agentDefaults: { models: { claude: null } } });
    expect(config.agentDefaults.models).toEqual({ cursor: 'model[effort=high]' });
    applyWorkspaceConfigPatch(config, { agentDefaults: { models: { cursor: null } } });
    expect(config.agentDefaults.models).toBeUndefined();
  });
});
