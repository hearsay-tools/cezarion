import { randomUUID } from 'node:crypto';
import { open as openFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  apiRunSchema,
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
} from '@open-mercato/cezar-contract';
import { openUrl } from '../open-url.ts';
import { discoverCockpit, type DiscoverOptions } from './discovery.ts';
import { invalidResponse, refuse, request, TaskCliError, threadUrl, type Cockpit } from './http.ts';
import { projectListRow, projectStatus } from './projections.ts';
import { readLog, waitForRuns, type WaitMode, type WaitUntil } from './watch.ts';

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

const TASK_TEXT_MAX_CHARS = 100_000;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1_800;
const TIMEOUT_FLAG: FlagSpec = { type: 'string', help: `<1-${MAX_TIMEOUT_SECONDS}>  Give up after this many seconds (default ${DEFAULT_TIMEOUT_SECONDS}).` };

export const OPERATIONS: Record<string, Operation> = {
  start: {
    args: "'<task>' | --task-file <path|->",
    description: 'Start a task in the cockpit serving this checkout.',
    positionals: [0, 1],
    flags: {
      'task-file': { type: 'string', help: '<path|->     Read the task from a file, or stdin with -.' },
      'request-id': { type: 'string', help: '<UUID>     Retry-safe id; reuse it when retrying this start.' },
      workflow: { type: 'string', help: '<name>       Workflow (default quick-task).' },
      skill: { type: 'string', help: '<name>          Run one discovered skill instead of a workflow.' },
      backend: { type: 'string', help: '<id>          claude | codex | opencode | pi | cursor.' },
      model: { type: 'string', help: '<model>         Model override.' },
      effort: { type: 'string', help: '<level>       Reasoning effort.' },
      autonomous: { type: 'boolean', help: '         Never park for input; run to completion.' },
      'no-worktree': { type: 'boolean', help: '      Run in the repo working tree, not a worktree.' },
      wait: { type: 'boolean', help: '               Then wait until the task settles (see wait).' },
      'timeout-seconds': TIMEOUT_FLAG,
      notify: { type: 'boolean', help: '             POST status changes to the project webhook (default when it has one).' },
      'no-notify': { type: 'boolean', help: '          Do not notify the project webhook.' },
    },
  },
  list: {
    args: '',
    description: 'List tasks, newest first.',
    positionals: [0, 0],
    flags: {
      status: { type: 'string', help: '<s>[,<s>…]     Only these statuses.' },
      limit: { type: 'string', help: '<n>             At most n rows (default 20).' },
      all: { type: 'boolean', help: '                Include archived tasks.' },
      full: { type: 'boolean', help: '               Print contract ApiRun rows.' },
    },
  },
  status: {
    args: '<id>',
    description: 'Show one task.',
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
    description: 'Block until the tasks settle; exit 0 done/review, 1 failed/cancelled, 3 timeout.',
    positionals: [1, 32],
    flags: {
      mode: { type: 'string', help: '<any|all>        Return on the first task or on all of them (default all).' },
      until: { type: 'string', help: '<settled|attention> Also stop on waiting or a pending question (attention).' },
      'timeout-seconds': TIMEOUT_FLAG,
    },
  },
  send: {
    args: "<id> '<text>' | <id> --text-file <path|->",
    description: 'Steer a task: deliver, queue or (with --resume) reopen.',
    positionals: [1, 2],
    flags: {
      'text-file': { type: 'string', help: '<path|->     Read the text from a file, or stdin with -.' },
      resume: { type: 'boolean', help: '             Reopen a closed session with this text.' },
      notify: { type: 'boolean', help: '             Also turn the project webhook on for this task.' },
    },
  },
  notify: {
    args: "<id> [--message '<note>' | --message-file <path|->]",
    description: 'Hand a task to the project webhook (on), or stop notifying it (--off).',
    positionals: [1, 1],
    flags: {
      off: { type: 'boolean', help: '                Stop notifying the webhook about this task.' },
      message: { type: 'string', help: "'<note>'       Note for the webhook's task.subscribed delivery." },
      'message-file': { type: 'string', help: '<path|->  Read the note from a file, or stdin with -.' },
    },
  },
  stop: { args: '<id>', description: 'Cancel a task.', positionals: [1, 1], flags: {} },
  finish: { args: '<id>', description: 'Close a waiting session as done.', positionals: [1, 1], flags: {} },
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

function usage() {
  return { operations: Object.entries(OPERATIONS).map(([name, op]) => ({ name, synopsis: `cez task ${name} ${op.args}`.trim() })) };
}

function usageError(error: string): never {
  throw new TaskCliError(EXIT.usage, { code: 'invalid_input', error, usage: usage() });
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
    'Commands find the running cockpit that serves this checkout (ports 4321-4370) and print JSON.',
    'notify: with a task webhook set in Settings → General, start notifies it unless --no-notify;',
    'the webhook gets task.status, task.question, task.activity and task.subscribed POSTs.',
    'Exit codes: 0 ok · 1 task failed/cancelled or message not delivered · 2 no cockpit or refused ·',
    '3 timed out · 64 usage error.',
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

function statuses(value: string | boolean | undefined) {
  if (typeof value !== 'string') return undefined;
  const list = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  const invalid = list.find((entry) => !runStatusSchema.safeParse(entry).success);
  if (invalid) usageError(`unknown status '${invalid}'`);
  return new Set(list);
}

/** Every flag check `execute` makes, run up front so a bad flag never waits on discovery. */
function validateFlags(name: string, values: Values): void {
  if (name === 'start') {
    if (values.skill !== undefined && values.workflow !== undefined) usageError('--skill and --workflow cannot be used together');
    if (typeof values.skill === 'string' && !values.skill.trim()) usageError('--skill must name a skill');
    if (values.notify && values['no-notify']) usageError('--notify and --no-notify cannot be used together');
  }
  if (name === 'notify') {
    if (values.message !== undefined && values['message-file'] !== undefined) usageError('notify takes the note as --message or --message-file, not both');
    if (values.off && (values.message !== undefined || values['message-file'] !== undefined)) usageError('--off takes no note');
  }
  if (name === 'list') { statuses(values.status); positiveInt(values.limit, 'limit', 1_000); }
  if (name === 'wait') {
    oneOf<WaitMode>(values.mode, 'mode', ['any', 'all'], 'all');
    oneOf<WaitUntil>(values.until, 'until', ['settled', 'attention'], 'settled');
  }
  if (name === 'log') { nonNegativeInt(values.since, 'since'); positiveInt(values['max-chars'], 'max-chars', 1_000_000); }
  if (name === 'wait' || name === 'log' || (name === 'start' && values.wait)) timeoutMs(values);
}

async function getRun(cockpit: Cockpit, id: string): Promise<ApiRun> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}`);
  if (result.status !== 200) refuse(result);
  const run = apiRunSchema.safeParse(result.data);
  return run.success ? run.data : invalidResponse('run');
}

async function listRuns(cockpit: Cockpit): Promise<ApiRun[]> {
  const result = await request(cockpit, '/runs');
  if (result.status !== 200) refuse(result);
  const runs = apiRunSchema.array().safeParse(result.data);
  return runs.success ? runs.data : invalidResponse('run list');
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
        : { steps: [{ id: 'task', name: skill, skill, prompt: '{{task}}' }] }),
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
  const waited = await waitForRuns(cockpit, [run.data.id], { mode: 'all', until: 'settled', timeoutMs: waitMs, pollMs: io.pollMs });
  const final = waited.runs[0]!;
  print({ ...started, ...final, timedOut: waited.timedOut });
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
      const run = await setNotify(cockpit, id, !values.off, text);
      print({ id, notify: run.notify === true, ...(text === undefined ? {} : { message: true }) });
      return EXIT.ok;
    }
    case 'wait': {
      const mode = oneOf<WaitMode>(values.mode, 'mode', ['any', 'all'], 'all');
      const until = oneOf<WaitUntil>(values.until, 'until', ['settled', 'attention'], 'settled');
      const waited = await waitForRuns(cockpit, positionals, { mode, until, timeoutMs: timeoutMs(values), pollMs: io.pollMs });
      print({ runs: waited.runs, timedOut: waited.timedOut });
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
      print(projectStatus(run, threadUrl(cockpit, id), question));
      return EXIT.ok;
    }
    case 'list': {
      const wanted = statuses(values.status);
      const limit = positiveInt(values.limit, 'limit', 1_000) ?? 20;
      const runs = (await listRuns(cockpit))
        .filter((run) => values.all || !run.archived)
        .filter((run) => !wanted || wanted.has(run.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
