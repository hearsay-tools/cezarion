import { TIMER_MAX_SECONDS, TIMER_MIN_SECONDS, type AskErrorCode, type DoneErrorCode, type WaitErrorCode } from '@open-mercato/cezar-contract/waits';
import { ASK_LIMITS } from '@open-mercato/cezar-contract/ask-schema';
import type { CiWaitErrorCode, PreviewResultCode, PreviewServeResult } from '@open-mercato/cezar-contract';
import type { ScheduledTaskRefusalCode } from '@open-mercato/cezar-contract/scheduled-tasks';
import type { z } from 'zod';

/** Safe diagnostics shared by the manager and private transport. Never forward raw errors. */
const messages: Record<CiWaitErrorCode, string> = {
  wait_conflict: 'A different CI wait is already active for this run.',
  unsupported_host: 'GitHub Enterprise host is not recognized; use a host configured with the existing GitHub authentication.',
  gh_missing: 'Install GitHub CLI (gh) to wait for CI.',
  authentication: 'Authenticate GitHub CLI with gh auth login and retry.',
  inaccessible_pr: 'The pull request is inaccessible; check its URL and GitHub permissions.',
  capacity: 'CI wait registration capacity is exhausted; retry later.',
  persistence: 'CI wait could not be saved; check local storage and retry.',
  query_timeout: 'GitHub metadata lookup timed out; check connectivity and retry.',
  invalid_request: 'Invalid CI wait arguments.',
  malformed_data: 'GitHub returned invalid CI metadata; check the pull request and retry.',
  output_limit: 'GitHub CI metadata exceeded the output limit; inspect the pull request before retrying.',
  command_failed: 'The GitHub CI query failed; check GitHub CLI connectivity and retry.',
  unavailable: 'CI tool unavailable: registration failed. Retry from the current session.',
  unauthorized: 'CI tool unavailable: session capability is missing or revoked. Use the current session tool.',
  manager_disposed: 'The run manager was disposed. Resume the task in a running cockpit before waiting for CI.',
  capability_revoked: 'The CI session capability was revoked. Use the current session tool.',
  run_missing: 'The run no longer exists. Start or resume an existing task before waiting for CI.',
  run_not_running: 'The run is not running or waiting. Resume it before registering a CI wait.',
  run_stopping: 'The run is stopping. Wait for it to stop, then resume before registering a CI wait.',
  session_replaced: 'The session was replaced or there is no active session. Use the current session tool after resuming.',
  session_closed: 'The agent session is closed. Resume the task before registering a CI wait.',
  run_cancelled: 'The run was cancelled. Resume it before registering a CI wait.',
  finish_requested: 'Run finish was requested. Complete that transition before resuming and registering a CI wait.',
  generation_mismatch: 'This CI tool belongs to an earlier session. Use the current session tool.',
  worker_wait_pending: 'A worker wait is still pending, including any result awaiting delivery. End your turn to receive its result, then retry the CI wait.',
  worker_execution_stopped: 'Worker execution has stopped. Ask the parent to resume the worker before waiting for CI.',
  root_finish_pending: 'The parent is finishing. Complete that transition before resuming and registering a CI wait.',
  registration_aborted: 'CI registration was interrupted during lookup. Retry from the current turn if a wait is still needed.',
  turn_changed: 'The agent turn changed during CI lookup. Register the wait again from the current turn.',
};

export function ciErrorMessage(code: CiWaitErrorCode): string {
  return messages[code];
}

