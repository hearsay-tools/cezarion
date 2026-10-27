/**
 * Tool display model for backend names and raw input. Pure and total over malformed or partial
 * wire values.
 *
 * Known names covered (matched case-insensitively so claude's `Bash` and
 * opencode's `bash` share one row):
 *  - claude:   Bash, Edit, Write, NotebookEdit, Read, Glob, Grep, WebFetch,
 *              WebSearch, Task, Agent, Skill, TodoWrite, TaskCreate,
 *              TaskUpdate, TaskList, mcp__server__tool
 *  - codex:    commandExecution, contextCompaction, fileChange, imageView,
 *              mcpToolCall, webSearch, plan
 *              (codex's checklist arrives as the `turn/plan/updated`
 *              notification, not as a tool call — `todoList` is kept below only
 *              as tolerance for its non-app-server transports)
 *  - opencode: bash, edit, write, read, grep, glob, webfetch, task, todowrite
 */

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'task' | 'plan' | 'other';

export interface ToolDisplay {
  toolKind: ToolKind;
  /** Human line for the card trigger, e.g. "Ran npm test". */
  title: string;
  /** Secondary detail, e.g. the claude Bash `description`. */
  subtitle?: string | undefined;
}

/** Longest title/subtitle we emit — display truncation belongs here, not in
 *  every component that renders a tool line. */
const MAX_LABEL = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collapse whitespace (multi-line commands become one line) and cap length. */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_LABEL ? `${collapsed.slice(0, MAX_LABEL - 1)}…` : collapsed;
}

/** First non-empty string among `input[keys...]`, normalized for display. */
function field(input: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value);
  }
  return undefined;
}

/** claude Bash carries `command: string`; codex commandExecution may carry
 *  a string or an argv array — join the string members. */
function commandText(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const command = input.command;
  if (typeof command === 'string' && command.trim() !== '') return oneLine(command);
  if (Array.isArray(command)) {
    const argv = command.filter((part): part is string => typeof part === 'string');
    if (argv.length > 0) return oneLine(argv.join(' '));
  }
  return undefined;
}

/** File paths listed by a codex `fileChange` item (`changes: [{path}]`). */
function changePaths(input: unknown): string[] {
  if (!isRecord(input) || !Array.isArray(input.changes)) return [];
  const paths: string[] = [];
  for (const change of input.changes) {
    if (isRecord(change) && typeof change.path === 'string' && change.path.trim() !== '') {
      paths.push(change.path);
    }
  }
  return paths;
}

/** The opencode research heuristic for unknown tools: the first plausible
 *  human label in the input, in a fixed priority order. */
function heuristicLabel(input: unknown): string | undefined {
  return field(input, 'description', 'query', 'url', 'filePath', 'file_path', 'path', 'pattern', 'name');
}

/** Verb + optional object → "Read src/a.ts", or just the verb when the
 *  input gave us nothing usable. */
function titled(verb: string, label: string | undefined): string {
  return label ? `${verb} ${label}` : verb;
}

/** Every known backend spelling maps to its display family. A Map keeps prototype names unknown. */
const TOOL_KINDS = new Map<string, ToolKind>([
  ['bash', 'execute'], ['commandexecution', 'execute'],
  ['edit', 'edit'], ['multiedit', 'edit'], ['write', 'edit'], ['notebookedit', 'edit'], ['filechange', 'edit'],
  ['read', 'read'], ['imageview', 'read'],
  ['glob', 'search'], ['grep', 'search'],
  ['webfetch', 'fetch'], ['websearch', 'fetch'],
  ['task', 'task'], ['agent', 'task'], ['skill', 'task'],
  ['todowrite', 'plan'], ['todolist', 'plan'], ['plan', 'plan'],
  ['taskcreate', 'plan'], ['taskupdate', 'plan'], ['tasklist', 'plan'],
  ['contextcompaction', 'other'], ['mcptoolcall', 'other'],
]);

