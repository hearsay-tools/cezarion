import { cezarAskRequestSchema, cezarCancelWaitRequestSchema, cezarDoneRequestSchema, cezarWaitRequestSchema, type CezarAskAnswer } from '@open-mercato/cezar-contract/waits';
import { ASK_LIMITS } from '@open-mercato/cezar-contract/ask-schema';
import { previewStopRequestSchema, previewServeRequestSchema } from '@open-mercato/cezar-contract/preview';
import { scheduleTaskRequestSchema, scheduledTasksRequestSchema, type ScheduleTaskAnswer, type ScheduledTasksAnswer } from '@open-mercato/cezar-contract/scheduled-tasks';
import { z } from 'zod';
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

/** Live preview is on under the exact value `1` only (spec 2026-10-02-live-preview-v1). */
export function previewToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_PREVIEW === '1';
}

/** Automations are on under the exact value `1` only (spec 2026-10-02-scheduled-automations). */
export function automationsToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AUTOMATIONS === '1';
}

/**
 * The Anthropic tool API refuses a top-level `oneOf`/`anyOf`/`allOf`, so `cezar_wait` advertises
 * one flat object: every kind's fields side by side, with `kind` as an enum. Each field's bounds
 * come from its kind's own schema; the discriminated union validates on the server.
 */
function flatWaitInputSchema() {
  const properties: Record<string, unknown> = {};
  // `timeout_seconds` is in the pr, worker, request, peer and process kinds: the pr schema's bounds
  // (1–7200, default 1800) are the advertised ones, and the others ride in the description.
  for (const option of [...cezarWaitRequestSchema.options].reverse()) {
    Object.assign(properties, z.toJSONSchema(option, { io: 'input' }).properties);
  }
  const field = (key: string, description: string) => ({ ...(properties[key] as object), description });
  return {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', enum: cezarWaitRequestSchema.options.map(option => option.shape.kind.value), description: '"pr" waits for a GitHub pull request: its checks or its merge (see `until`); "worker" waits for workers you own; "request" waits for replies to requests you sent; "peer" waits for named peer tasks to message you or settle; "timer" wakes you after `seconds`; "process" wakes you when a background command you started ends.' },
      pr: field('pr', 'kind "pr": the HTTPS GitHub pull request URL.'),
      until: field('until', 'kind "pr": "checks" (default) wakes you when the checks finish; "merge" wakes you only when GitHub reports the PR merged or closed without merge, so green checks keep it open.'),
      wake_on_conflict: field('wake_on_conflict', 'kind "pr": Default true. Set false when you watch a PR you do not own, such as another agent\'s PR your work depends on: you cannot resolve its conflicts. With until "checks", GitHub often runs no workflows on a conflicting PR, so the wait usually ends as no_checks or deadline.'),
      worker_ids: field('worker_ids', 'kind "worker": the workers you own to wait for (1–32 unique ids).'),
      request_ids: field('request_ids', 'kind "request": the requests you sent, to a worker, your parent or a peer task, to wait for a reply to (1–32 unique ids).'),
      peer_ids: field('peer_ids', 'kind "peer": the peer root tasks of this project to wait for (1–32 unique task ids; find them with `cez message tasks`). A message from one of them, or one of them settling, ends the wait; other messages wake you and keep it open.'),
      mode: field('mode', 'kind "worker" or "request": "any" wakes you when one selected id settles (default), "all" when every one has, "one" takes exactly one id.'),
      timeout_seconds: field('timeout_seconds', 'The deadline in seconds. kind "pr": 1–7200, default 1800. kind "worker", "request" or "peer": 1–1800, default 600 (the default shown is the pr one). kind "process": 1–7200, default 1800.'),
      seconds: field('seconds', 'kind "timer": seconds until the wake (60–7200).'),
      pid: field('pid', 'kind "process": the PID of the background command, as `echo $!` printed it.'),
      exit_file: field('exit_file', 'kind "process": optional file the command writes its exit code to, in $TMPDIR or the worktree; a new name for each command.'),
      note: field('note', 'kind "timer" or "process": what to re-check, handed back to you at the wake.'),
    },
    required: ['kind'],
    additionalProperties: false,
  };
}

