import { randomUUID } from 'node:crypto';
import { open as openFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  apiRunSchema,
  archiveFinishedResponseSchema,
  cancelResponseSchema,
  changesPayloadSchema,
  finishResponseSchema,
  messageResponseSchema,
  runHistoryContextSchema,
  runRecordSchema,
  runStatusSchema,
  type RunRecord,
  skillSchema,
  type ApiRun,
  type RunSummary,
} from '@open-mercato/cezar-contract';
import { openUrl } from '../open-url.ts';
import { skillFlagIssue, skillTaskSteps } from '../workflows/types.ts';
import { discoverCockpit, type DiscoverOptions } from './discovery.ts';
import { handoffUrl, invalidResponse, refuse, request, TaskCliError, threadUrl, type Cockpit } from './http.ts';
import { projectListRow, projectStatus } from './projections.ts';
import { DEFAULT_WAIT_UNTIL, readLog, requestRunSummaries, waitForRuns, type WaitMode, type WaitUntil } from './watch.ts';

/**
 * `cez task` — start, watch and steer cockpit tasks from a terminal or a bot (#504, spec
 * 2026-09-24-cez-task-cli). A thin JSON client over the cockpit's own run routes: one JSON
 * object per invocation, and an exit code a caller can branch on without parsing a status.
 */

export const EXIT = { ok: 0, failed: 1, refused: 2, timeout: 3, usage: 64 } as const;

export interface TaskIo {
  stdout(line: string): void;
  /** The whole of stdin, for `--task-file -` / `--text-file -`. */
  stdin?: () => Promise<string>;
  discover?: (options: DiscoverOptions) => Promise<Cockpit>;
  open?: (url: string) => void;
  /** `wait`'s poll interval; tests shorten it. */
  pollMs?: number;
}

type FlagSpec = { type: 'string' | 'boolean'; multiple?: boolean; help: string };

const COMMON: Record<string, FlagSpec> = {
  url: { type: 'string', help: '<origin>          Cockpit to use instead of discovery (also CEZ_URL).' },
  repo: { type: 'string', help: '<dir>            Checkout whose cockpit to find (default: cwd).' },
  help: { type: 'boolean', help: '                 Show help; needs no cockpit.' },
};

interface Operation {
  args: string;
  description: string;
  positionals: [min: number, max: number];
  flags: Record<string, FlagSpec>;
}

const STATUS_VALUES = runStatusSchema.options.join(', ');
const TASK_TEXT_MAX_CHARS = 100_000;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1_800;
const TIMEOUT_FLAG: FlagSpec = { type: 'string', help: `<1-${MAX_TIMEOUT_SECONDS}>  Give up after this many seconds (default ${DEFAULT_TIMEOUT_SECONDS}).` };
/** Shared by `wait` and `start --wait` (#553): attention is the default, settled the opt-in. */
const UNTIL_FLAG: FlagSpec = { type: 'string', help: '<attention|settled> attention (default): stop when the task needs you or ends; settled: terminal status only.' };

