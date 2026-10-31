import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  ONCE_MAX_LATEST_START_MINUTES,
  ONCE_MIN_LATEST_START_MINUTES,
  SCHEDULE_TYPES,
  onceInstant,
  onceWallParts,
  parseCron,
  scheduleLabel,
  type AutomationSchedule,
} from '@open-mercato/cezar-contract/automation-schedule';
import { parseDurationMinutes, resolveDelay, SCHEDULED_TASK_NOTE } from '@open-mercato/cezar-contract/scheduled-tasks';
import { isValidTimeZone } from '@open-mercato/cezar-contract/zoned-time';
import type { AutomationEvent, CreateAutomationInput } from '@open-mercato/cezar-contract';
import { EXIT } from '../task-cli/cli.ts';
import { resolveCockpit, type DiscoverOptions } from '../task-cli/discovery.ts';
import { fetchJson, refuse, TaskCliError, type Cockpit, type HttpResult } from '../task-cli/http.ts';
import { AUTOMATION_SCHEMA_REFERENCE } from './prompts.ts';

/**
 * JSON automation client over the cockpit’s shared service. Use supplied task address/project
 * identity; probe only for explicit human address options. An unavailable cockpit is an error,
 * never a reason to create a cron fallback.
 */

export interface AutomationIo {
  stdout(line: string): void;
  /** The whole of stdin, for `create`/`update` without `--file`/`--json`. */
  stdin?: () => Promise<string>;
  readFile?: (path: string) => Promise<string>;
  discover?: (options: DiscoverOptions) => Promise<Cockpit>;
  /** The transport; tests stub it where the test app cannot answer (a check needs a GitHub remote). */
  http?: ((url: string, init?: { method?: string; body?: unknown; responseLimitBytes?: number }) => Promise<HttpResult>) | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long `check` polls before exit 3. */
  timeoutMs?: number;
}

const USAGE = `cez automation — create and manage automations (GitHub polls and schedules) on the cockpit running this task.
One JSON object per invocation; exit 0 ok, 1 check failed, 2 refused or no cockpit, 3 check timed out, 64 usage.

  schema                                   print the definition shape, bounds and prompt placeholders
  create [--file <def.json> | --json '<json>'] [--enable]
                                           create from a JSON definition (stdin when neither flag is given);
                                           paused unless --enable
  add --name <name> (--cron "<M H * * *>" | --on <event>[,<event>] [--every <5m|1h>]
                    | --at <YYYY-MM-DDTHH:MM> | --in <30m|6h|7d>) [--tz <zone>] [--latest-start <6h>]
      [--prompt <text> | --prompt-file <path>] [--workflow <w>] [--runner <id>] [--model <m>]
      [--autonomous | --no-autonomous] [--label <l>]... [--author <a>]... [--changed-label <l>]... [--include-existing] [--enable]
      [--archive-when-done] [--auto-merge-pr]
                                           the same from flags. --cron takes "M H * * *" (daily), "M H * * 1-5"
                                           (weekdays), "M H * * D" (0 or 7 = Sunday) or "0 */N * * *"
                                           (N in 1,2,3,4,6,8,12); anything else needs the JSON form.
                                           --at or --in runs once: --at is a local wall time in --tz (an IANA
                                           name; the cockpit's zone when left out), --in is elapsed time from
                                           now. --latest-start (10m to 30d) bounds how late a start may still
                                           launch after Cezarion was down
                                           --archive-when-done archives each task after Done (default off).
                                           --auto-merge-pr merges its PR after Done when current-head CI and
                                           GitHub rules pass (default off); it may mark a draft ready.
                                           With both flags, merge before archive; without a PR, archive on Done.
  update <id> [--file <def.json> | --json '<json>']
                                           replace the editable keys you give; the rest keep their value;
                                           "task" merges key by key, and null removes a task key
  check <id> [--execute]                   GitHub poll: preview its matches (launches nothing), or --execute
  run <id>                                 schedule: launch it once now (a one-time schedule is then archived)
  cancel <id>                              one-time schedule: archive it without a task
  list [--archived include|only] | show <id> | enable <id> | pause <id> | delete <id>

Address: CEZ_COCKPIT_URL + CEZ_PROJECT_ID (set inside a task). --url <origin>, --repo <dir> or CEZ_URL look
for a cockpit instead.`;

