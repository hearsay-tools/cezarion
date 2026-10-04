import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import type { AgentRunSpec } from './agent-runner.js';
import { buildOmpArgs, OMP_BUILTIN_TOOL_NAMES, OMP_SPEC_SUPPORT, ompTools } from './omp-runner.js';
import { allowedToolsForStep, DEFAULT_ALLOWED_TOOLS } from '../workflows/types.js';

/** The OMP (Oh My Pi) runner (#595): argv, tool mapping, and the persistent RPC session. */

const base: AgentRunSpec = { cwd: '/repo', userPrompt: 'task', allowedTools: DEFAULT_ALLOWED_TOOLS };
const ciServer = { name: 'cezar', command: process.execPath, args: ['ci-wait.mjs'] };

describe('ompTools', () => {
  it('zero-config step tools map to code tools', () => {
    expect(ompTools(allowedToolsForStep(undefined, 'omp'), {}).tools).toEqual([
      'read', 'edit', 'write', 'grep', 'glob', 'bash', 'todo', 'lsp', 'ast_edit', 'task', 'wait',
    ]);
  });

  it('maps cezar names, keeps OMP built-ins and mcp__ names, drops the rest', () => {
    expect(ompTools(['Subagent', 'TodoWrite', 'WebFetch', 'lsp', 'mcp__srv_tool', 'NotebookEdit'], {})).toEqual({
      flag: 'tools',
      tools: ['task', 'todo', 'read', 'lsp', 'mcp__srv_tool'],
      dropped: ['NotebookEdit'],
    });
    expect(ompTools(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Task', 'WebSearch'], {}).tools).toEqual([
      'read', 'edit', 'write', 'bash', 'grep', 'glob', 'task', 'web_search',
    ]);
  });

  it('dedupes and never passes a name OMP would reject at startup', () => {
    const selection = ompTools(['Read', 'read', 'WebFetch', 'Lsp', 'fetch', 'goal', 'SubagentWait'], {});
    expect(selection).toEqual({ flag: 'tools', tools: ['read'], dropped: ['Lsp', 'fetch', 'goal', 'SubagentWait'] });
    for (const tool of ompTools([...OMP_BUILTIN_TOOL_NAMES, 'Glob', 'TodoWrite'], {}).tools) {
      expect(OMP_BUILTIN_TOOL_NAMES).toContain(tool);
    }
  });

  it('undefined passes no flag, [] passes --no-tools, all-dropped passes --no-tools', () => {
    expect(ompTools(undefined, {}).flag).toBeNull();
    expect(ompTools([], {}).flag).toBe('no-tools');
    expect(ompTools(['NotebookEdit'], {})).toMatchObject({ flag: 'no-tools', dropped: ['NotebookEdit'] });
  });

  it('bashAllowlist drops bash; D1 drops task, wait and eval; cezarTools appends cezar_wait_for_ci', () => {
    expect(ompTools(['Read', 'Bash'], { bashAllowlist: ['npm test'] }).tools).toEqual(['read']);
    expect(ompTools(['Read', 'Bash'], { bashAllowlist: [] }).tools).toEqual(['read', 'bash']);
    expect(ompTools(['Read', 'Subagent', 'wait', 'eval'], { restrictNativeDelegation: true }).tools).toEqual(['read']);
    expect(ompTools(['Read'], { cezarTools: true }).tools).toEqual(['read', 'cezar_wait_for_ci']);
  });

  it('fails closed when every granted tool is narrowed away, and adds no cezar tool to --no-tools', () => {
    expect(ompTools(['Bash'], { bashAllowlist: ['npm test'], cezarTools: true })).toEqual({ flag: 'no-tools', tools: [], dropped: [] });
    expect(ompTools(['Subagent'], { restrictNativeDelegation: true }).flag).toBe('no-tools');
  });

  it('D1 without allowedTools names OMP’s default set minus the delegation tools', () => {
    expect(ompTools(undefined, { restrictNativeDelegation: true })).toEqual({
      flag: 'tools',
      tools: ['read', 'bash', 'edit', 'glob', 'grep', 'todo', 'web_search', 'write'],
      dropped: [],
    });
  });
});

describe('buildOmpArgs', () => {
  it('fresh session', () => {
    expect(
      buildOmpArgs({ ...base, systemPrompt: 'S', model: 'anthropic/claude-x', effort: 'high', additionalDirectories: ['/a', '/b'] }),
    ).toEqual([
      '--mode', 'rpc',
      '--append-system-prompt', 'S',
      '--model', 'anthropic/claude-x',
      '--thinking', 'high',
      '--add-dir', '/a', '--add-dir', '/b',
      '--tools', 'read,edit,write,grep,glob,bash',
    ]);
  });

  it('resume uses --resume and never --session-id or --exclude-tools', () => {
    const resumed = buildOmpArgs({ ...base, sessionId: '0199-abc', resume: true, restrictNativeDelegation: true });
    expect(resumed.slice(0, 4)).toEqual(['--mode', 'rpc', '--resume', '0199-abc']);
    const fresh = buildOmpArgs({ ...base, sessionId: '0199-abc' });
    expect(fresh).not.toContain('--resume');
    expect(fresh).not.toContain('0199-abc');
    for (const args of [resumed, fresh]) {
      expect(args).not.toContain('--session-id');
      expect(args).not.toContain('--session');
      expect(args).not.toContain('--exclude-tools');
    }
  });

  it('D1 adds --config omp-restrict-delegation.yml', () => {
    const args = buildOmpArgs({ ...base, allowedTools: ['Read', 'Subagent'], restrictNativeDelegation: true });
    expect(args).toEqual(['--mode', 'rpc', '--config', expect.stringMatching(/scripts\/omp-restrict-delegation\.yml$/), '--tools', 'read']);
    const overlay = parseYaml(readFileSync(args[3]!, 'utf8')) as unknown;
    expect(overlay).toEqual({ tools: { approval: { task: 'deny' } } });
  });

  it('cezarTools adds --extension omp-ci-wait.mjs before other flags', () => {
    expect(buildOmpArgs({ ...base, cezarTools: ciServer, systemPrompt: 'S' })).toEqual([
      '--mode', 'rpc',
      '--extension', expect.stringMatching(/scripts\/omp-ci-wait\.mjs$/),
      '--append-system-prompt', 'S',
      '--tools', 'read,edit,write,grep,glob,bash,cezar_wait_for_ci',
    ]);
  });

  it('passes no tools flag without allowedTools, --no-tools for an empty grant, and no auto effort', () => {
    expect(buildOmpArgs({ cwd: '/repo', userPrompt: 'task', effort: 'auto' })).toEqual(['--mode', 'rpc']);
    expect(buildOmpArgs({ ...base, allowedTools: [] })).toEqual(['--mode', 'rpc', '--no-tools']);
  });
});

describe('OMP_SPEC_SUPPORT', () => {
  it('honors every field, including the extra roots Pi drops', () => {
    for (const support of Object.values(OMP_SPEC_SUPPORT)) expect(support.honored).toBe(true);
    expect(OMP_SPEC_SUPPORT.additionalDirectories).toEqual({ honored: true, via: '--add-dir per directory' });
    expect(OMP_SPEC_SUPPORT.restrictNativeDelegation).toMatchObject({ via: expect.stringContaining('eval') });
  });
});