export const OPERATIONS: Record<string, Operation> = {
  start: {
    args: "--task-file <path|-> | '<task>'",
    description: 'Start a task in the cockpit serving this checkout.',
    positionals: [0, 1],
    flags: {
      'task-file': { type: 'string', help: '<path|->     Read the task from a file, or stdin with -.' },
      'request-id': { type: 'string', help: '<UUID>     Retry-safe id; reuse it when retrying this start.' },
      workflow: { type: 'string', help: '<name>       Workflow (default quick-task).' },
      skill: { type: 'string', help: '<name>          Run one discovered skill instead of a workflow.' },
      backend: { type: 'string', help: '<id>          claude | codex | opencode | pi | cursor | omp.' },
      model: { type: 'string', help: '<model>         Model override.' },
      effort: { type: 'string', help: '<level>       Reasoning effort.' },
      autonomous: { type: 'boolean', help: '         Never park for input; run to completion.' },
      'no-worktree': { type: 'boolean', help: '      Run in the repo working tree, not a worktree.' },
      wait: { type: 'boolean', help: '               Then wait until the task needs you or ends (see wait).' },
      until: UNTIL_FLAG,
      'timeout-seconds': TIMEOUT_FLAG,
      notify: { type: 'boolean', help: '             POST status changes to the project webhook (default when it has one).' },
      'no-notify': { type: 'boolean', help: '          Do not notify the project webhook.' },
    },
  },
  list: {
    args: '',
    description: 'List tasks, newest first: currentStepId when running, pullRequestUrl when done/review, error when failed (first line, 200 characters including … when cut). Workers are left out; address one by id.',
    positionals: [0, 0],
    flags: {
      status: { type: 'string', help: `<s>[,<s>…]     Only these statuses: ${STATUS_VALUES}.` },
      limit: { type: 'string', help: '<n>             At most n rows (default 20).' },
      all: { type: 'boolean', help: '                Include archived tasks.' },
      full: { type: 'boolean', help: '               Print contract ApiRun rows.' },
    },
  },
  status: {
    args: '<id>',
    description: 'Show one task, including handoffUrl (the handoff endpoint) and the full error when set.',
    positionals: [1, 1],
    flags: { full: { type: 'boolean', help: '               Print the contract ApiRun.' } },
  },
  log: {
    args: '<id>',
    description: "Print a task's recent transcript as JSON lines, oldest first.",
    positionals: [1, 1],
    flags: {
      since: { type: 'string', help: '<seq>           Only events after this seq.' },
      'max-chars': { type: 'string', help: '<n>        Keep the newest lines within n characters (default 8000).' },
      follow: { type: 'boolean', help: '             Keep streaming until the task ends or the timeout.' },
      'timeout-seconds': TIMEOUT_FLAG,
    },
  },
  wait: {
    args: '<id>...',
    description: 'Block until the tasks need you (default) or settle; exit 0 done/review/attention, 1 failed/cancelled, 3 timeout.',
    positionals: [1, 32],
    flags: {
      mode: { type: 'string', help: '<any|all>        Return on the first task or on all of them (default all).' },
      until: UNTIL_FLAG,
      'timeout-seconds': TIMEOUT_FLAG,
    },
  },
  send: {
    args: "<id> '<text>' | <id> --text-file <path|->",
    description: 'Steer or answer a task: delivered to a live session, queued before it starts, resumed from a closed session with --resume (examples below).',
    positionals: [1, 2],
    flags: {
      'text-file': { type: 'string', help: '<path|->     Read the text from a file, or stdin with -.' },
      resume: { type: 'boolean', help: '             Reopen a closed session with this text.' },
      notify: { type: 'boolean', help: '             Also turn the project webhook on for this task.' },
    },
  },
  notify: {
    args: "<id> [--message '<note>' | --message-file <path|->]",
    description: 'Hand a task to the project webhook (on), or stop notifying it (--off). A worker is refused: notify its parent.',
    positionals: [1, 1],
    flags: {
      off: { type: 'boolean', help: '                Stop notifying the webhook about this task.' },
      message: { type: 'string', help: "'<note>'       Note for the webhook's task.subscribed delivery." },
      'message-file': { type: 'string', help: '<path|->  Read the note from a file, or stdin with -.' },
    },
  },
  stop: { args: '<id>', description: 'Cancel a task.', positionals: [1, 1], flags: {} },
  finish: { args: '<id>', description: 'Close a waiting session as done.', positionals: [1, 1], flags: {} },
  archive: { args: '<id>', description: 'Archive a task.', positionals: [1, 1], flags: {} },
  unarchive: { args: '<id>', description: 'Restore an archived task.', positionals: [1, 1], flags: {} },
  'archive-finished': { args: '', description: 'Archive finished tasks (scheduled runs and owned workers excluded).', positionals: [0, 0], flags: {} },
  diff: {
    args: '<id>',
    description: "Show a task's changes.",
    positionals: [1, 1],
    flags: { stat: { type: 'boolean', help: '               Per-file counts instead of the patch.' } },
  },
  open: {
    args: '<id>',
    description: "Print (and open) a task's thread URL.",
    positionals: [1, 1],
    flags: { 'no-open': { type: 'boolean', help: '         Print the URL only.' } },
  },
};

