import type { CezarAskAnswer, CezarWaitAnswer } from '@open-mercato/cezar-contract/waits';
import type { ScheduleTaskAnswer, ScheduledTasksAnswer } from '@open-mercato/cezar-contract/scheduled-tasks';
import { previewToolEnabled, automationsToolEnabled, waitToolDefinition, askToolDefinition, cancelWaitToolDefinition, doneToolDefinition, previewToolDefinition, previewStopToolDefinition, scheduleTaskToolDefinition, scheduledTasksToolDefinition } from './tool-catalog.ts';
export { previewToolEnabled, automationsToolEnabled, waitToolDefinition, askToolDefinition, cancelWaitToolDefinition, doneToolDefinition, previewToolDefinition, previewStopToolDefinition, scheduleTaskToolDefinition, scheduledTasksToolDefinition, cezarToolNames, cezarToolEnvNames } from './tool-catalog.ts';
import { callCezarAsk, callCezarCancelWait, callCezarDone, callCezarWait, callPreviewServe, callPreviewStop, callScheduleTask, callScheduledTasks } from './client.ts';

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
/**
 * hearsay-tools/cezarion#1428: agents asked about drafts they never sent, and treated the context
 * they cut from a rejected card as sent. Both hints say where that context belongs: `context`.
 */
export function askAnswerHint(answer: CezarAskAnswer): string {
  if (answer.ok) return 'Asked. Cezar shows the context and question card to the user. End your turn; the user\'s answer wakes you.';
  if (answer.code === 'invalid_request') return 'Not asked. The user never sees a rejected call. Fix the call from the message: put the detail in context and keep each question short.';
  return 'Not asked. Fix the call from the message, or continue without asking.';
}
export async function invokeAskTool(input: unknown) {
  const answer = await callCezarAsk(input);
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${askAnswerHint(answer)}` }], isError: !answer.ok, details: answer };
}

/** JSON first, then one hint sentence, as `invokePreviewTool` answers. */
export function waitAnswerHint(answer: CezarWaitAnswer): string {
  if (!answer.ok) return answer.effect === undefined || answer.effect === 'unknown' ? 'Outcome unknown. Retry the same operation_id and arguments; do not add a fallback wait.'
    : answer.code === 'duplicate_deadline' ? 'Deadline change refused. The retained wait remains active; do not cancel it as a duplicate.'
      : 'Not registered by this call. Follow the message; previously registered waits remain unchanged.';
  if (answer.wait_phase === 'unavailable') return 'Registration receipt recovered; current wait state is unavailable. Inspect task history before arranging another wait.';
  if (answer.wait_phase && answer.wait_phase !== 'open') return 'Registration receipt recovered. This wait has already settled; inspect its result before arranging another wait.';
  return answer.replayed || answer.deduplicated ? 'Existing wait retained. This is its real ID and deadline; do not cancel it as a duplicate. End your turn to wait.'
    : 'Registered. End your turn to wait; any open wait wakes you when it resolves.';
}
export async function invokeWaitTool(input: unknown) {
  const answer = await callCezarWait(input);
  const hint = waitAnswerHint(answer);
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${hint}` }], isError: !answer.ok, details: answer };
}
export async function invokeCancelWaitTool(input: unknown) {
  const answer = await callCezarCancelWait(input);
  const hint = answer.cancelled ? 'Cancelled. The waits in open_waits stay open.' : 'Not cancelled. Check the message and the waits in open_waits.';
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${hint}` }], isError: !answer.cancelled, details: answer };
}
export async function invokeDoneTool(input: unknown) {
  const answer = await callCezarDone(input);
  const hint = !answer.ok ? 'Not finished. Do what the message says, then call cezar_done again.'
    : answer.completes === 'step' ? `Accepted. End your turn; Cezar completes this step at its end and starts "${answer.next_step}".`
    : 'Accepted. End your turn; Cezar finishes the task at its end.';
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${hint}` }], isError: !answer.ok, details: answer };
}