// hearsay-tools/cezarion#1233: `cezar_wait` refusals. Each names what the agent can do next.
const waitMessages: Partial<Record<WaitErrorCode, string>> = {
  timers_disabled: 'Automatic re-checks are turned off for this workspace (Park until resumed). Do not register a timer; end your turn and the user resumes the task.',
  wake_budget_spent: 'This run spent its automatic wakes. Do not register another timer; call cezar_ask if you need the user, or end your turn.',
  capacity: 'Cezar cannot open another wait now: this run has the maximum open waits, or the CI watcher is full. Cancel a wait you no longer need with cezar_cancel_wait, or retry later.',
  denied_scope: 'This run cannot wait on those workers or requests: wait only on workers you own (a parent with the wait permission), or on requests you sent that are still accepted.',
  // hearsay-tools/cezarion#1446: process waits.
  exit_file_outside: 'exit_file must be inside the task worktree or the Cezar temp directory that $TMPDIR names, with no symlink leading out. If $TMPDIR is not under .ai/cezar or a cez-agent directory, use a git-ignored path in the worktree.',
  process_not_allowed: 'Cezar cannot wait on that PID: it is Cezar itself or an agent session, which ends only with the session. Pass the PID that `echo $!` printed for the background command.',
  process_not_owned: 'That PID belongs to another user, so Cezar cannot tell whether it is the process you started. Pass the PID of a command you started yourself.',
};

export function waitErrorMessage(code: WaitErrorCode): string {
  return waitMessages[code] ?? messages[code as CiWaitErrorCode];
}

// hearsay-tools/cezarion#1234: `cezar_ask` refusals. A question never meets a CI lookup, so none
// borrows the CI wording.
const askMessages: Record<AskErrorCode, string> = {
  autonomous_run: 'This is an autonomous run: do not wait for the user. Make a reasonable assumption and continue; the user can steer you at any time.',
  capacity: 'Cezar cannot open another wait now: this run has the maximum open waits. Cancel a wait you no longer need with cezar_cancel_wait, then ask again.',
  invalid_request: 'Invalid cezar_ask arguments.',
  persistence: 'Your question could not be saved; retry once, and if it fails again ask it in your final message.',
  unavailable: 'Cezar could not show your question now. Retry once; if it fails again, ask it in your final message.',
  unauthorized: 'This session\'s cezar tools are missing or revoked. Use the current session tool.',
  manager_disposed: 'The run manager was disposed. Ask your question in your final message.',
  capability_revoked: 'This session\'s cezar tools were revoked. Use the current session tool.',
  run_missing: 'The run no longer exists.',
  run_not_running: 'The run is not running or waiting. Resume it before asking.',
  run_stopping: 'The run is stopping. End your turn; it stops without your question.',
  session_replaced: 'The session was replaced or there is no active session. Use the current session tool after resuming.',
  session_closed: 'The agent session is closed. Resume the task before asking.',
  run_cancelled: 'The run was cancelled.',
  finish_requested: 'Finish was already requested for this run. End your turn.',
  generation_mismatch: 'This tool belongs to an earlier session. Use the current session tool.',
  worker_wait_pending: 'A worker wait is still pending, including any result awaiting delivery. End your turn to receive its result, then ask again if you still need the user.',
  worker_execution_stopped: 'Worker execution has stopped. Ask the parent to resume the worker before asking.',
  root_finish_pending: 'The parent is finishing. End your turn; the parent completes that transition.',
};

export function askErrorMessage(code: AskErrorCode): string {
  return askMessages[code];
}

const L = ASK_LIMITS;
const ASK_FIELDS = `cezar_ask takes context and questions: context of 1–${L.context} characters of Markdown, shown above the card, and 1–${L.questions} questions with unique texts, each with a header of 1–${L.header} characters, a question of 1–${L.question} characters, an optional id of 1–${L.id} characters, and either ${L.minOptions}–${L.maxOptions} options with unique labels of 1–${L.label} characters and descriptions of at most ${L.description} characters, or no options for an open question`;
/** hearsay-tools/cezarion#1428: a rejected call never reaches the user. hearsay-tools/cezarion#1458:
 *  the detail cut from a question belongs in `context`, which the user reads above the card. */
