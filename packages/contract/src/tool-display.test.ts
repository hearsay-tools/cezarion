import { describe, expect, it } from 'vitest';

import { toolDisplay, type ToolDisplay } from './tool-display.ts';

describe('tool display input boundaries', () => {
  it.each(['constructor', 'toString', '__proto__'])('keeps %s as an unknown tool name', (name) => {
    expect(toolDisplay(name, { description: 'custom tool' })).toEqual({
      toolKind: 'other', title: name, subtitle: 'custom tool',
    });
  });

  const rows: ReadonlyArray<{ name: string; input: unknown; expected: ToolDisplay }> = [
    {
      name: 'EDIT', input: { file_path: 'first.ts', filePath: 'second.ts', path: 'third.ts' },
      expected: { toolKind: 'edit', title: 'Edit first.ts' },
    },
    {
      name: 'NotebookEdit', input: { notebook_path: 'first.ipynb', notebookPath: 'second.ipynb', file_path: 'third.ts' },
      expected: { toolKind: 'edit', title: 'Edit first.ipynb' },
    },
    {
      name: 'Write', input: { file_path: ' ', filePath: ' second.ts ', path: 'third.ts' },
      expected: { toolKind: 'edit', title: 'Write second.ts' },
    },
    {
      name: 'fileChange', input: { changes: [{ path: '  raw\npath.ts  ' }] },
      expected: { toolKind: 'edit', title: 'Edit   raw\npath.ts  ' },
    },
    {
      name: 'fileChange', input: { changes: [{ path: 'x'.repeat(150) }] },
      expected: { toolKind: 'edit', title: `Edit ${'x'.repeat(150)}` },
    },
    {
      name: 'commandExecution', input: { command: [null, 'npm', 42, 'test'], description: ' run\ntests ' },
      expected: { toolKind: 'execute', title: 'Ran npm test', subtitle: 'run tests' },
    },
    {
      name: 'Agent', input: { description: ' ', prompt: 'inspect files', subagentType: 'Explore' },
      expected: { toolKind: 'task', title: 'Agent: inspect files', subtitle: 'Explore' },
    },
    {
      name: 'Skill', input: { skill: ' ', name: 'review', command: 'ignored', args: ' ', description: 'details' },
      expected: { toolKind: 'task', title: 'Skill: review', subtitle: 'details' },
    },
    {
      name: 'MCP__Server__Tool__Extra', input: { description: 'ignored' },
      expected: { toolKind: 'other', title: 'Server.Tool__Extra' },
    },
    {
      name: 'mcp__server', input: { query: 'fallback' },
      expected: { toolKind: 'other', title: 'mcp__server', subtitle: 'fallback' },
    },
    {
      name: 'mcpToolCall', input: { server: 'server', query: 'fallback' },
      expected: { toolKind: 'other', title: 'MCP tool', subtitle: 'fallback' },
    },
  ];

  it.each(rows)('preserves the display for $name with $input', ({ name, input, expected }) => {
    expect(toolDisplay(name, input)).toEqual(expected);
  });
});

// Partial native wire input must still produce a usable label.
describe('tool display malformed inputs', () => {
  it.each([undefined, null, [], 7, false, 'command'])('uses the command verb without a command in %j', input => {
    expect(toolDisplay('Bash', input)).toEqual({ toolKind: 'execute', title: 'Ran', subtitle: undefined });
  });

  it.each([{}, { command: [] }, { command: [null, 7] }, { command: ' \n ' }])('omits unusable command in %j', input => {
    expect(toolDisplay('commandExecution', input)).toEqual({ toolKind: 'execute', title: 'Ran', subtitle: undefined });
  });

  it('collapses every whitespace run and truncates only labels above 120 characters', () => {
    expect(toolDisplay('Bash', { command: 'a'.repeat(120) }).title).toBe(`Ran ${'a'.repeat(120)}`);
    expect(toolDisplay('Bash', { command: 'a'.repeat(121) }).title).toBe(`Ran ${'a'.repeat(119)}…`);
    expect(toolDisplay('custom', { description: '  a\n b\t c  ' })).toEqual({ toolKind: 'other', title: 'custom', subtitle: 'a b c' });
  });

  it.each([undefined, null, [], { changes: null }, { changes: {} }, { changes: [] },
    { changes: [null, [], 7, {}, { path: false }, { path: ' ' }] }])('ignores invalid changes %j', input => {
    expect(toolDisplay('fileChange', input)).toEqual({ toolKind: 'edit', title: 'Edit' });
  });

  it('counts only valid change paths', () => {
    expect(toolDisplay('fileChange', { changes: [null, { path: 'a' }, { path: '' }, { path: 'b' }] }))
      .toEqual({ toolKind: 'edit', title: 'Edit 2 files' });
  });

  it.each([
    ['Edit', { path: 'x' }, 'Edit x'], ['Write', { path: 'x' }, 'Write x'],
    ['NotebookEdit', { path: 'x' }, 'Edit x'], ['NotebookEdit', { notebookPath: 'x' }, 'Edit x'],
    ['Read', { filePath: 'x' }, 'Read x'], ['Read', { path: 'x' }, 'Read x'],
    ['imageView', { path: 'x' }, 'View image x'], ['WebFetch', { url: 'x' }, 'Fetch x'],
    ['WebSearch', { query: 'x' }, 'Web search x'], ['Grep', { query: 'x' }, 'Search x'],
  ])('reads the fallback field for %s', (name, input, title) => {
    expect(toolDisplay(name as string, input).title).toBe(title);
  });

  it('distinguishes an MCP call with both names from partial names', () => {
    expect(toolDisplay('mcpToolCall', { server: 's', tool: 't' })).toEqual({ toolKind: 'other', title: 's.t' });
    expect(toolDisplay('mcpToolCall', { tool: 't', query: 'q' })).toEqual({ toolKind: 'other', title: 'MCP tool', subtitle: 'q' });
    expect(toolDisplay('mcp____s____t__extra')).toEqual({ toolKind: 'other', title: 's.t__extra' });
    expect(toolDisplay('mcp__s')).toEqual({ toolKind: 'other', title: 'mcp__s', subtitle: undefined });
  });

  it('uses the first plausible unknown-tool field and a safe title', () => {
    expect(toolDisplay(' \n ')).toEqual({ toolKind: 'other', title: 'Tool', subtitle: undefined });
    expect(toolDisplay(null as never)).toEqual({ toolKind: 'other', title: 'Tool', subtitle: undefined });
    for (const key of ['query', 'url', 'filePath', 'file_path', 'path', 'pattern', 'name']) {
      expect(toolDisplay('custom', { description: 7, [key]: 'label' })).toEqual({ toolKind: 'other', title: 'custom', subtitle: 'label' });
    }
  });

  it('uses agent type only when no description or prompt is present', () => {
    expect(toolDisplay('Agent', { subagent_type: 'Explore' })).toEqual({ toolKind: 'task', title: 'Agent: Explore', subtitle: undefined });
    expect(toolDisplay('Task', { prompt: 'inspect', subagentType: 'Explore' })).toEqual({ toolKind: 'task', title: 'Task: inspect', subtitle: 'Explore' });
    expect(toolDisplay('Skill', { command: 'review' })).toEqual({ toolKind: 'task', title: 'Skill: review', subtitle: undefined });
    expect(toolDisplay('Skill')).toEqual({ toolKind: 'task', title: 'Skill', subtitle: undefined });
    expect(toolDisplay('Agent')).toEqual({ toolKind: 'task', title: 'Agent', subtitle: undefined });
  });
});