/** JSON first, then the hint as a plain sentence: the shape every cezar tool answers in. */
export async function invokePreviewTool(input: unknown) {
  const result = await callPreviewServe(input);
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(result)}\n${result.hint}` }], isError: !result.ok, details: result };
}
export async function invokePreviewStopTool(input: unknown) {
  const result = await callPreviewStop(input);
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(result)}\n${result.hint}` }], isError: !result.ok, details: result };
}
const PREVIEW_STOP_TOOL: CezarTool = { definition: previewStopToolDefinition, trigger: 'load when your Cezar-started preview server needs stopping or restarting.', label: 'Stop live preview', invoke: invokePreviewStopTool };

function scheduleHint(answer: ScheduleTaskAnswer | ScheduledTasksAnswer): string {
  if (answer.ok) return 'Done. due_at is UTC: tell the user that time in their time zone, and name the zone.';
  return answer.code === 'automations_off' || answer.code === 'unavailable' ? 'Not scheduled. Tell the user, and do not retry.' : 'Not changed. Fix the call from the message, or continue without it.';
}
export async function invokeScheduleTaskTool(input: unknown) {
  const answer = await callScheduleTask(input);
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${scheduleHint(answer)}` }], isError: !answer.ok, details: answer };
}
export async function invokeScheduledTasksTool(input: unknown) {
  const answer = await callScheduledTasks(input);
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${scheduleHint(answer)}` }], isError: !answer.ok, details: answer };
}
const SCHEDULE_TASK_TOOL: CezarTool = { definition: scheduleTaskToolDefinition, trigger: 'load when work should start later as a new task (in an hour, tomorrow, next week) instead of keeping this session waiting.', label: 'Schedule a task', invoke: invokeScheduleTaskTool };
const SCHEDULED_TASKS_TOOL: CezarTool = { definition: scheduledTasksToolDefinition, trigger: 'load when you need to list, change, pause, resume or cancel a one-time scheduled task.', label: 'Scheduled tasks', invoke: invokeScheduledTasksTool };

const WAIT_TOOL: CezarTool = { definition: waitToolDefinition, trigger: 'load when you are waiting on CI for a PR or on a background job you started, or want to re-check something later; end your turn after it answers.', label: 'Wait', invoke: invokeWaitTool };
const ASK_TOOL: CezarTool = { definition: askToolDefinition, trigger: 'load for a user decision or missing input; provide the full draft or findings in its rendered context field.', label: 'Ask the user', invoke: invokeAskTool };
const CANCEL_WAIT_TOOL: CezarTool = { definition: cancelWaitToolDefinition, trigger: 'load when a wait you registered is no longer needed.', label: 'Cancel wait', invoke: invokeCancelWaitTool };
const DONE_TOOL: CezarTool = { definition: doneToolDefinition, trigger: 'load when the task is complete and verified.', label: 'Done', invoke: invokeDoneTool };
const PREVIEW_TOOL: CezarTool = { definition: previewToolDefinition, trigger: 'load when you have started, or are about to start, a web server the user should click through.', label: 'Live preview', invoke: invokePreviewTool };

export function cezarTools(env: NodeJS.ProcessEnv = process.env): CezarTool[] {
  return [
    WAIT_TOOL, ASK_TOOL, CANCEL_WAIT_TOOL, DONE_TOOL,
    ...(previewToolEnabled(env) ? [PREVIEW_TOOL, PREVIEW_STOP_TOOL] : []),
    ...(automationsToolEnabled(env) ? [SCHEDULE_TASK_TOOL, SCHEDULED_TASKS_TOOL] : []),
  ];
}

export function cezarServerInstructions(env: NodeJS.ProcessEnv = process.env): string {
  return [
    'The interface to Cezarion, the orchestrator running this session. Load a tool below when its situation comes up.',
    ...cezarTools(env).map(tool => `- ${tool.definition.name}: ${tool.trigger}`),
  ].join('\n');
}