const ASK_CONTEXT = 'The user never sees a rejected call. Put the draft, findings, evidence and option meanings in context, and keep each question short.';
const ASK_FIELD_RULES: Record<string, string> = {
  context: `must be 1–${L.context} characters of Markdown`,
  questions: `must be a list of 1–${L.questions} questions with unique texts`,
  question_entry: 'must be an object with a header and a question',
  id: `must be 1–${L.id} characters`,
  header: `must be 1–${L.header} characters`,
  question: `must be 1–${L.question} characters`,
  options: `must be ${L.minOptions}–${L.maxOptions} options with unique labels, or left out for an open question`,
  option_entry: 'must be an object with a label and an optional description',
  label: `must be 1–${L.label} characters`,
  description: `must be at most ${L.description} characters`,
  multiSelect: 'must be true or false',
};

/** The rule for one failing path: its last field, or the entry of the list an index points into. */
function askFieldRule(path: readonly PropertyKey[]): string | undefined {
  const last = path.at(-1);
  if (typeof last === 'number') return ASK_FIELD_RULES[path.at(-2) === 'options' ? 'option_entry' : 'question_entry'];
  return typeof last === 'string' ? ASK_FIELD_RULES[last] : undefined;
}

/** Names every failing field with its limit, never the value the agent sent. */
export function askInvalidInput(error?: z.ZodError): string {
  const tail = `${ASK_CONTEXT} ${ASK_FIELDS}.`;
  const issue = error?.issues[0];
  if (issue?.code === 'unrecognized_keys') return `Unknown field ${issue.keys.map(key => JSON.stringify(key.slice(0, 64))).join(', ')}. ${tail}`;
  const failures = new Map<string, string>();
  for (const entry of error?.issues ?? []) {
    const rule = entry.path[0] === 'questions' ? askFieldRule(entry.path) : entry.path[0] === 'context' ? ASK_FIELD_RULES.context : undefined;
    const name = entry.path.filter(part => typeof part === 'string' || typeof part === 'number').join('.');
    if (rule && !failures.has(name)) failures.set(name, `\`${name}\` ${rule}`);
  }
  if (failures.size) return `${[...failures.values()].join('; ')}. ${tail}`;
  return `The arguments must be a JSON object. ${tail}`;
}

// hearsay-tools/cezarion#1234: `cezar_done` refusals that name no worker. The worker refusals list
// their workers and the commands that clear them, so the run manager writes those.
const doneMessages: Record<Exclude<DoneErrorCode, 'workers_outstanding' | 'workers_uncollected' | 'worker_questions'>, string> = {
  human_question_pending: 'Your question to the user is still unanswered. End your turn to wait for the answer; call cezar_done after it if the task is then complete.',
  worker_wait_pending: 'A worker wait is still pending, including any result awaiting delivery. End your turn to receive its result, then call cezar_done again.',
  not_final_step: 'This workflow step is not the last one: when your turn ends, Cezar runs the next step, and only the last step can finish the task. End your turn once this step\'s work is complete.',
  root_finish_pending: 'The parent is finishing. End your turn; the parent completes that transition.',
  manager_disposed: 'The run manager was disposed. Resume the task in a running cockpit before finishing.',
  capability_revoked: 'This session\'s cezar tools were revoked. Use the current session tool.',
  run_missing: 'The run no longer exists.',
  run_not_running: 'The run is not running or waiting. Resume it before finishing.',
  run_stopping: 'The run is stopping. End your turn; it stops without cezar_done.',
  session_replaced: 'The session was replaced or there is no active session. Use the current session tool after resuming.',
  session_closed: 'The agent session is closed. Resume the task before finishing.',
  run_cancelled: 'The run was cancelled.',
  finish_requested: 'Finish was already requested for this run. End your turn.',
  generation_mismatch: 'This tool belongs to an earlier session. Use the current session tool.',
  invalid_request: 'Invalid cezar_done arguments.',
  unavailable: 'Cezar could not accept cezar_done now. Retry once; if it fails again, end your turn and say the task is complete.',
};