const NO_COCKPIT = 'no cockpit address — this command works inside a task run by a cockpit with automations on; stop and report that automations are unavailable';
const CHECK_POLL_MS = 500;
const CHECK_TIMEOUT_MS = 120_000;
/** The startup 503 is retried for up to 30 s: 60 attempts, 500 ms apart. */
const STARTUP_RETRIES = 60;
const STARTUP_RETRY_MS = 500;

/** The keys `PUT /automations/:id` accepts besides `enabled` and `expectedRevision`. */
const EDITABLE_KEYS = ['name', 'description', 'kind', 'events', 'intervalSeconds', 'filters', 'schedule', 'task'] as const;

const ADDRESS_FLAGS = { url: { type: 'string' }, repo: { type: 'string' } } as const;
const DEFINITION_FLAGS = { file: { type: 'string' }, json: { type: 'string' } } as const;
const ADD_FLAGS = {
  name: { type: 'string' }, cron: { type: 'string' }, on: { type: 'string' }, every: { type: 'string' },
  prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
  workflow: { type: 'string' }, runner: { type: 'string' }, model: { type: 'string' },
  autonomous: { type: 'boolean' }, 'no-autonomous': { type: 'boolean' },
  'archive-when-done': { type: 'boolean' }, 'auto-merge-pr': { type: 'boolean' },
  label: { type: 'string', multiple: true }, author: { type: 'string', multiple: true },
  'changed-label': { type: 'string', multiple: true },
  'include-existing': { type: 'boolean' },
  enable: { type: 'boolean' },
  at: { type: 'string' }, in: { type: 'string' }, tz: { type: 'string' }, 'latest-start': { type: 'string' },
} as const;

/** Positional count and flags per command; `schema` is handled before any of this. */
const COMMANDS = {
  create: { positionals: 0, options: { ...DEFINITION_FLAGS, enable: { type: 'boolean' } } },
  add: { positionals: 0, options: ADD_FLAGS },
  update: { positionals: 1, options: DEFINITION_FLAGS },
  check: { positionals: 1, options: { execute: { type: 'boolean' } } },
  run: { positionals: 1, options: {} },
  list: { positionals: 0, options: { archived: { type: 'string' } } },
  show: { positionals: 1, options: {} },
  enable: { positionals: 1, options: {} },
  pause: { positionals: 1, options: {} },
  delete: { positionals: 1, options: {} },
  cancel: { positionals: 1, options: {} },
} as const;
type Command = keyof typeof COMMANDS;

function usageError(error: string): never {
  throw new TaskCliError(EXIT.usage, { code: 'invalid_input', error });
}

export function automationPageUrl(cockpit: Cockpit, id: string): string {
  return `${cockpit.origin}/p/${encodeURIComponent(cockpit.projectId)}/automations/${encodeURIComponent(id)}`;
}

/** `5m`, `1h`, `300s` or a bare number of seconds. */
export function parseEvery(value: string): number {
  const match = /^(\d+)\s*([smh]?)$/.exec(value.trim());
  if (!match) usageError(`--every wants a duration like 5m, 1h or 300s, not "${value}"`);
  const n = Number(match[1]);
  const unit = match[2] || 's';
  return unit === 'h' ? n * 3_600 : unit === 'm' ? n * 60 : n;
}

export interface AddFlags {
  name?: string; cron?: string; on?: string; every?: string;
  workflow?: string; runner?: string; model?: string; autonomous?: boolean; 'no-autonomous'?: boolean;
  'archive-when-done'?: boolean; 'auto-merge-pr'?: boolean;
  label?: string[]; author?: string[]; 'changed-label'?: string[]; 'include-existing'?: boolean; enable?: boolean;
  at?: string; in?: string; tz?: string; 'latest-start'?: string;
}

/** A duration flag in minutes; anything else is exit 64. */
function durationFlag(flag: string, value: string): number {
  try { return parseDurationMinutes(value); } catch { usageError(`${flag} wants a duration like 30m, 6h or 7d, not "${value}"`); }
}