/**
 * The clear contract (#553, #609), printed on every command a bot reads a run's state from.
 * `attention` and `attentionLabel` come from the cockpit's own attention function (the
 * contract's `deriveAttention`), so what the CLI says a run needs is what Needs You shows.
 */
const ATTENTION_HELP_OPERATIONS = new Set(['start', 'wait', 'status', 'list']);
const ATTENTION_HELP = [
  'Attention — when a task needs you:',
  '  status, list and wait carry `attention` (the cockpit bucket) and `attentionLabel` (its phrase),',
  '  derived by the same function as the cockpit\'s Needs You. Read those, not the raw status:',
  '  - `waiting` is attention even when hasPendingHumanAsk is false (a finished turn parks the task);',
  '    never clear a task on hasPendingHumanAsk alone.',
  '  - `running` with activity `monitoring` is neither settled nor attention: the agent is still',
  '    working on its own sub-agents or a watched command. attention: running.',
  '  - a task parked on its own workers ("waiting on 2 workers") is attention: none; keep waiting.',
  '  - attention: waiting | error | permission ends a wait; attentionLabel says why ("needs you",',
  '    "needs review", "failed").',
  '  --until attention (default) stops when the task needs you or ends. --until settled is the',
  '  opt-in for autonomous runs and bots that want terminal state only (done/review/failed/cancelled).',
  '  cez task wait <id>                   # default: stops when the task needs you',
  '  cez task wait <id> --until settled   # terminal status only',
  "  cez task start '…' --wait            # returns as soon as the agent parks for follow-up",
  "  cez task start '…' --wait --autonomous --until settled   # runs to completion, then returns",
  '',
];

function usage() {
  return { operations: Object.entries(OPERATIONS).map(([name, op]) => ({ name, synopsis: `cez task ${name} ${op.args}`.trim() })) };
}

function usageError(error: string, detail: Record<string, unknown> = {}): never {
  throw new TaskCliError(EXIT.usage, { code: 'invalid_input', error, ...detail, usage: usage() });
}