export function doneErrorMessage(code: keyof typeof doneMessages): string {
  return doneMessages[code];
}

const DONE_FIELDS = 'cezar_done takes only an optional summary of at most 2000 characters';

/** Names the unknown field or the failing summary, never the value the agent sent. */
export function doneInvalidInput(error?: z.ZodError): string {
  const issue = error?.issues[0];
  if (issue?.code === 'unrecognized_keys') return `Unknown field ${issue.keys.map(key => JSON.stringify(key.slice(0, 64))).join(', ')}: ${DONE_FIELDS}.`;
  if (error?.issues.some(entry => entry.path[0] === 'summary')) return '`summary` must be a string of at most 2000 characters.';
  return `The arguments must be a JSON object: ${DONE_FIELDS}.`;
}

// #781: `cezar_preview_serve` results. Every one carries the agent's next step; none quotes a
// secret, an environment value or another task's path.
const EXAMPLE_CALL = '{ "command": "npm run dev -- --port 5173 --strictPort", "port": 5173 }';

/** The refusals cezar's tool server answers itself; registration codes come from its owner. */
export function previewRefusal(code: Extract<PreviewResultCode, 'preview_disabled' | 'headless' | 'unavailable'>): PreviewServeResult {
  switch (code) {
    case 'preview_disabled': return { ok: false, code, message: 'Live preview is not enabled in this cockpit.', hint: 'Do not retry. Tell the user the server command and port so they can open it themselves.' };
    case 'headless': return { ok: false, code, message: 'No cockpit is attached to this run (`cez run`).', hint: 'Do not retry. Report the command and port in your final message.' };
    case 'unavailable': return { ok: false, code, message: 'Cezar\'s tool server did not answer.', hint: 'Retry once. If it fails again, continue without preview and report the command and port in your message.' };
  }
}

const FIELD_RULES: Record<string, string> = {
  command: 'must be a string of 1 to 1024 characters',
  port: 'must be an integer between 1 and 65535',
  cwd: 'must be a path relative to the worktree root',
  label: 'must be a string of 1 to 48 characters',
  path: 'must be a path starting with "/"',
};

export function previewOversized(): PreviewServeResult {
  return { ok: false, code: 'invalid_input', message: 'The arguments exceed 16 KiB.', hint: `Send only the documented fields, e.g. ${EXAMPLE_CALL}, and call again.` };
}

/** Names the first failing field and its rule, then a valid example call. */
export function previewInvalidInput(error: z.ZodError, input: unknown): PreviewServeResult {
  const field = error.issues.map(issue => issue.path[0]).find((key): key is string => typeof key === 'string' && key in FIELD_RULES);
  if (!field) {
    return { ok: false, code: 'invalid_input', message: 'The arguments must be a JSON object with `command` and `port`.', hint: `Call again with a JSON object, e.g. ${EXAMPLE_CALL}.` };
  }
  const value = input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[field] : undefined;
  const got = value === undefined ? 'nothing' : JSON.stringify(value).slice(0, 64);
  return {
    ok: false,
    code: 'invalid_input',
    message: `\`${field}\` ${FIELD_RULES[field]} (got ${got}).`,
    hint: `"${field}" ${FIELD_RULES[field]}. A valid call: ${EXAMPLE_CALL}. Fix the field and call again.`,
  };
}