/** The one-time schedule `--at`/`--in` stand for, in `timeZone`; every rule it breaks is exit 64. */
function onceFromFlags(values: AddFlags, timeZone: string, now: number): AutomationSchedule {
  if (values.at !== undefined && values.in !== undefined) usageError('give --at (a wall time) OR --in (a delay), not both');
  if (values.cron || values.on) usageError('give --at or --in (a one-time schedule) OR --cron OR --on, not two of them');
  if (values['include-existing']) usageError('--include-existing applies only to a GitHub poll');
  if (!isValidTimeZone(timeZone)) usageError(`unknown time zone "${timeZone}"; use an IANA name such as Europe/Warsaw`);
  if (values.at !== undefined && !onceWallParts(values.at)) usageError(`--at wants a local wall time YYYY-MM-DDTHH:MM, not "${values.at}"`);
  if (values.in !== undefined) durationFlag('--in', values.in);
  const at = values.at ?? resolveDelay(values.in!, now, timeZone);
  const schedule: AutomationSchedule = { type: 'once', at, timeZone };
  if (values['latest-start'] !== undefined) {
    const minutes = durationFlag('--latest-start', values['latest-start']);
    if (minutes < ONCE_MIN_LATEST_START_MINUTES || minutes > ONCE_MAX_LATEST_START_MINUTES) {
      usageError(`--latest-start must be between ${ONCE_MIN_LATEST_START_MINUTES} minutes and ${ONCE_MAX_LATEST_START_MINUTES / 1_440} days`);
    }
    schedule.latestStartMinutes = minutes;
  }
  return schedule;
}

/**
 * The `add` flags as the `create` body they stand for. Anything they cannot say is exit 64.
 * `timeZone` is the zone `--at`/`--in` resolve in when `--tz` is absent (the cockpit's own).
 */
