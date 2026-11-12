import { productEnv } from '../core/product-env.ts';
import { automationsEnabled } from '../automations/enabled.ts';
import { cezarAskRequestSchema, cezarCancelWaitRequestSchema, cezarDoneRequestSchema, cezarWaitRequestSchema } from '@open-mercato/cezar-contract/waits';
import { ASK_LIMITS } from '@open-mercato/cezar-contract/ask-schema';
import { previewStopRequestSchema, previewServeRequestSchema } from '@open-mercato/cezar-contract/preview';
import { scheduleTaskRequestSchema, scheduledTasksRequestSchema } from '@open-mercato/cezar-contract/scheduled-tasks';
import { z } from 'zod';

/** Live preview is on under the exact value `1` only (spec 2026-10-02-live-preview-v1). */
export function previewToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return productEnv('PREVIEW', env) === '1';
}

/** Automations are on unless the value is exactly `0` (spec 2026-10-02-scheduled-automations). */
export function automationsToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return automationsEnabled(env);
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
      kind: { type: 'string', enum: cezarWaitRequestSchema.options.map(option => option.shape.kind.value), description: '"pr" waits for a GitHub pull request: its checks or its merge (see `until`); "worker" waits for workers you own; "request" waits for replies to requests you sent; "peer" waits for named peer tasks to message you or settle; "timer" wakes you after `seconds`; "process" wakes you when a background command ends.' },
      operation_id: field('operation_id', 'Optional retry identity. Reuse it with exactly the same arguments after an unknown outcome; never use it for a different registration.'),
      pr: field('pr', 'kind "pr": the HTTPS GitHub pull request URL.'),
      until: field('until', 'kind "pr": "checks" (default) watches checks; "merge" waits for merge or closure and ignores queue removal. After requesting a merge, use "merge_or_blocked": wakes on merge, closure, conflict, or neither queue membership nor enabled auto-merge remaining. Pending checks or a queue slot alone do not end it. All targets retain their deadline and query-error exits. Only "merged" confirms success; "blocked" requires inspection and grants no permission to retry or merge.'),
      wake_on_conflict: field('wake_on_conflict', 'kind "pr": Default true for "checks" and "merge". Set false when your work depends on another PR merging and you want to ignore its conflicts. "merge_or_blocked" always reports conflicts, regardless of this setting. With "checks", a conflicting PR may have no checks, ending as no_checks or deadline.'),
      worker_ids: field('worker_ids', 'kind "worker": the workers you own to wait for (1–32 unique ids).'),
      request_ids: field('request_ids', 'kind "request": the requests you sent, to a worker, your parent or a peer task, to wait for a reply to (1–32 unique ids).'),
      peer_ids: field('peer_ids', 'kind "peer": the peer root tasks of this project to wait for (1–32 unique task ids; find them with `hsq message tasks`). A message from one of them, or one of them settling, ends the wait; other messages wake you and keep it open.'),
      mode: field('mode', 'kind "worker" or "request": "any" wakes you when one selected id settles (default), "all" when every one has, "one" takes exactly one id.'),
      timeout_seconds: field('timeout_seconds', 'The deadline in seconds. kind "pr": 1–7200, default 1800. kind "worker", "request" or "peer": 1–7200, default 600 (the default shown is the pr one). kind "process": 1–7200, default 1800.'),
      seconds: field('seconds', 'kind "timer": seconds until the wake (60–7200).'),
      pid: field('pid', 'kind "process": the PID of the background command: the `pid` the job start command printed.'),
      exit_file: field('exit_file', 'kind "process": optional. Only a file that your own wrapper writes the exit code to, in $TMPDIR or the worktree, with a new name for each command. Leave it out for a command that is already running or that writes its status file somewhere else.'),
      note: field('note', 'kind "timer" or "process": what to re-check, handed back to you at the wake.'),
    },
    required: ['kind'],
    additionalProperties: false,
  };
}