// hearsay-tools/cezarion#1233: `cezar_wait` and `cezar_cancel_wait` refusals name the first
// failing field and its rule, never the value the agent sent.
const WAIT_FIELD_RULES: Record<string, string> = {
  kind: 'must be "ci", "worker" or "timer"; ask the user with cezar_ask',
  pr: 'must be an HTTPS GitHub pull request URL (kind "ci")',
  timeout_seconds: 'must be an integer between 1 and 7200 (kind "ci") or between 1 and 1800 (kind "worker")',
  worker_ids: 'must be 1 to 32 unique worker ids you own (kind "worker"; give worker_ids or request_ids, not both)',
  request_ids: 'must be 1 to 32 unique ids of requests you sent (kind "worker"; give worker_ids or request_ids, not both)',
  mode: 'must be "one", "any" or "all"; "one" takes exactly one id (kind "worker")',
  seconds: `must be an integer between ${TIMER_MIN_SECONDS} and ${TIMER_MAX_SECONDS} (kind "timer")`,
  note: 'must be a string of at most 512 characters (kind "timer")',
  wait_id: 'must be a wait_id that cezar_wait answered',
};
const WAIT_FIELDS = 'kind "ci" takes pr and timeout_seconds; kind "worker" takes worker_ids or request_ids, mode and timeout_seconds; kind "timer" takes seconds and note';

export function waitInvalidInput(error?: z.ZodError): string {
  const issue = error?.issues[0];
  if (issue?.code === 'unrecognized_keys') return `Unknown field ${issue.keys.map(key => JSON.stringify(key.slice(0, 64))).join(', ')}: ${WAIT_FIELDS}.`;
  const field = error?.issues.map(entry => entry.path[0]).find((key): key is string => typeof key === 'string' && key in WAIT_FIELD_RULES);
  if (field) return `\`${field}\` ${WAIT_FIELD_RULES[field]}.`;
  return `The arguments must be a JSON object: ${WAIT_FIELDS}.`;
}

// hearsay-tools/cezarion#1465: `cezar_schedule_task` and `cezar_scheduled_tasks` refusals.
const scheduleMessages: Record<Extract<ScheduledTaskRefusalCode, 'automations_off' | 'unavailable'>, string> = {
  automations_off: 'Automations are off in this cockpit (CEZ_AUTOMATIONS is not 1), so Cezar cannot schedule a task. Tell the user.',
  unavailable: 'Cezar could not reach its scheduler for this session. Tell the user; scheduling needs a running cockpit.',
};
export function scheduleRefusal(code: ScheduledTaskRefusalCode, message?: string): { ok: false; code: ScheduledTaskRefusalCode; message: string } {
  return { ok: false, code, message: message ?? scheduleMessages[code as keyof typeof scheduleMessages] ?? 'Invalid arguments.' };
}

const SCHEDULE_FIELD_RULES: Record<string, string> = {
  action: 'must be "list", "show", "update", "pause", "enable" or "cancel"',
  id: 'must be the id of a one-time schedule a list or a create answered',
  archived: 'must be "include" or "only"',
  name: 'must be a string of 1 to 200 characters',
  prompt: 'must be a string of 1 to 100000 characters',
  at: 'must be a local wall time YYYY-MM-DDTHH:MM; give at or delay, not both',
  delay: 'must be a duration such as 30m, 6h or 7d; give at or delay, not both',
  time_zone: 'must be an IANA time zone name such as Europe/Warsaw',
  latest_start: 'must be a duration such as 30m, 6h or 7d',
  workflow: 'must be a workflow name',
  runner: 'must be a runner name',
  model: 'must be a model id',
  effort: 'must be an effort level',
  enable: 'must be true or false',
};

/** Names the unknown field or the first failing field and its rule, never the value sent. */
export function scheduleInvalidInput(error?: z.ZodError): string {
  const issue = error?.issues[0];
  if (issue?.code === 'unrecognized_keys') return `Unknown field ${issue.keys.map(key => JSON.stringify(key.slice(0, 64))).join(', ')}.`;
  const field = error?.issues.map(entry => entry.path[0]).find((key): key is string => typeof key === 'string' && key in SCHEDULE_FIELD_RULES);
  if (field) return `\`${field}\` ${SCHEDULE_FIELD_RULES[field]}.`;
  return 'The arguments must be a JSON object.';
}