export function bodyFromAddFlags(values: AddFlags, prompt: string, once: { timeZone?: string; now?: number } = {}): CreateAutomationInput {
  if (!values.name?.trim()) usageError('--name is required');
  if (!prompt.trim()) usageError('--prompt (or --prompt-file) is required');
  const isOnce = values.at !== undefined || values.in !== undefined;
  if (!isOnce && (values.tz !== undefined || values['latest-start'] !== undefined)) usageError('--tz and --latest-start apply only to a one-time schedule (--at or --in)');
  if (values.cron && values.on) usageError('give --cron (a schedule) OR --on (a GitHub poll), not both');
  if (values.cron && values['include-existing']) usageError('--include-existing applies only to a GitHub poll');
  if (!isOnce && !values.cron && !values.on) usageError('give --cron "<M H * * *>" for a schedule, --at or --in for a one-time schedule, or --on <event> for a GitHub poll');
  if (values.autonomous && values['no-autonomous']) usageError('give --autonomous OR --no-autonomous, not both');
  const task: CreateAutomationInput['task'] = { prompt, worktree: true, autonomous: !values['no-autonomous'] };
  if (values['archive-when-done']) task.archiveWhenDone = true;
  if (values['auto-merge-pr']) task.autoMergePr = true;
  if (values.workflow) task.workflow = values.workflow;
  if (values.runner) task.runner = values.runner as CreateAutomationInput['task']['runner'];
  if (values.model) task.model = values.model;
  let body: CreateAutomationInput;
  if (isOnce) {
    const schedule = onceFromFlags(values, values.tz ?? once.timeZone ?? 'UTC', once.now ?? Date.now());
    body = { name: values.name.trim(), kind: 'schedule', schedule, task };
  } else if (values.cron) {
    const schedule: AutomationSchedule | null = parseCron(values.cron);
    if (!schedule) {
      usageError(`--cron "${values.cron}" is not one of the shapes a schedule can take (${SCHEDULE_TYPES.join(', ')}): "M H * * *", "M H * * 1-5", "M H * * D" (0 or 7 = Sunday) or "0 */N * * *" (N in 1,2,3,4,6,8,12). For anything else use the JSON form: create --json with a definition shaped as the schema command prints`);
    }
    body = { name: values.name.trim(), kind: 'schedule', schedule, task };
  } else {
    const filters: NonNullable<CreateAutomationInput['filters']> = { lookbackDays: 7, maxRecords: 25 };
    if (values['include-existing']) filters.includeExisting = true;
    if (values.label?.length) filters.anyLabels = values.label;
    if (values.author?.length) filters.authors = values.author;
    if (values['changed-label']?.length) filters.changedLabels = values['changed-label'];
    const events = values.on!.split(',').map((event) => event.trim()).filter(Boolean) as AutomationEvent[];
    if (!filters.changedLabels && events.some((event) => event === 'issue.labeled' || event === 'issue.unlabeled')) {
      usageError('--on issue.labeled and issue.unlabeled need --changed-label <label>: the label whose change fires it');
    }
    body = {
      name: values.name.trim(),
      kind: 'github',
      events,
      intervalSeconds: values.every ? parseEvery(values.every) : 300,
      filters,
      task,
    };
  }
  if (values.enable) body.enable = true;
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readText(io: AutomationIo, path: string): Promise<string> {
  try {
    return await (io.readFile ?? ((file) => readFile(file, 'utf8')))(path);
  } catch (error) {
    usageError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readDefinition(values: { file?: string; json?: string }, io: AutomationIo): Promise<Record<string, unknown>> {
  if (values.file !== undefined && values.json !== undefined) usageError('give the definition as --file OR --json, not both');
  const raw = values.file !== undefined ? await readText(io, values.file) : values.json ?? (await io.stdin?.()) ?? '';
  if (!raw.trim()) usageError('no definition given: pass --file <def.json>, --json \'<json>\', or the JSON on stdin');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    usageError(`the definition is not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) usageError('the definition must be a JSON object (see the schema command)');
  return parsed;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

interface Parsed { command: Command; id: string; values: Record<string, unknown> }

function parse(argv: string[]): Parsed {
  const [name, ...rest] = argv;
  if (name === undefined) usageError('missing command (schema, create, add, update, check, run, cancel, list, show, enable, pause, delete)');
  if (!Object.hasOwn(COMMANDS, name)) usageError(`unknown command "${name}"`);
  const command = name as Command;
  const spec = COMMANDS[command];
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { ...ADDRESS_FLAGS, ...spec.options } }));
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length !== spec.positionals) {
    usageError(spec.positionals ? `${command} takes an automation id` : `${command} takes no positional arguments`);
  }
  if (values.archived !== undefined && values.archived !== 'include' && values.archived !== 'only') usageError('--archived takes include or only');
  return { command, id: positionals[0] ?? '', values };
}

export async function runAutomationCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: AutomationIo = { stdout: (line) => console.log(line), stdin: readStdin },
): Promise<number> {
  const print = (value: unknown) => io.stdout(JSON.stringify(value));
  try {
    if (argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
      io.stdout(USAGE);
      return EXIT.ok;
    }
    // The reference needs no server: an agent reads it before it has anything to send.
    if (argv[0] === 'schema') {
      io.stdout(AUTOMATION_SCHEMA_REFERENCE);
      return EXIT.ok;
    }
    // Input is judged before any cockpit is looked for: a usage error is 64 with or without one.
    const { command, id, values } = parse(argv);
    let body: Record<string, unknown> | undefined;
    if (command === 'add') {
      const flags = values as AddFlags & { prompt?: string; 'prompt-file'?: string };
      if (flags.prompt !== undefined && flags['prompt-file'] !== undefined) usageError('give the prompt as --prompt OR --prompt-file, not both');
      const prompt = flags['prompt-file'] !== undefined ? await readText(io, flags['prompt-file']) : (flags.prompt ?? '');
      const now = (io.now ?? Date.now)();
      body = bodyFromAddFlags(flags, prompt, { now }) as Record<string, unknown>;
      // A one-time schedule without --tz resolves in the cockpit's zone, which only the cockpit knows.
      if ((flags.at !== undefined || flags.in !== undefined) && flags.tz === undefined) {
        const cockpit = await resolveCockpit(env, values as { url?: string; repo?: string }, io.discover, NO_COCKPIT, { removeDiscoveryHint: true });
        const timeZone = await cockpitTimeZone(cockpit, io);
        body = bodyFromAddFlags(flags, prompt, { timeZone, now }) as Record<string, unknown>;
        return await execute(command, id, values, body, cockpit, io, print);
      }
    } else if (command === 'create' || command === 'update') {
      body = await readDefinition(values as { file?: string; json?: string }, io);
    }
    const cockpit = await resolveCockpit(env, values as { url?: string; repo?: string }, io.discover, NO_COCKPIT, { removeDiscoveryHint: true });
    return await execute(command, id, values, body, cockpit, io, print);
  } catch (error) {
    if (error instanceof TaskCliError) {
      print(error.body);
      return error.exitCode;
    }
    print({ code: 'internal', error: error instanceof Error ? error.message : String(error) });
    return EXIT.refused;
  }
}

type SendInit = { method?: string; body?: unknown; responseLimitBytes?: number };

/** Every request goes through this, so no command can miss the startup retry. */
function startupAwareSend(io: AutomationIo): (url: string, init?: SendInit) => Promise<HttpResult> {
  const http = io.http ?? fetchJson;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  return async (url, init) => {
    // `serve` holds its port with a placeholder listener that answers a plain-text 503 until
    // `startServer` takes over, and recovery resumes runs inside that window (review of #1018).
    // That 503 never reached the API, so even a POST is safe to resend; a JSON 503 is the API's.
    let result = await http(url, init);
    for (let attempt = 1; attempt < STARTUP_RETRIES && result.status === 503 && typeof result.data === 'string'; attempt += 1) {
      await sleep(STARTUP_RETRY_MS);
      result = await http(url, init);
    }
    return result;
  };
}

/** The zone the cockpit runs its schedules in, read from the list it answers. */
async function cockpitTimeZone(cockpit: Cockpit, io: AutomationIo): Promise<string> {
  const result = await startupAwareSend(io)(`${cockpit.api}/automations`, { responseLimitBytes: Infinity });
  if (result.status !== 200) refuse(result);
  const zone = (result.data as { timeZone?: unknown }).timeZone;
  return typeof zone === 'string' ? zone : 'UTC';
}

type Definition = { id: string; name: string; enabled: boolean; revision: number; kind?: string; schedule?: AutomationSchedule } & Record<string, unknown>;

/** A one-time schedule's due moment and zone, as `show` and `list` report it; nothing for any other. */
function onceFields(schedule: AutomationSchedule | undefined): { dueAt: string; timeZone: string } | Record<string, never> {
  if (schedule?.type !== 'once') return {};
  const instant = onceInstant(schedule);
  return instant === null ? {} : { dueAt: new Date(instant).toISOString(), timeZone: schedule.timeZone ?? '' };
}

async function execute(
  command: Command,
  id: string,
  values: Record<string, unknown>,
  body: Record<string, unknown> | undefined,
  cockpit: Cockpit,
  io: AutomationIo,
  print: (value: unknown) => void,
): Promise<number> {
  const path = (suffix = '') => `${cockpit.api}/automations${id ? `/${encodeURIComponent(id)}` : ''}${suffix}`;
  const send = startupAwareSend(io);
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const call = async (url: string, init?: SendInit, ok = 200): Promise<unknown> => {
    const result = await send(url, init);
    if (result.status !== ok) refuse(result);
    return result.data;
  };
  const summary = (automation: Definition, onceStatus?: string) => ({
    id: automation.id,
    name: automation.name,
    kind: automation.kind,
    enabled: automation.enabled,
    revision: automation.revision,
    ...(automation.kind === 'schedule' && automation.schedule ? { schedule: scheduleLabel(automation.schedule) } : {}),
    ...onceFields(automation.schedule),
    ...(onceStatus ? { onceStatus } : {}),
    ...(automation.archived ? { archived: automation.archived } : {}),
    url: automationPageUrl(cockpit, automation.id),
  });
  /** The stored status of a one-time schedule, which only `show` answers. */
  const statusOf = async (automation: Definition) => automation.schedule?.type === 'once'
    ? ((await call(`${cockpit.api}/automations/${encodeURIComponent(automation.id)}`)) as { onceStatus?: string }).onceStatus
    : undefined;

  switch (command) {
    case 'create':
    case 'add': {
      // `enabled` is not a POST key: a definition is created paused, and `enable: true` asks the
      // route to enable it from a current-time baseline. A definition copied from `show` carries
      // `enabled`, which the route would refuse, so it is lifted into `enable`.
      const { enabled, ...definition } = body!;
      const enable = values.enable === true || enabled === true;
      // The schema reference documents a poll's `intervalSeconds` (300) and `filters` ({}) as
      // defaults; the route requires both, so the CLI materializes what the reference promised.
      const defaults = definition.kind === 'schedule' ? {} : { intervalSeconds: 300, filters: {} };
      const sent = { ...defaults, ...definition, ...(enable ? { enable: true } : {}) };
      const { automation } = await call(path(), { method: 'POST', body: sent }, 201) as { automation: Definition };
      const once = automation.schedule?.type === 'once';
      print({ ...summary(automation, await statusOf(automation)), ...(once ? { note: SCHEDULED_TASK_NOTE } : {}) });
      return EXIT.ok;
    }
    case 'update': {
      const { automation: current } = await call(path()) as { automation: Definition };
      const next: Record<string, unknown> = {};
      for (const key of EDITABLE_KEYS) {
        const value = key in body! ? body![key] : current[key];
        if (value !== undefined) next[key] = value;
      }
      // `task` merges key by key, so a prompt-only update keeps the workflow, runner, model and
      // the rest; `null` removes a key. Every other key replaces what is stored.
      if (isRecord(body!.task) && isRecord(current.task)) {
        const task: Record<string, unknown> = { ...current.task, ...body!.task };
        for (const [key, value] of Object.entries(task)) if (value === null) delete task[key];
        next.task = task;
      }
      // A PUT restates `enabled` (an edit may not silently pause a running automation) and echoes
      // the revision it read, so a concurrent cockpit edit is a 409, not a clobber.
      next.enabled = 'enabled' in body! ? body!.enabled : current.enabled;
      next.expectedRevision = current.revision;
      const { automation } = await call(path(), { method: 'PUT', body: next }) as { automation: Definition };
      print(summary(automation, await statusOf(automation)));
      return EXIT.ok;
    }
    case 'run': {
      const { runId } = await call(path('/run'), { method: 'POST' }, 202) as { runId: string };
      print({ id, runId, url: automationPageUrl(cockpit, id) });
      return EXIT.ok;
    }
    case 'check': {
      const mode = values.execute === true ? 'execute' : 'preview';
      const { checkId } = await call(path('/check'), { method: 'POST', body: { mode } }, 202) as { checkId: string };
      const url = automationPageUrl(cockpit, id);
      const now = io.now ?? Date.now;
      const deadline = now() + (io.timeoutMs ?? CHECK_TIMEOUT_MS);
      // The check record is workspace-level, keyed by the unguessable id the project route returned.
      for (;;) {
        const check = await call(`${cockpit.origin}/api/v1/automation-checks/${encodeURIComponent(checkId)}`) as { status: string; matches?: number; truncated?: boolean; error?: string };
        if (check.status === 'complete') {
          print({ id, checkId, mode, status: check.status, matches: check.matches ?? 0, truncated: check.truncated === true, url });
          return EXIT.ok;
        }
        if (check.status === 'error') {
          print({ code: 'failed', id, checkId, mode, error: check.error ?? 'the check failed', url });
          return EXIT.failed;
        }
        if (now() >= deadline) {
          print({ code: 'timeout', id, checkId, mode, error: 'the check did not finish in time; it may still be running — its result shows in the automation log', url });
          return EXIT.timeout;
        }
        await sleep(CHECK_POLL_MS);
      }
    }
    case 'list': {
      // `GET /automations` is unpaginated and carries every full prompt, so it reads like
      // `cez task list` reads `/runs`: no success-size cap, the deadline and error caps kept.
      const archived = typeof values.archived === 'string' ? `?archived=${values.archived}` : '';
      const data = await call(`${path()}${archived}`, { responseLimitBytes: Infinity }) as {
        available: boolean;
        reason?: string;
        automations: Array<Definition & {
          events?: string[]; intervalSeconds?: number; nextRunAt?: string;
          counts: Record<string, number>; state?: { nextCheckAt?: string }; onceStatus?: string;
        }>;
      };
      print({
        available: data.available,
        ...(data.reason ? { reason: data.reason } : {}),
        automations: data.automations.map((item) => {
          const next = item.enabled ? item.nextRunAt ?? item.state?.nextCheckAt : undefined;
          return {
            id: item.id,
            name: item.name,
            enabled: item.enabled,
            kind: item.kind,
            trigger: item.kind === 'schedule' && item.schedule
              ? scheduleLabel(item.schedule)
              : `every ${item.intervalSeconds ?? 300}s on ${(item.events ?? []).join(',')}`,
            counts: item.counts,
            ...(next ? { next } : {}),
            ...onceFields(item.schedule),
            ...(item.onceStatus ? { onceStatus: item.onceStatus } : {}),
            url: automationPageUrl(cockpit, item.id),
          };
        }),
      });
      return EXIT.ok;
    }
    case 'show': {
      const data = await call(path()) as Record<string, unknown> & { automation?: Definition };
      print({ ...data, ...onceFields(data.automation?.schedule), url: automationPageUrl(cockpit, id) });
      return EXIT.ok;
    }
    case 'enable':
    case 'pause':
    case 'cancel': {
      const { automation } = await call(path(`/${command}`), { method: 'POST' }) as { automation: Definition };
      print(summary(automation, await statusOf(automation)));
      return EXIT.ok;
    }
    case 'delete': {
      const result = await send(path(), { method: 'DELETE' });
      if (result.status < 200 || result.status >= 300) refuse(result);
      print({ id, deleted: true });
      return EXIT.ok;
    }
  }
}