export function taskHelp(operation?: string): string {
  const names = operation ? [operation] : Object.keys(OPERATIONS);
  const flags = new Map<string, FlagSpec>();
  for (const name of names) for (const [flag, spec] of Object.entries(OPERATIONS[name]!.flags)) flags.set(flag, spec);
  for (const [flag, spec] of Object.entries(COMMON)) flags.set(flag, spec);
  return [
    'cezar task — start, watch and steer cockpit tasks from the terminal', '', 'Usage:',
    ...names.flatMap((name) => {
      const op = OPERATIONS[name]!;
      return [`  cez task ${name} ${op.args}`.trimEnd(), `    ${op.description}`];
    }), '', 'Options:',
    ...[...flags].map(([flag, spec]) => `  --${flag} ${spec.help}`), '',
    ...(names.some((name) => ATTENTION_HELP_OPERATIONS.has(name)) ? ATTENTION_HELP : []),
    ...(names.includes('start') ? [
      'Safe task input (file or stdin):',
      '  cez task start --task-file task.md',
      "  cez task start --task-file - <<'EOF'",
      'Fix the `cez task` docs; keep $(example) literal.',
      'EOF', '',
      'POSIX shells expand backticks and $() in double-quoted arguments',
      'before the CLI receives the text. Do not put raw backticks in double-quoted task arguments.',
      'Use --task-file PATH or --task-file - with a quoted heredoc delimiter as above.',
      "For short tasks, a single-quoted positional argument still works: cez task start 'Fix the typo'.", '',
    ] : []),
    ...(names.includes('send') ? [
      'Send — steer, answer or reopen:',
      '  delivery: delivered means the live session accepted the text; queued means it is saved',
      '  for a task that has not started; resumed means --resume reopened a closed session.',
      '  Steer while running:',
      "    cez task send <id> 'Use the retry helper instead'",
      '  Answer a pending question after wait ends with attention: waiting, or status shows question:',
      "    cez task send <id> 'Use option A'",
      '  Reopen a settled session:',
      "    cez task send <id> --resume '…'",
      '  Without --resume a closed session returns delivery: not-delivered and a next command.',
      '  Use --text-file <path|-> for multi-line or shell-sensitive text; --text-file - reads stdin.',
      '  See the safe task input / quoting note in cez task start --help; the same shell rules apply.',
      '',
    ] : []),
    'Commands find the running cockpit that serves this checkout (ports 4321-4370) and print JSON.',
    'notify: with a task webhook set in Settings → General, start notifies it unless --no-notify;',
    'the webhook gets task.status, task.question, task.activity and task.subscribed POSTs.',
    'Exit codes: 0 ok (wait/start --wait: done, review, or stopped for attention) · 1 task failed/cancelled',
    'or message not delivered · 2 no cockpit or refused · 3 timed out · 64 usage error.',
  ].join('\n');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > TASK_TEXT_MAX_CHARS * 4) usageError('stdin is larger than the 100000-character limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function readTextFile(path: string): Promise<string> {
  let handle;
  try { handle = await openFile(path, 'r'); } catch { usageError(`cannot read ${path}`); }
  try {
    const buffer = Buffer.alloc(TASK_TEXT_MAX_CHARS * 4 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > TASK_TEXT_MAX_CHARS * 4) usageError(`${path} is larger than the 100000-character limit`);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

/** A positional, or `--*-file <path|->`; never both, never empty. */
async function textArgument(io: TaskIo, operation: string, positional: string | undefined, file: string | undefined, what: string): Promise<string> {
  if (positional !== undefined && file !== undefined) usageError(`${operation} takes the ${what} as an argument or a file, not both`);
  const text = file === undefined ? positional : file === '-' ? await (io.stdin ?? readStdin)() : await readTextFile(file);
  if (text === undefined || !text.trim()) usageError(`${operation} is missing the ${what}`);
  if (text.length > TASK_TEXT_MAX_CHARS) usageError(`${what} is longer than ${TASK_TEXT_MAX_CHARS} characters`);
  return text;
}

function parseOperation(argv: string[]) {
  const [name, ...rest] = argv;
  if (name === undefined) usageError('missing operation');
  const operation = OPERATIONS[name];
  if (!operation) usageError(`unknown operation '${name}'`);
  const options = Object.fromEntries(
    Object.entries({ ...operation.flags, ...COMMON }).map(([flag, spec]) => [flag, { type: spec.type, ...(spec.multiple ? { multiple: true } : {}) }]),
  ) as Record<string, { type: 'string' | 'boolean' }>;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
  } catch (error) {
    usageError(`${name}: ${error instanceof Error ? error.message : 'invalid arguments'}`);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (!values.help) {
    const [min, max] = operation.positionals;
    if (parsed.positionals.length < min) usageError(`${name} is missing a positional`);
    if (parsed.positionals.length > max) usageError(`${name} has an extra argument`);
  }
  return { name, values, positionals: parsed.positionals };
}

function positiveInt(value: string | boolean | undefined, flag: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    usageError(`--${flag} must be an integer from 1 to ${max}`);
  }
  return Number(value);
}

function nonNegativeInt(value: string | boolean | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) usageError(`--${flag} must be a non-negative integer`);
  return Number(value);
}