export const waitToolDefinition = {
  name: 'cezar_wait',
  description: 'Open a wait on something outside this turn: a GitHub pull request\'s checks or its merge (kind "pr"), workers you own (kind "worker"), the replies to requests you sent (kind "request"), named peer tasks that may message you or settle (kind "peer"), a timer (kind "timer"), or a background command you started (kind "process"). End your turn after it answers; Cezar wakes you when any open wait resolves, with its result. A human message wakes you too and closes no wait; only a message from a peer that a peer wait names closes that wait. Several waits can be open at once; the answer lists them. To wait for the user, call cezar_ask. A checks observation is not merge approval; only a merge wait\'s "merged" outcome means the PR merged. ' +
    // hearsay-tools/cezarion#1446: the `sh -c` wrapper because omp's own shell prints no `$!`.
    'kind "process" wakes you when a command you started in the background ends. Start it as ' +
    '`sh -c \'( cmd > "$TMPDIR/build.log" 2>&1; echo $? > "$TMPDIR/build.exit" ) > /dev/null 2>&1 & echo $!\'` ' +
    'and pass the printed PID as `pid` and the exit file as `exit_file`, so the wake reports the exit code. ' +
    'Use a new exit file name for each command: a file that already exists resolves the wait at once. ' +
    'The job outlives this session and Cezar does not stop it.',
  inputSchema: flatWaitInputSchema(),
};
/**
 * hearsay-tools/cezarion#1234: the user's answer gets its own tool, so its card is required and
 * `cezar_wait` never has to explain a field only one kind takes. hearsay-tools/cezarion#1458: the
 * texts are research task 77dfb5c4's tested ones; on Claude, prose between tool calls may never
 * reach the user, so the content rides in `context`.
 */
