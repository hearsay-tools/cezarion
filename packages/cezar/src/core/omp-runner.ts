import { parseEffort } from '@open-mercato/cezar-contract';
import { fileURLToPath } from 'node:url';
import type { AgentRunSpec, AgentRunSpecSupport } from './agent-runner.js';
import { ciToolDefinition } from '../ci-wait/tools.js';

/**
 * OMP's built-in tool names at the pinned version (`src/tools/builtin-names.ts`, oh-my-pi
 * v18.4.11; the real binary lists the same 30 in its `--tools` rejection). `--tools` is an
 * allowlist validated against the registry, and an unknown name exits 2 before any frame, so
 * only these, cezar's mapped names and `mcp__*` ever reach it.
 */
export const OMP_BUILTIN_TOOL_NAMES: readonly string[] = [
  'read', 'bash', 'edit', 'ast_grep', 'ast_edit', 'ask', 'debug', 'ida', 'eval', 'github',
  'glob', 'grep', 'find', 'lsp', 'checkpoint', 'rewind', 'context_notes', 'new_context',
  'security_scan', 'task', 'wait', 'todo', 'web_search', 'write', 'memory_edit', 'retain',
  'recall', 'reflect', 'learn', 'manage_skill',
];

/**
 * The tools OMP v18.4.11 enables with no `--tools` and no user config (recorded from the real
 * binary's `get_state.dumpTools`). Only read under governed delegation, which must name a list
 * to leave `task`, `wait` and `eval` out of it.
 */
const OMP_DEFAULT_TOOL_NAMES: readonly string[] = [
  'read', 'bash', 'edit', 'eval', 'glob', 'grep', 'task', 'wait', 'todo', 'web_search', 'write',
];

/** cezar tool names with an OMP equivalent; OMP built-ins and `mcp__*` pass through as-is. */
const OMP_TOOL_MAP: Readonly<Record<string, string>> = {
  Read: 'read',
  Edit: 'edit',
  Write: 'write',
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  Subagent: 'task',
  Task: 'task',
  TodoWrite: 'todo',
  WebSearch: 'web_search',
  // R2: OMP v18.4.11 has no `fetch` built-in; `read` reads static web pages per its own description.
  WebFetch: 'read',
};

/**
 * D1: tools that let the agent spawn agents outside cezar's governance. `wait` only joins `task`
 * work; `eval` has `agent()`/`workpool()` helpers and no v18.4.11 setting turns them off (R6).
 */
const OMP_DELEGATION_TOOLS: ReadonlySet<string> = new Set(['task', 'wait', 'eval']);

/**
 * What the omp CLI receives from each `AgentRunSpec` field (#284, spec § Spawn and spec
 * support). Held against the mock's recorded argv and RPC by the harness parity matrix.
 */
export const OMP_SPEC_SUPPORT: AgentRunSpecSupport = {
  cezarTools: { honored: true, via: 'explicit CI --extension; cezar_wait_for_ci admitted when --tools is set' },
  systemPrompt: { honored: true, via: '--append-system-prompt' },
  userPrompt: { honored: true, via: 'RPC prompt.message' },
  images: { honored: true, via: "RPC prompt.images ({type:'image', data, mimeType})" },
  cwd: { honored: true, via: 'spawn cwd' },
  allowedTools: { honored: true, via: '--tools, mapped onto OMP names; unmapped names dropped (fail closed)' },
  restrictNativeDelegation: {
    honored: true,
    via: '--config overlay denying task, and task/wait left out of --tools (D1); eval is left out too, since OMP v18.4.11 has no setting that disables its agent()/workpool() helpers',
  },
  bashAllowlist: { honored: true, via: "no prefix equivalent: bash dropped from --tools when an allowlist is set (Pi's rule)" },
  additionalDirectories: { honored: true, via: '--add-dir per directory' },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: '--model provider/model' },
  effort: { honored: true, via: '--thinking, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch' },
  sessionId: { honored: true, via: '--resume <id> when resume is set; a fresh session mints its own id, reported from get_state' },
  resume: { honored: true, via: '--resume in place of a fresh session' },
};

export interface OmpToolSelection {
  /** `tools` → `--tools <list>`, `no-tools` → `--no-tools`, `null` → OMP's own default set. */
  flag: 'tools' | 'no-tools' | null;
  tools: string[];
  /** Requested names with no OMP equivalent, reported once as a v1 note. */
  dropped: string[];
}

/**
 * Maps cezar's tool names onto OMP's `--tools` allowlist (spec § Tools). Fails closed: a
 * non-empty request that maps to nothing disables every built-in rather than widening to OMP's
 * defaults, and every narrowing (`bashAllowlist`, D1) only ever removes names.
 */
export function ompTools(
  allowedTools: string[] | undefined,
  opts: { bashAllowlist?: string[]; restrictNativeDelegation?: boolean; cezarTools?: boolean },
): OmpToolSelection {
  // OMP's default set includes task, wait and eval; D1 has to name a list to leave them out.
  const requested = allowedTools ?? (opts.restrictNativeDelegation ? [...OMP_DEFAULT_TOOL_NAMES] : undefined);
  if (requested === undefined) return { flag: null, tools: [], dropped: [] };
  const tools = new Set<string>();
  const dropped = new Set<string>();
  for (const name of requested) {
    const mapped =
      OMP_TOOL_MAP[name] ?? (OMP_BUILTIN_TOOL_NAMES.includes(name) || name.startsWith('mcp__') ? name : undefined);
    if (mapped === undefined) dropped.add(name);
    else tools.add(mapped);
  }
  // OMP can allow or deny the whole bash tool but has no command-prefix equivalent.
  if (opts.bashAllowlist && opts.bashAllowlist.length > 0) tools.delete('bash');
  if (opts.restrictNativeDelegation) for (const name of OMP_DELEGATION_TOOLS) tools.delete(name);
  if (tools.size === 0) return { flag: 'no-tools', tools: [], dropped: [...dropped] };
  if (opts.cezarTools) tools.add(ciToolDefinition.name);
  return { flag: 'tools', tools: [...tools], dropped: [...dropped] };
}

/** `omp --mode rpc` argv, in the order of the spec's spawn block. */
export function buildOmpArgs(spec: AgentRunSpec): string[] {
  const args = ['--mode', 'rpc'];
  if (spec.cezarTools) args.push('--extension', ompScriptPath('omp-ci-wait.mjs'));
  // OMP has no --session-id: a fresh session mints its id, which get_state reports.
  if (spec.resume && spec.sessionId) args.push('--resume', spec.sessionId);
  if (spec.systemPrompt) args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.model) args.push('--model', spec.model);
  const effort = parseEffort(spec.effort);
  if (effort) args.push('--thinking', effort);
  for (const dir of spec.additionalDirectories ?? []) args.push('--add-dir', dir);
  if (spec.restrictNativeDelegation) args.push('--config', ompScriptPath('omp-restrict-delegation.yml'));
  const selection = ompTools(spec.allowedTools, {
    bashAllowlist: spec.bashAllowlist,
    restrictNativeDelegation: spec.restrictNativeDelegation,
    cezarTools: spec.cezarTools !== undefined,
  });
  if (selection.flag === 'tools') args.push('--tools', selection.tools.join(','));
  else if (selection.flag === 'no-tools') args.push('--no-tools');
  return args;
}

function ompScriptPath(name: string): string {
  return fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
}
