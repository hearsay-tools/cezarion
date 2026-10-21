import { cezarAskRequestSchema, cezarCancelWaitRequestSchema, cezarDoneRequestSchema, cezarWaitRequestSchema, type CezarAskAnswer } from '@open-mercato/cezar-contract/waits';
import { ASK_LIMITS } from '@open-mercato/cezar-contract/ask-schema';
import { ciWaitRequestSchema } from '@open-mercato/cezar-contract/ci-wait';
import { previewStopRequestSchema, previewServeRequestSchema } from '@open-mercato/cezar-contract/preview';
import { z } from 'zod';
import { callCezarAsk, callCezarCancelWait, callCezarDone, callCezarWait, callCiWait, callPreviewServe, callPreviewStop } from './client.ts';

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
  // `timeout_seconds` is in both the ci and worker kinds: the ci schema's bounds (1–7200, default
  // 1800) are the advertised ones, and the worker's own (1–1800, default 600) ride in the description.
  for (const option of [...cezarWaitRequestSchema.options].reverse()) {
    Object.assign(properties, z.toJSONSchema(option, { io: 'input' }).properties);
  }
  const field = (key: string, description: string) => ({ ...(properties[key] as object), description });
  return {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', enum: cezarWaitRequestSchema.options.map(option => option.shape.kind.value), description: '"ci" waits for the checks of a GitHub pull request; "worker" waits for workers or request replies; "timer" wakes you after `seconds`.' },
      pr: field('pr', 'kind "ci": the HTTPS GitHub pull request URL.'),
      worker_ids: field('worker_ids', 'kind "worker": the workers you own to wait for (1–32 unique ids). Give this or request_ids, not both.'),
      request_ids: field('request_ids', 'kind "worker": the requests you sent to wait for a reply to (1–32 unique ids). Give this or worker_ids, not both.'),
      mode: field('mode', 'kind "worker": "any" wakes you when one selected id settles (default), "all" when every one has, "one" takes exactly one id.'),
      timeout_seconds: field('timeout_seconds', 'The deadline in seconds. kind "ci": 1–7200, default 1800. kind "worker": 1–1800, default 600 (the default shown is the ci one).'),
      seconds: field('seconds', 'kind "timer": seconds until the wake (60–7200).'),
      note: field('note', 'kind "timer": what to re-check, handed back to you at the wake.'),
    },
    required: ['kind'],
    additionalProperties: false,
  };
}

export const waitToolDefinition = {
  name: 'cezar_wait',
  description: 'Open a wait on something outside this turn: CI on a GitHub pull request (kind "ci"), workers or the replies to requests you sent (kind "worker"), or a timer (kind "timer"). End your turn after it answers; Cezar wakes you when any open wait resolves, with its result. A human message wakes you too and closes no wait. Several waits can be open at once; the answer lists them. To wait for the user, call cezar_ask. A CI observation is not merge approval.',
  inputSchema: flatWaitInputSchema(),
};
/**
 * hearsay-tools/cezarion#1234: the user's answer gets its own tool, so its card is required and
 * `cezar_wait` never has to explain a field only one kind takes.
 */
export const askToolDefinition = {
  name: 'cezar_ask',
  description: `Ask the user, then end your turn: Cezar shows your questions as a card, the run waits for the answer, and the user's reply wakes you. Before you call it, send everything the decision depends on (the full draft, every finding, what each option means) as assistant text: the user sees only your assistant text and this card, never your reasoning or these arguments. Ask only for a decision that is the user's to make or input you cannot find. Each question takes a header of at most ${ASK_LIMITS.header} characters, a short question of at most ${ASK_LIMITS.question} characters, and ${ASK_LIMITS.minOptions}–${ASK_LIMITS.maxOptions} options shown as choices; leave the options out to let the user type the answer. The user can always type a reply of their own. Other open waits keep running while you wait.`,
  inputSchema: { ...z.toJSONSchema(cezarAskRequestSchema, { io: 'input' }), type: 'object' as const },
};
/**
 * hearsay-tools/cezarion#1428: agents asked about drafts they never sent, and treated the context
 * they cut from a rejected card as sent. Both hints say where that context belongs.
 */
export function askAnswerHint(answer: CezarAskAnswer): string {
  if (answer.ok) return 'Asked. The user sees this card and your assistant text, never your reasoning or these arguments. If the question refers to a draft or findings you have not sent as assistant text, send them in full now. Then end your turn; the user\'s answer wakes you.';
  if (answer.code === 'invalid_request') return 'Not asked. The user never sees the arguments of a rejected call: send any detail you cut from the card as assistant text first, then call cezar_ask again with a short question.';
  return 'Not asked. Fix the call from the message, or continue without asking.';
}
export async function invokeAskTool(input: unknown) {
  const answer = await callCezarAsk(input);
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${askAnswerHint(answer)}` }], isError: !answer.ok, details: answer };
}

export const cancelWaitToolDefinition = {
  name: 'cezar_cancel_wait',
  description: 'Close a wait you opened with cezar_wait (CI, worker or timer) or cezar_ask, by its wait_id, so it never wakes you. A question the user already sees cannot be cancelled; only their answer ends it. A wait that already resolved is delivered with your next wake anyway; the answer says so and lists the waits still open.',
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

/** hearsay-tools/cezarion#1234: the explicit form of the done line. */
export const doneToolDefinition = {
  name: 'cezar_done',
  description: 'Finish the task. Call it when the goal is fully achieved and verified and you have no question for the user; end your turn after it answers. Cezar closes the session at the end of this turn and cancels every open wait. It refuses, naming what to do first, while owned workers are live or uncollected, a worker question is unanswered, or your question to the user is still pending.',
  inputSchema: { ...z.toJSONSchema(cezarDoneRequestSchema, { io: 'input' }), type: 'object' as const },
};
export async function invokeDoneTool(input: unknown) {
  const answer = await callCezarDone(input);
  const hint = answer.ok ? 'Accepted. End your turn; Cezar finishes the task at its end.' : 'Not finished. Do what the message says, then call cezar_done again.';
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${hint}` }], isError: !answer.ok, details: answer };
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
const WAIT_TOOL: CezarTool = { definition: waitToolDefinition, trigger: 'load when you are waiting on CI for a PR, or want to re-check something later; end your turn after it answers.', label: 'Wait', invoke: invokeWaitTool };
const ASK_TOOL: CezarTool = { definition: askToolDefinition, trigger: 'load when you need the user: a decision only they can make, or missing input; send the full context as assistant text before you call it, and end your turn after it answers.', label: 'Ask the user', invoke: invokeAskTool };
const CANCEL_WAIT_TOOL: CezarTool = { definition: cancelWaitToolDefinition, trigger: 'load when a wait you registered is no longer needed.', label: 'Cancel wait', invoke: invokeCancelWaitTool };
const DONE_TOOL: CezarTool = { definition: doneToolDefinition, trigger: 'load when the task is complete and verified.', label: 'Done', invoke: invokeDoneTool };
const PREVIEW_TOOL: CezarTool = { definition: previewToolDefinition, trigger: 'load when you have started, or are about to start, a web server the user should click through.', label: 'Live preview', invoke: invokePreviewTool };

export function cezarTools(env: NodeJS.ProcessEnv = process.env): CezarTool[] {
  const waits = [CI_TOOL, WAIT_TOOL, ASK_TOOL, CANCEL_WAIT_TOOL, DONE_TOOL];
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