export const waitToolDefinition = {
  name: 'cezar_wait',
  description: 'Open a wait on something outside this turn: a GitHub pull request\'s checks or its merge (kind "pr"), workers you own (kind "worker"), the replies to requests you sent (kind "request"), named peer tasks that may message you or settle (kind "peer"), a timer (kind "timer"), or a background command (kind "process"). End your turn after it answers; Cezar wakes you when any open wait resolves, with its result. A human message wakes you too and closes no wait; only a message from a peer that a peer wait names closes that wait. Several waits can be open at once; the answer lists them. To wait for the user, call cezar_ask. A checks observation is not merge approval; only a merge wait\'s "merged" outcome means the PR merged. Times in the answers, such as `deadline`, are UTC. ' +
    // hearsay-tools/cezarion#3097: Codex ends a command's process group when the command returns,
    // so a plain `&` job dies there, and `setsid … & echo $!` prints a dead PID under Claude.
    'kind "process" wakes you when a background command ends. To start one yourself, run ' +
    '`hsq job start <name> -- <command> [args...]` (your instructions give the full command for this session under "Long commands") ' +
    'and pass the `pid` and `exitFile` it prints as `pid` and `exit_file`, so the wake reports the exit code. ' +
    'It writes the command\'s output to the `log` file it prints, refuses a name that still runs, and the job outlives this session; Cezar does not stop it. ' +
    'Its files are in $TMPDIR, which Cezar removes when the task ends: for a job that must outlive the task, add `--dir <a git-ignored directory in the worktree>` before `--`. ' +
    'Do not start a long command with `&`, `nohup`, `setsid` or your own background-task tool: it can end with the shell call or the session, or leave you a PID that is not the command\'s. ' +
    // A batch that writes its exit file outside $TMPDIR made agents start a watcher to copy it in.
    'For a command that is already running, or that writes its own status file somewhere else, pass only its `pid` and leave `exit_file` out. ' +
    'The wake then reports `exited` without a code: read the command\'s own log or status file after it. ' +
    'Never start a watcher or helper process to copy a file into $TMPDIR. ' +
    'An unchanged repeat names the retained wait. A changed timeout is refused and keeps that wait active; do not cancel it as a duplicate. On an unknown outcome retry the same operation_id and arguments, without a fallback timer.',
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

export const cancelWaitToolDefinition = {
  name: 'cezar_cancel_wait',
  description: 'Close a wait you opened with cezar_wait (PR, worker, request, peer, process or timer) or cezar_ask, by its wait_id, so it never wakes you. A question the user already sees cannot be cancelled; only their answer ends it. A wait that already resolved is delivered with your next wake anyway; the answer says so and lists the waits still open.',
  inputSchema: { ...z.toJSONSchema(cezarCancelWaitRequestSchema, { io: 'input' }), type: 'object' as const },
};

/** hearsay-tools/cezarion#1234: the agent declares the task (or step) done; since
 *  hearsay-tools/cezarion#2397 it is the only way to. */
export const doneToolDefinition = {
  name: 'cezar_done',
  description: 'Finish the task, or in a workflow step that is not the last, finish that step. Call it when the goal is fully achieved and verified and you have no question for the user; end your turn after it answers. Cezar closes the session at the end of this turn and cancels every open wait; after a step, Cezar starts the next step, and the answer names it. It refuses, naming what to do first, while owned workers are live or uncollected, a worker question is unanswered, or your question to the user is still pending.',
  inputSchema: { ...z.toJSONSchema(cezarDoneRequestSchema, { io: 'input' }), type: 'object' as const },
};

export const previewToolDefinition = {
  name: 'cezar_preview_serve',
  description: 'Register a web dev server of this task so the user can click through it in the cockpit\'s live preview. Always pin the port (`vite --strictPort`, `next dev -p`) so the server comes up on the port you register. Cezar starts the command itself when the user opens the preview; do not wait for the user. ' +
    'To drive the browser the user sees, connect to `$CEZ_PREVIEW_CDP_URL` when it is set, e.g. `agent-browser --cdp "$CEZ_PREVIEW_CDP_URL" --pin-tab open http://localhost:5173`; the user watches your page live. `agent-browser record` needs ffmpeg on PATH.',
  inputSchema: { ...z.toJSONSchema(previewServeRequestSchema, { io: 'input' }), type: 'object' as const },
};

export const previewStopToolDefinition = {
  name: 'cezar_preview_stop',
  description: 'Stop a preview server Cezar started for your own task. Set restart to true to reuse the unchanged command the owner approved, including after a crash. Adopted servers cannot be stopped; changed registrations need the owner to press Run and open again.',
  inputSchema: { ...z.toJSONSchema(previewStopRequestSchema, { io: 'input' }), type: 'object' as const },
};

/**
 * hearsay-tools/cezarion#1465: a one-time schedule starts later as an ordinary task, so the agent
 * does not keep a session parked on timers for days. `cezar_scheduled_tasks` takes one action per
 * call; its union is advertised as one flat object for the same reason as `cezar_wait`.
 */
export const scheduleTaskToolDefinition = {
  name: 'cezar_schedule_task',
  description: 'Schedule a new task to start once, later, in this project: give a name, the full prompt the task starts from, and either `at` (a UTC time YYYY-MM-DDTHH:MMZ, like every time in Cezar tools) or `delay` (30m, 6h, 7d of elapsed time from now). For a relative time ("in 2 hours"), use `delay`. For a clock time that the user names, convert it from the user\'s time zone to UTC. `latest_start` (10m to 30d) bounds how late it may still start after Cezarion was down; past it the schedule is marked missed. Pass enable: true only when the user\'s request asks for the work to run later; otherwise it is created paused for the user to enable. The new task does not see this conversation, so put every detail it needs in the prompt. The answer gives `due_at` in UTC. The cockpit shows the schedule in local time.',
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

/** Tool definitions in the same order every adapter advertises them. */
export function cezarToolDefinitions(env: NodeJS.ProcessEnv = process.env) {
  return [
    waitToolDefinition, askToolDefinition, cancelWaitToolDefinition, doneToolDefinition,
    ...(previewToolEnabled(env) ? [previewToolDefinition, previewStopToolDefinition] : []),
    ...(automationsToolEnabled(env) ? [scheduleTaskToolDefinition, scheduledTasksToolDefinition] : []),
  ];
}
export function cezarToolNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return cezarToolDefinitions(env).map(tool => tool.name);
}

/**
 * Env names a harness must forward to the adapter process. Several harnesses spawn MCP servers
 * from an allowlist, so preview opt-in and automations opt-out must both reach the adapter.
 */
export function cezarToolEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['CEZ_TOOL_TOKEN', 'CEZ_TOOL_SOCKET', 'CEZ_AUTOMATIONS', ...(previewToolEnabled(env) ? ['CEZ_PREVIEW'] : [])]
    .flatMap(name => { const preferred = name.replace(/^CEZ_/, 'HSQ_'); return env[preferred] === undefined ? [name] : [name, preferred]; });
}
