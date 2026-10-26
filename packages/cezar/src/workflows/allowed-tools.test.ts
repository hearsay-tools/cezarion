import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import {
  allowedToolsForStep,
  DEFAULT_ALLOWED_TOOLS,
  HARNESS_EXTRA_TOOLS,
  stepToolGrant,
  toolGrantLists,
} from './types.ts';

describe('allowedToolsForStep', () => {
  it('unions Pi extras onto the default list when the step does not set allowedTools', () => {
    expect(allowedToolsForStep(undefined, 'pi')).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'Subagent',
      'SubagentSupervisor',
      'SubagentWait',
    ]);
    expect(allowedToolsForStep({ allowedTools: undefined }, 'pi')).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'Subagent',
      'SubagentSupervisor',
      'SubagentWait',
    ]);
  });

  it('leaves Claude/Codex/OpenCode on the default list only', () => {
    for (const backend of ['claude', 'claude-cli', 'codex', 'opencode'] as const) {
      expect(allowedToolsForStep(undefined, backend)).toEqual(DEFAULT_ALLOWED_TOOLS);
    }
    expect(allowedToolsForStep(undefined, undefined)).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  it('returns an explicit allowedTools list unchanged, including empty', () => {
    const narrowed = ['Read', 'Bash'];
    expect(allowedToolsForStep({ allowedTools: narrowed }, 'pi')).toEqual(narrowed);
    expect(allowedToolsForStep({ allowedTools: [] }, 'pi')).toEqual([]);
    expect(allowedToolsForStep({ allowedTools: [...DEFAULT_ALLOWED_TOOLS, 'Subagent'] }, 'claude')).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'Subagent',
    ]);
  });

  it('does not mutate DEFAULT_ALLOWED_TOOLS', () => {
    const before = [...DEFAULT_ALLOWED_TOOLS];
    allowedToolsForStep(undefined, 'pi').push('nope');
    expect(DEFAULT_ALLOWED_TOOLS).toEqual(before);
  });

  it('has an extras row for every selectable runner', () => {
    expect(Object.keys(HARNESS_EXTRA_TOOLS).sort()).toEqual([...RUNNER_IDS].sort());
    expect(HARNESS_EXTRA_TOOLS.pi).toEqual(['Subagent', 'SubagentSupervisor', 'SubagentWait']);
    expect(HARNESS_EXTRA_TOOLS.claude).toEqual([]);
  });
});

describe('stepToolGrant (hearsay-tools/cezarion#1810)', () => {
  const PI_DEFAULT = [...DEFAULT_ALLOWED_TOOLS, 'Subagent', 'SubagentSupervisor', 'SubagentWait'];

  it("resolves a step without allowedTools to this runner's step default", () => {
    expect(stepToolGrant(undefined, undefined, 'pi')).toEqual({ kind: 'step-default', tools: PI_DEFAULT });
    expect(stepToolGrant(undefined, { bashAllowlist: ['git status'] }, 'claude'))
      .toEqual({ kind: 'step-default', tools: DEFAULT_ALLOWED_TOOLS, bashAllowlist: ['git status'] });
  });

  it('resolves a written list to explicit, an empty one and a copy of the default included', () => {
    expect(stepToolGrant(undefined, { allowedTools: [] }, 'pi')).toEqual({ kind: 'explicit', tools: [] });
    expect(stepToolGrant(undefined, { allowedTools: [...PI_DEFAULT] }, 'pi')).toEqual({ kind: 'explicit', tools: PI_DEFAULT });
    expect(stepToolGrant(undefined, { allowedTools: ['Read'], bashAllowlist: [] }, 'omp'))
      .toEqual({ kind: 'explicit', tools: ['Read'], bashAllowlist: [] });
  });

  it("resolves a worker's pinned grants to inherited, whatever its step says", () => {
    const step = { allowedTools: ['Read'], bashAllowlist: ['ls'] };
    expect(stepToolGrant({ allowedTools: DEFAULT_ALLOWED_TOOLS }, step, 'pi')).toEqual({ kind: 'inherited', tools: DEFAULT_ALLOWED_TOOLS });
    expect(stepToolGrant({ allowedTools: [], bashAllowlist: ['git status'] }, step, 'pi'))
      .toEqual({ kind: 'inherited', tools: [], bashAllowlist: ['git status'] });
  });

  it('resolves pinned grants without a list to unset, keeping their bashAllowlist', () => {
    expect(stepToolGrant({}, { allowedTools: ['Read'] }, 'omp')).toEqual({ kind: 'unset' });
    expect(stepToolGrant({ bashAllowlist: ['git status'] }, undefined, 'omp')).toEqual({ kind: 'unset', bashAllowlist: ['git status'] });
  });

  it('copies every list it hands out', () => {
    const tools = ['Read'];
    const grant = stepToolGrant(undefined, { allowedTools: tools }, 'claude');
    tools.push('Bash');
    expect(grant).toEqual({ kind: 'explicit', tools: ['Read'] });
  });
});

describe('toolGrantLists', () => {
  it('hands the lists back for the settings a worker inherits, with no list for unset', () => {
    expect(toolGrantLists({ kind: 'unset' })).toEqual({});
    expect(toolGrantLists({ kind: 'unset', bashAllowlist: ['ls'] })).toEqual({ bashAllowlist: ['ls'] });
    expect(toolGrantLists({ kind: 'step-default', tools: ['Read'] })).toEqual({ allowedTools: ['Read'] });
    expect(toolGrantLists({ kind: 'explicit', tools: [], bashAllowlist: [] })).toEqual({ allowedTools: [], bashAllowlist: [] });
  });

  it('round-trips a worker grant through stepToolGrant', () => {
    for (const pinned of [{}, { allowedTools: ['Read'] }, { allowedTools: [], bashAllowlist: ['git status'] }, { bashAllowlist: [] }]) {
      expect(toolGrantLists(stepToolGrant(pinned, undefined, 'claude'))).toEqual(pinned);
    }
  });
});