function timeoutMs(values: Record<string, string | boolean | undefined>): number {
  return (positiveInt(values['timeout-seconds'], 'timeout-seconds', MAX_TIMEOUT_SECONDS) ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;
}

function oneOf<T extends string>(value: string | boolean | undefined, flag: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) usageError(`--${flag} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function waitUntil(values: Values): WaitUntil {
  return oneOf<WaitUntil>(values.until, 'until', ['settled', 'attention'], DEFAULT_WAIT_UNTIL);
}

function statuses(value: string | boolean | undefined) {
  if (typeof value !== 'string') return undefined;
  const list = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  const invalid = list.find((entry) => !runStatusSchema.safeParse(entry).success);
  if (invalid) usageError(`unknown status '${invalid}'; one of ${STATUS_VALUES}`);
  return new Set(list);
}

/** Every flag check `execute` makes, run up front so a bad flag never waits on discovery. */
function validateFlags(name: string, values: Values): void {
  if (name === 'start') {
    const issue = skillFlagIssue({
      skill: values.skill as string | undefined,
      workflow: values.workflow as string | undefined,
    });
    if (issue) usageError(issue);
    if (values.notify && values['no-notify']) usageError('--notify and --no-notify cannot be used together');
    if (values.until !== undefined && !values.wait) usageError('--until needs --wait');
  }
  if (name === 'notify') {
    if (values.message !== undefined && values['message-file'] !== undefined) usageError('notify takes the note as --message or --message-file, not both');
    if (values.off && (values.message !== undefined || values['message-file'] !== undefined)) usageError('--off takes no note');
  }
  if (name === 'list') { statuses(values.status); positiveInt(values.limit, 'limit', 1_000); }
  if (name === 'wait') oneOf<WaitMode>(values.mode, 'mode', ['any', 'all'], 'all');
  if (name === 'wait' || name === 'start') waitUntil(values);
  if (name === 'log') { nonNegativeInt(values.since, 'since'); positiveInt(values['max-chars'], 'max-chars', 1_000_000); }
  if (name === 'wait' || name === 'log' || (name === 'start' && values.wait)) timeoutMs(values);
}

async function getRun(cockpit: Cockpit, id: string): Promise<ApiRun> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}`);
  if (result.status !== 200) refuse(result);
  const run = apiRunSchema.safeParse(result.data);
  return run.success ? run.data : invalidResponse('run');
}

/** `list --full` prints contract `ApiRun` rows, so it alone still reads every full record. */
async function listRuns(cockpit: Cockpit): Promise<ApiRun[]> {
  const result = await request(cockpit, '/runs');
  if (result.status !== 200) refuse(result);
  const runs = apiRunSchema.array().safeParse(result.data);
  return runs.success ? runs.data : invalidResponse('run list');
}

/**
 * Workers are steer targets of their parent, not tasks ops follows (#635): the list leaves them
 * out, and subscribing one to the webhook is refused with the parent to subscribe instead. Every
 * other id-addressed operation still reaches a worker.
 */
function workerParent(run: Pick<ApiRun, 'delegation'> | Pick<RunSummary, 'delegation'>): string | undefined {
  return run.delegation?.role === 'worker' ? run.delegation.parentRunId : undefined;
}

async function refuseWorkerNotify(cockpit: Cockpit, id: string): Promise<void> {
  const parentId = workerParent(await getRun(cockpit, id));
  if (parentId !== undefined) {
    usageError(`task ${id} is a worker of task ${parentId}; notify the parent instead: cez task notify ${parentId}`, { parentId });
  }
}

