import { ciWaitRequestSchema, previewServeRequestSchema } from '@open-mercato/cezar-contract';
import { z } from 'zod';
import { callCiWait, callPreviewServe } from './client.ts';

/**
 * The one list of cezar tools (#781). The MCP adapter lists it, Pi's extension registers it, and
 * every allow-list or admission site reads its names, so adding a tool is one edit here.
 */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean; details: unknown };
export type CezarTool = {
  definition: { name: string; description: string; inputSchema: { type: 'object'; properties?: Record<string, unknown>; [key: string]: unknown } };
  /** #497: deferred-tool harnesses show a bare name, so the server instructions carry this line. */
  trigger: string;
  /** Pi's tool label. */
  label: string;
  invoke(input: unknown): Promise<ToolResult>;
};

/** Live preview is on under the exact value `1` only (spec 2026-10-02-live-preview-v1). */
export function previewToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_PREVIEW === '1';
}

export const ciToolDefinition = {
  name: 'cezar_wait_for_ci',
  description: 'Register a bounded CI wait for a GitHub pull request. End your turn after registration; Cezar resumes you with an observation. No marker is needed. Passing reported checks does not prove all expected workflows appeared and is not merge approval.',
  inputSchema: { ...z.toJSONSchema(ciWaitRequestSchema, { io: 'input' }), type: 'object' as const },
};
export async function invokeCiTool(input: unknown) {
  try {
    const receipt = await callCiWait(input);
    return { content: [{ type: 'text' as const, text: `${JSON.stringify(receipt)}\nRegistered. Please end your turn to wait; no marker is needed. This observation is not merge approval.` }], details: receipt };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'CI tool unavailable' }], details: {} };
  }
}

export const previewToolDefinition = {
  name: 'cezar_preview_serve',
  description: 'Register a web dev server of this task so the user can click through it in the cockpit\'s live preview. Always pin the port (`vite --strictPort`, `next dev -p`) so the server comes up on the port you register. Cezar starts the command itself when the user opens the preview; do not wait for the user.',
  inputSchema: { ...z.toJSONSchema(previewServeRequestSchema, { io: 'input' }), type: 'object' as const },
};

/** JSON first, then the hint as a plain sentence: the shape `cezar_wait_for_ci` answers in. */
export async function invokePreviewTool(input: unknown) {
  const result = await callPreviewServe(input);
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(result)}\n${result.hint}` }], isError: !result.ok, details: result };
}

const CI_TOOL: CezarTool = { definition: ciToolDefinition, trigger: 'load when opening or updating a PR you want to watch CI on.', label: 'Wait for CI', invoke: invokeCiTool };
const PREVIEW_TOOL: CezarTool = { definition: previewToolDefinition, trigger: 'load when you have started, or are about to start, a web server the user should click through.', label: 'Live preview', invoke: invokePreviewTool };

export function cezarTools(env: NodeJS.ProcessEnv = process.env): CezarTool[] {
  return previewToolEnabled(env) ? [CI_TOOL, PREVIEW_TOOL] : [CI_TOOL];
}
export function cezarToolNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return cezarTools(env).map(tool => tool.definition.name);
}

/**
 * Env names a harness must forward to the adapter process. Several harnesses spawn MCP servers
 * from an allowlist, so the preview opt-in rides along explicitly or the adapter never sees it.
 */
export function cezarToolEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['CEZ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET', ...(previewToolEnabled(env) ? ['CEZ_PREVIEW'] : [])];
}

export function cezarServerInstructions(env: NodeJS.ProcessEnv = process.env): string {
  return [
    'The interface to Cezarion, the orchestrator running this session. Load a tool below when its situation comes up.',
    ...cezarTools(env).map(tool => `- ${tool.definition.name}: ${tool.trigger}`),
  ].join('\n');
}