export const askToolDefinition = {
  name: 'cezar_ask',
  description: `Ask the user for a decision or missing input. Put the full draft, findings, evidence and option meanings needed for the decision in context. Cezar renders context as Markdown above the question card. The user cannot see your reasoning or rejected tool calls. The question is a short choice, not the place for supporting detail. Each question takes a header of at most ${ASK_LIMITS.header} characters, a short question of at most ${ASK_LIMITS.question} characters, and ${ASK_LIMITS.minOptions}–${ASK_LIMITS.maxOptions} options shown as choices; leave the options out to let the user type the answer. The user can always type a reply of their own. Other open waits keep running while you wait. Then end your turn; the user's answer wakes you.`,
  inputSchema: { ...z.toJSONSchema(cezarAskRequestSchema, { io: 'input' }), type: 'object' as const },
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

export const cancelWaitToolDefinition = {
  name: 'cezar_cancel_wait',
  description: 'Close a wait you opened with cezar_wait (PR, worker, request, peer, process or timer) or cezar_ask, by its wait_id, so it never wakes you. A question the user already sees cannot be cancelled; only their answer ends it. A wait that already resolved is delivered with your next wake anyway; the answer says so and lists the waits still open.',
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

/** hearsay-tools/cezarion#1234: the agent declares the task (or step) done; since
 *  hearsay-tools/cezarion#2397 it is the only way to. */
export const doneToolDefinition = {
  name: 'cezar_done',
  description: 'Finish the task, or in a workflow step that is not the last, finish that step. Call it when the goal is fully achieved and verified and you have no question for the user; end your turn after it answers. Cezar closes the session at the end of this turn and cancels every open wait; after a step, Cezar starts the next step, and the answer names it. It refuses, naming what to do first, while owned workers are live or uncollected, a worker question is unanswered, or your question to the user is still pending.',
  inputSchema: { ...z.toJSONSchema(cezarDoneRequestSchema, { io: 'input' }), type: 'object' as const },
};
export async function invokeDoneTool(input: unknown) {
  const answer = await callCezarDone(input);
  const hint = !answer.ok ? 'Not finished. Do what the message says, then call cezar_done again.'
    : answer.completes === 'step' ? `Accepted. End your turn; Cezar completes this step at its end and starts "${answer.next_step}".`
    : 'Accepted. End your turn; Cezar finishes the task at its end.';
  return { content: [{ type: 'text' as const, text: `${JSON.stringify(answer)}\n${hint}` }], isError: !answer.ok, details: answer };
}

export const previewToolDefinition = {
  name: 'cezar_preview_serve',
  description: 'Register a web dev server of this task so the user can click through it in the cockpit\'s live preview. Always pin the port (`vite --strictPort`, `next dev -p`) so the server comes up on the port you register. Cezar starts the command itself when the user opens the preview; do not wait for the user. ' +
    'To drive the browser the user sees, connect to `$CEZ_PREVIEW_CDP_URL` when it is set, e.g. `agent-browser --cdp "$CEZ_PREVIEW_CDP_URL" --pin-tab open http://localhost:5173`; the user watches your page live. `agent-browser record` needs ffmpeg on PATH.',
  inputSchema: { ...z.toJSONSchema(previewServeRequestSchema, { io: 'input' }), type: 'object' as const },
};

/** JSON first, then the hint as a plain sentence: the shape every cezar tool answers in. */
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

/**
 * hearsay-tools/cezarion#1465: a one-time schedule starts later as an ordinary task, so the agent
 * does not keep a session parked on timers for days. `cezar_scheduled_tasks` takes one action per
 * call; its union is advertised as one flat object for the same reason as `cezar_wait`.
 */
export const scheduleTaskToolDefinition = {
  name: 'cezar_schedule_task',
  description: 'Schedule a new task to start once, later, in this project: give a name, the full prompt the task starts from, and either `at` (a local wall time YYYY-MM-DDTHH:MM with `time_zone`, an IANA name; the cockpit\'s zone when left out) or `delay` (30m, 6h, 7d of elapsed time from now). `latest_start` (10m to 30d) bounds how late it may still start after Cezarion was down; past it the schedule is marked missed. Pass enable: true only when the user\'s request asks for the work to run later; otherwise it is created paused for the user to enable. The new task does not see this conversation, so put every detail it needs in the prompt. The answer gives the stored time, its zone and the same moment in UTC.',
  inputSchema: { ...z.toJSONSchema(scheduleTaskRequestSchema, { io: 'input' }), type: 'object' as const },
};

function flatScheduledTasksInputSchema() {
  const properties: Record<string, unknown> = {};
  for (const option of scheduledTasksRequestSchema.options) Object.assign(properties, z.toJSONSchema(option, { io: 'input' }).properties);
  return {
    type: 'object' as const,
    properties: {
      ...properties,
      action: { type: 'string', enum: scheduledTasksRequestSchema.options.map(option => option.shape.action.value), description: '"list" lists the one-time schedules of this project; "show", "update", "pause", "enable" and "cancel" take the `id` a list or a create answered.' },
      archived: { ...(properties.archived as object), description: 'action "list": "include" adds the archived schedules, "only" lists just them.' },
    },
    required: ['action'],
    additionalProperties: false,
  };
}
export const scheduledTasksToolDefinition = {
  name: 'cezar_scheduled_tasks',
  description: 'List, show, update, pause, enable or cancel the one-time scheduled tasks of this project, one action per call. Change only the schedules the user asked you to manage. "update" takes the same fields as cezar_schedule_task; a new `at` or `delay` must be in the future. "cancel" archives the schedule so it never starts; an archived schedule cannot change.',
  inputSchema: flatScheduledTasksInputSchema(),
};

function scheduleHint(answer: ScheduleTaskAnswer | ScheduledTasksAnswer): string {
  if (answer.ok) return 'Done. Tell the user the stored time and zone.';
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
export function cezarToolNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return cezarTools(env).map(tool => tool.definition.name);
}

/**
 * Env names a harness must forward to the adapter process. Several harnesses spawn MCP servers
 * from an allowlist, so the preview and automations opt-ins ride along explicitly or the adapter never sees it.
 */
export function cezarToolEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['CEZ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET', ...(previewToolEnabled(env) ? ['CEZ_PREVIEW'] : []), ...(automationsToolEnabled(env) ? ['CEZ_AUTOMATIONS'] : [])];
}

export function cezarServerInstructions(env: NodeJS.ProcessEnv = process.env): string {
  return [
    'The interface to Cezarion, the orchestrator running this session. Load a tool below when its situation comes up.',
    ...cezarTools(env).map(tool => `- ${tool.definition.name}: ${tool.trigger}`),
  ].join('\n');
}