/** The latest valid unanswered question, from the same derivation the cockpit renders. */
async function pendingQuestion(cockpit: Cockpit, id: string): Promise<unknown> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}/history-context`);
  const context = runHistoryContextSchema.safeParse(result.data);
  if (result.status !== 200 || !context.success) return undefined;
  const ask = [...context.data.contextEvents].reverse().find((event) => event.type === 'ask.requested');
  return ask?.questions;
}

type Values = Record<string, string | boolean | undefined>;
type Printer = (value: unknown) => void;

async function start(cockpit: Cockpit, io: TaskIo, values: Values, task: string, print: Printer): Promise<number> {
  const waitMs = values.wait ? timeoutMs(values) : undefined;
  const requestId = (values['request-id'] as string | undefined) ?? randomUUID();
  const skill = values.skill as string | undefined;
  // `--notify` is an explicit opt-in the server may refuse (no webhook: 400 with a hint). The
  // implicit default only opts in where the project has a webhook, so a bot on a fresh project
  // is never blocked (#589).
  const notify = values['no-notify'] ? false : values.notify ? true : cockpit.hasWebhook ? true : undefined;
  let warning: string | undefined;
  if (skill !== undefined) {
    // Discovery is advisory: the catalog can change before a queued run executes. The server
    // handles missing skills with a plain prompt, and idempotent retries still go to POST /runs.
    const unverified = `could not check whether skill "${skill}" is available; the run may use the plain prompt`;
    try {
      const catalog = await request(cockpit, '/skills?wait=1');
      if (catalog.status === 200) {
        const skills = skillSchema.array().safeParse(catalog.data);
        warning = skills.success
          ? skills.data.some((entry) => entry.name === skill)
            ? undefined
            : `skill "${skill}" is not currently available; the run may use the plain prompt`
          : unverified;
      } else {
        warning = unverified;
      }
    } catch {
      warning = unverified;
    }
  }
  const result = await request(cockpit, '/runs', {
    body: {
      task,
      ...(skill === undefined
        ? { workflow: (values.workflow as string | undefined) ?? 'quick-task' }
        : { steps: skillTaskSteps(skill) }),
      ...(values.backend === undefined ? {} : { runner: values.backend }),
      ...(values.model === undefined ? {} : { model: values.model }),
      ...(values.effort === undefined ? {} : { effort: values.effort }),
      ...(values.autonomous ? { autonomous: true } : {}),
      ...(values['no-worktree'] ? { worktree: false } : {}),
      ...(notify === undefined ? {} : { notify }),
      clientRequestId: requestId,
    },
  });
  if (result.status !== 200 && result.status !== 201) refuse(result);
  const run = runRecordSchema.safeParse(result.data);
  if (!run.success) invalidResponse('start');
  const started = {
    id: run.data.id,
    url: threadUrl(cockpit, run.data.id),
    status: run.data.status,
    created: result.status === 201,
    requestId,
    notify: run.data.notify === true,
    ...(warning === undefined ? {} : { warning }),
    ...(run.data.branch === undefined ? {} : { branch: run.data.branch }),
  };
  if (waitMs === undefined) { print(started); return EXIT.ok; }
  const waited = await waitForRuns(cockpit, [run.data.id], { mode: 'all', until: waitUntil(values), timeoutMs: waitMs, pollMs: io.pollMs });
  const final = waited.runs[0]!;
  print({ ...started, ...final, until: waited.until, timedOut: waited.timedOut });
  return waited.exitCode;
}

async function setNotify(cockpit: Cockpit, id: string, notify: boolean, message: string | undefined): Promise<RunRecord> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}/notify`, {
    body: { notify, ...(message === undefined ? {} : { message }) },
  });
  if (result.status !== 200) refuse(result);
  const run = runRecordSchema.safeParse(result.data);
  return run.success ? run.data : invalidResponse('notify');
}

