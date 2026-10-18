import { cezarCancelWaitRequestSchema, cezarWaitRequestSchema } from '@open-mercato/cezar-contract/waits';
import { ciWaitRequestSchema } from '@open-mercato/cezar-contract/ci-wait';
import { previewStopRequestSchema, previewServeRequestSchema } from '@open-mercato/cezar-contract/preview';
import { z } from 'zod';
import { callCezarCancelWait, callCezarWait, callCiWait, callPreviewServe, callPreviewStop } from './client.ts';

/**
 * The one list of cezar tools (#781). The MCP adapter lists it, Pi's extension registers it, and
 * every allow-list or admission site reads its names, so adding a tool is one edit here.
 */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean; details: unknown };
export type CezarTool = {
  definition: { name: string; description: string; inputSchema: { type: 'object'; properties?: Record<string, unknown>; [key: string]: unknown } };
  /**
   * #497: deferred-tool harnesses show a bare name, so the server instructions carry this line.
   * Absent for a deprecated tool: it stays listed and admitted, but nothing suggests it.
   */
  trigger?: string;
  /** Pi's tool label. */
  label: string;
  invoke(input: unknown): Promise<ToolResult>;
};

/** Live preview is on under the exact value `1` only (spec 2026-10-02-live-preview-v1). */
export function previewToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_PREVIEW === '1';
}

/** hearsay-tools/cezarion#1233: deprecated alias of `cezar_wait` with kind "ci", removed in phase 4 (#1236). */
export const ciToolDefinition = {
  name: 'cezar_wait_for_ci',
  description: 'Deprecated: use cezar_wait with kind "ci". Register a bounded CI wait for a GitHub pull request. End your turn after registration; Cezar resumes you with an observation. No marker is needed. Passing reported checks does not prove all expected workflows appeared and is not merge approval.',
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

/**
 * The Anthropic tool API refuses a top-level `oneOf`/`anyOf`/`allOf`, so `cezar_wait` advertises
 * one flat object: every kind's fields side by side, with `kind` as an enum. Each field's bounds
 * come from its kind's own schema; the discriminated union validates on the server.
 */
function flatWaitInputSchema() {
  const properties: Record<string, unknown> = {};
  for (const option of cezarWaitRequestSchema.options) Object.assign(properties, z.toJSONSchema(option, { io: 'input' }).properties);
  const field = (key: string, description: string) => ({ ...(properties[key] as object), description });
  return {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', enum: cezarWaitRequestSchema.options.map(option => option.shape.kind.value), description: '"ci" waits for the checks of a GitHub pull request; "timer" wakes you after `seconds`.' },
      pr: field('pr', 'kind "ci": the HTTPS GitHub pull request URL.'),
      timeout_seconds: field('timeout_seconds', 'kind "ci": the deadline in seconds (1–7200, default 1800).'),
      seconds: field('seconds', 'kind "timer": seconds until the wake (60–7200).'),
      note: field('note', 'kind "timer": what to re-check, handed back to you at the wake.'),
    },
    required: ['kind'],
    additionalProperties: false,
  };
}

export const waitToolDefinition = {
  name: 'cezar_wait',
  description: 'Open a wait on something outside this turn: CI on a GitHub pull request (kind "ci") or a timer (kind "timer"). End your turn after it answers; Cezar wakes you when any open wait resolves, with its result, and a human message wakes you too without closing the wait. Several waits can be open at once; the answer lists them. A CI observation is not merge approval.',
  inputSchema: flatWaitInputSchema(),
};
export const cancelWaitToolDefinition = {
  name: 'cezar_cancel_wait',
  description: 'Close a wait you opened with cezar_wait, by its wait_id, so it never wakes you. A wait that already resolved is delivered with your next wake anyway; the answer says so and lists the waits still open.',
  inputSchema: { ...z.toJSONSchema(cezarCancelWaitRequestSchema, { io: 'input' }), type: 'object' as const },
};

/** JSON first, then one hint sentence, as `invokePreviewTool` answers. */
export async function invokeWaitTool(input: unknown) {
  const answer = await callCezarWait(input);
  const hint = answer.ok ? 'Registered. End your turn to wait; any open wait wakes you when it resolves.' : 'Not registered. Fix the call from the message, or continue without this wait.';
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${hint}` }], isError: !answer.ok, details: answer };
}
export async function invokeCancelWaitTool(input: unknown) {
  const answer = await callCezarCancelWait(input);
  const hint = answer.cancelled ? 'Cancelled. The waits in open_waits stay open.' : 'Not cancelled. Check the message and the waits in open_waits.';
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${hint}` }], isError: !answer.cancelled, details: answer };
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

export const previewStopToolDefinition = {
  name: 'cezar_preview_stop',
  description: 'Stop a preview server Cezar started for your own task. Set restart to true to reuse the unchanged command the owner approved, including after a crash. Adopted servers cannot be stopped; changed registrations need the owner to press Run and open again.',
  inputSchema: { ...z.toJSONSchema(previewStopRequestSchema, { io: 'input' }), type: 'object' as const },
};
export async function invokePreviewStopTool(input: unknown) {
  const result = await callPreviewStop(input);
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(result)}\n${result.hint}` }], isError: !result.ok, details: result };
}
const PREVIEW_STOP_TOOL: CezarTool = { definition: previewStopToolDefinition, trigger: 'load when your Cezar-started preview server needs stopping or restarting.', label: 'Stop live preview', invoke: invokePreviewStopTool };

// Deprecated: still listed, so every runner keeps admitting it, but with no trigger line.
const CI_TOOL: CezarTool = { definition: ciToolDefinition, label: 'Wait for CI', invoke: invokeCiTool };
const WAIT_TOOL: CezarTool = { definition: waitToolDefinition, trigger: 'load when you are waiting on CI for a PR or want to re-check something later; end your turn after it answers.', label: 'Wait', invoke: invokeWaitTool };
const CANCEL_WAIT_TOOL: CezarTool = { definition: cancelWaitToolDefinition, trigger: 'load when a wait you registered is no longer needed.', label: 'Cancel wait', invoke: invokeCancelWaitTool };
const PREVIEW_TOOL: CezarTool = { definition: previewToolDefinition, trigger: 'load when you have started, or are about to start, a web server the user should click through.', label: 'Live preview', invoke: invokePreviewTool };

export function cezarTools(env: NodeJS.ProcessEnv = process.env): CezarTool[] {
  const waits = [CI_TOOL, WAIT_TOOL, CANCEL_WAIT_TOOL];
  return previewToolEnabled(env) ? [...waits, PREVIEW_TOOL, PREVIEW_STOP_TOOL] : waits;
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
    ...cezarTools(env).flatMap(tool => tool.trigger ? [`- ${tool.definition.name}: ${tool.trigger}`] : []),
  ].join('\n');
}
