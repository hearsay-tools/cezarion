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