async function send(cockpit: Cockpit, values: Values, id: string, text: string, print: Printer): Promise<number> {
  const path = `/runs/${encodeURIComponent(id)}`;
  if (values.notify) await refuseWorkerNotify(cockpit, id);
  // Before the message, so the status change it causes is already reported.
  const notified = values.notify ? { notify: (await setNotify(cockpit, id, true, undefined)).notify === true } : {};
  const delivered = await request(cockpit, `${path}/messages`, { body: { text } });
  if (delivered.status === 200) {
    const answer = messageResponseSchema.safeParse(delivered.data);
    if (!answer.success) invalidResponse('message');
    const delivery = 'delivered' in answer.data ? 'delivered' : 'queued' in answer.data ? 'queued' : 'deferred';
    print({ id, delivery, ...notified });
    return EXIT.ok;
  }
  const closed = delivered.status === 409 && (delivered.data as { error?: unknown } | undefined)?.error === 'session closed';
  if (!closed) refuse(delivered);
  if (!values.resume) {
    print({ id, delivery: 'not-delivered', reason: 'session closed', next: `cez task send ${id} '…' --resume`, ...notified });
    return EXIT.failed;
  }
  const resumed = await request(cockpit, `${path}/continue`, { body: { text } });
  if (resumed.status !== 200) refuse(resumed);
  print({ id, delivery: 'resumed', ...notified });
  return EXIT.ok;
}