function editDisplay(key: string, input: unknown): ToolDisplay {
  switch (key) {
    case 'write':
      return { toolKind: 'edit', title: titled('Write', field(input, 'file_path', 'filePath', 'path')) };
    case 'notebookedit':
      return {
        toolKind: 'edit',
        title: titled('Edit', field(input, 'notebook_path', 'notebookPath', 'file_path', 'filePath', 'path')),
      };
    case 'filechange': {
      const paths = changePaths(input);
      const label = paths.length === 1 ? paths[0] : paths.length > 1 ? `${paths.length} files` : undefined;
      return { toolKind: 'edit', title: titled('Edit', label) };
    }
    default:
      return { toolKind: 'edit', title: titled('Edit', field(input, 'file_path', 'filePath', 'path')) };
  }
}

function readDisplay(key: string, input: unknown): ToolDisplay {
  return key === 'imageview'
    ? { toolKind: 'read', title: titled('View image', field(input, 'path')) }
    : { toolKind: 'read', title: titled('Read', field(input, 'file_path', 'filePath', 'path')) };
}

function fetchDisplay(key: string, input: unknown): ToolDisplay {
  return key === 'webfetch'
    ? { toolKind: 'fetch', title: titled('Fetch', field(input, 'url')) }
    : { toolKind: 'fetch', title: titled('Web search', field(input, 'query')) };
}

function taskDisplay(key: string, input: unknown): ToolDisplay {
  // claude's `Skill` invocation: `{skill, args?}` — the skill name is the whole title.
  if (key === 'skill') {
    const skill = field(input, 'skill', 'name', 'command');
    return {
      toolKind: 'task',
      title: skill ? `Skill: ${skill}` : 'Skill',
      subtitle: field(input, 'args', 'description'),
    };
  }

  // claude dispatches sub-agents through `Agent` today and `Task` historically;
  // opencode uses `task`. Fall back to the subagent type when no description is usable.
  const verb = key === 'agent' ? 'Agent' : 'Task';
  const subagent = field(input, 'subagent_type', 'subagentType');
  const label = field(input, 'description', 'prompt') ?? subagent;
  return {
    toolKind: 'task',
    title: label ? `${verb}: ${label}` : verb,
    // Don't repeat the subagent type when it is already the title.
    subtitle: label === subagent ? undefined : subagent,
  };
}

function otherDisplay(name: string, key: string, input: unknown): ToolDisplay {
  if (key === 'contextcompaction') return { toolKind: 'other', title: 'Compacted context' };
  if (key === 'mcptoolcall') {
    const server = field(input, 'server');
    const tool = field(input, 'tool');
    if (server && tool) return { toolKind: 'other', title: `${server}.${tool}` };
    return { toolKind: 'other', title: 'MCP tool', subtitle: heuristicLabel(input) };
  }

  // claude/opencode MCP tools are named `mcp__server__tool` → "server.tool".
  if (key.startsWith('mcp__')) {
    const parts = name.split('__').filter((part) => part !== '');
    if (parts.length >= 3) {
      return { toolKind: 'other', title: `${parts[1]}.${parts.slice(2).join('__')}` };
    }
  }

  // Unknown tool: keep the backend's name as the title, heuristic subtitle.
  return {
    toolKind: 'other',
    title: typeof name === 'string' && name.trim() !== '' ? oneLine(name) : 'Tool',
    subtitle: heuristicLabel(input),
  };
}

export function toolDisplay(name: string, input?: unknown): ToolDisplay {
  const key = typeof name === 'string' ? name.toLowerCase() : '';
  switch (TOOL_KINDS.get(key)) {
    case 'execute':
      return {
        toolKind: 'execute',
        title: titled('Ran', commandText(input)),
        subtitle: field(input, 'description'),
      };
    case 'edit':
      return editDisplay(key, input);
    case 'read':
      return readDisplay(key, input);
    case 'search':
      return {
        toolKind: 'search',
        title: titled('Search', field(input, 'pattern', 'query')),
        subtitle: field(input, 'path'),
      };
    case 'fetch':
      return fetchDisplay(key, input);
    case 'task':
      return taskDisplay(key, input);
    case 'plan':
      return { toolKind: 'plan', title: 'Update plan' };
    default:
      return otherDisplay(name, key, input);
  }
}