async function execute(
  name: string, cockpit: Cockpit, io: TaskIo, values: Values, positionals: string[], text: string | undefined, print: Printer,
): Promise<number> {
  const id = positionals[0]!;
  const path = `/runs/${encodeURIComponent(id)}`;
  switch (name) {
    case 'start':
      return start(cockpit, io, values, text!, print);
    case 'send':
      return send(cockpit, values, id, text!, print);
    case 'notify': {
      // --off stays open so a subscription made before this guard can still be undone.
      if (!values.off) await refuseWorkerNotify(cockpit, id);
      const run = await setNotify(cockpit, id, !values.off, text);
      print({ id, notify: run.notify === true, ...(text === undefined ? {} : { message: true }) });
      return EXIT.ok;
    }
    case 'wait': {
      const mode = oneOf<WaitMode>(values.mode, 'mode', ['any', 'all'], 'all');
      const waited = await waitForRuns(cockpit, positionals, { mode, until: waitUntil(values), timeoutMs: timeoutMs(values), pollMs: io.pollMs });
      print({ until: waited.until, runs: waited.runs, timedOut: waited.timedOut });
      return waited.exitCode;
    }
    case 'log': {
      const since = nonNegativeInt(values.since, 'since') ?? 0;
      const maxChars = positiveInt(values['max-chars'], 'max-chars', 1_000_000) ?? 8_000;
      // An unknown run is the history route's 404, passed through. Without --follow the replay
      // ends at its boundary; the deadline is only a backstop there.
      return readLog(cockpit, id, {
        afterSeq: since, maxChars, follow: values.follow === true,
        deadline: Date.now() + (values.follow ? timeoutMs(values) : 45_000),
        print: (line) => io.stdout(line),
      });
    }
    case 'status': {
      const run = await getRun(cockpit, id);
      if (values.full) { print(run); return EXIT.ok; }
      const question = run.hasPendingHumanAsk ? await pendingQuestion(cockpit, id) : undefined;
      print({ ...projectStatus(run, threadUrl(cockpit, id), question), handoffUrl: handoffUrl(cockpit, id) });
      return EXIT.ok;
    }
    case 'list': {
      const wanted = statuses(values.status);
      const limit = positiveInt(values.limit, 'limit', 1_000) ?? 20;
      const listed = <T extends RunSummary | ApiRun>(runs: T[]): T[] => runs
        .filter((run) => workerParent(run) === undefined)
        .filter((run) => values.all || !run.archived)
        .filter((run) => !wanted || wanted.has(run.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const runs = values.full ? listed(await listRuns(cockpit)) : listed(await requestRunSummaries(cockpit));
      print({ runs: runs.slice(0, limit).map((run) => (values.full ? run : projectListRow(run))), total: runs.length });
      return EXIT.ok;
    }
    case 'stop': {
      const result = await request(cockpit, `${path}/cancel`, { body: {} });
      const answer = cancelResponseSchema.safeParse(result.data);
      if (result.status !== 200) refuse(result);
      if (!answer.success) invalidResponse('cancel');
      print({ id, cancelled: answer.data.cancelled });
      return EXIT.ok;
    }
    case 'finish': {
      const result = await request(cockpit, `${path}/finish`, { body: {} });
      if (result.status !== 200) refuse(result);
      if (!finishResponseSchema.safeParse(result.data).success) invalidResponse('finish');
      print({ id, finished: true });
      return EXIT.ok;
    }
    case 'archive':
    case 'unarchive': {
      const archived = name === 'archive';
      const result = await request(cockpit, `${path}/archive`, { body: { archived } });
      if (result.status !== 200) refuse(result);
      const run = runRecordSchema.safeParse(result.data);
      if (!run.success) invalidResponse('archive');
      print({ id: run.data.id, archived: run.data.archived === true });
      return EXIT.ok;
    }
    case 'archive-finished': {
      const result = await request(cockpit, '/runs/archive-finished', { method: 'POST' });
      if (result.status !== 200) refuse(result);
      const answer = archiveFinishedResponseSchema.safeParse(result.data);
      if (!answer.success) invalidResponse('archive-finished');
      print(answer.data);
      return EXIT.ok;
    }
    case 'diff': {
      if (values.stat) {
        const result = await request(cockpit, `${path}/changes`);
        if (result.status !== 200) refuse(result);
        const changes = changesPayloadSchema.safeParse(result.data);
        if (!changes.success) invalidResponse('changes');
        print({ id, stat: changes.data.stat, files: changes.data.files.map((file) => ({ path: file.path, status: file.status, adds: file.adds, dels: file.dels })) });
        return EXIT.ok;
      }
      const result = await request(cockpit, `${path}/diff`);
      if (result.status !== 200) refuse(result);
      print({ id, diff: typeof result.data === 'string' ? result.data : invalidResponse('diff') });
      return EXIT.ok;
    }
    case 'open': {
      const run = await getRun(cockpit, id);
      const url = threadUrl(cockpit, run.id);
      if (!values['no-open']) (io.open ?? openUrl)(url);
      print({ id: run.id, url, opened: !values['no-open'] });
      return EXIT.ok;
    }
    default:
      return usageError(`unknown operation '${name}'`);
  }
}

export async function runTaskCommand(argv: string[], env: NodeJS.ProcessEnv, io: TaskIo = { stdout: (line) => console.log(line) }): Promise<number> {
  const print: Printer = (value) => io.stdout(JSON.stringify(value));
  try {
    if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) {
      io.stdout(taskHelp());
      return EXIT.ok;
    }
    const { name, values, positionals } = parseOperation(argv);
    if (values.help) {
      io.stdout(taskHelp(name));
      return EXIT.ok;
    }
    // Input is judged before any cockpit is looked for: a usage error is exit 64 whether or not
    // a cockpit is running, and stdin is read once, here.
    const text = name === 'start'
      ? await textArgument(io, 'start', positionals[0], values['task-file'] as string | undefined, 'task')
      : name === 'send'
        ? await textArgument(io, 'send', positionals[1], values['text-file'] as string | undefined, 'text')
        : name === 'notify' && (values.message !== undefined || values['message-file'] !== undefined)
          ? await textArgument(io, 'notify', values.message as string | undefined, values['message-file'] as string | undefined, 'note')
          : undefined;
    validateFlags(name, values);
    const cockpit = await (io.discover ?? discoverCockpit)({
      url: (values.url as string | undefined) ?? (env.CEZ_URL?.trim() || undefined),
      repoDir: resolve((values.repo as string | undefined) ?? process.cwd()),
    });
    return await execute(name, cockpit, io, values, positionals, text, print);
  } catch (error) {
    if (error instanceof TaskCliError) {
      print(error.body);
      return error.exitCode;
    }
    print({ code: 'internal', error: error instanceof Error ? error.message : String(error) });
    return EXIT.refused;
  }
}
