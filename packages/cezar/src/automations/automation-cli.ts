import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  SCHEDULE_TYPES,
  parseCron,
  scheduleLabel,
  type AutomationEvent,
  type AutomationSchedule,
  type CreateAutomationInput,
} from '@open-mercato/cezar-contract';
import { EXIT } from '../task-cli/cli.ts';
import { discoverCockpit, type DiscoverOptions } from '../task-cli/discovery.ts';
import { fetchJson, refuse, TaskCliError, type Cockpit, type HttpResult } from '../task-cli/http.ts';
import { AUTOMATION_SCHEMA_REFERENCE } from './prompts.ts';

/**
 * `cez automation …` (#774, port of upstream #985; design `.ai/specs/2026-10-02-scheduled-automations.md`
 * stage 2) — create and manage automations on the cockpit that runs this task. A thin JSON client
 * over the automations family, on `cez task`'s transport and exit codes (#504): one JSON object
 * per invocation, `schema` excepted.
 *
 * Addressed by `CEZ_COCKPIT_URL` + `CEZ_PROJECT_ID`, which the engine puts in an agent's env while
 * the cockpit listens. Only an explicit `--url`, `--repo` or `CEZ_URL` probes for a cockpit, for a
 * human at a shell. Nothing here starts a server or tells the caller to start one: an agent that
 * cannot reach a cockpit with automations on stops and reports, and never substitutes a cron job.
 */

export interface AutomationIo {
  stdout(line: string): void;
  /** The whole of stdin, for `create`/`update` without `--file`/`--json`. */
  stdin?: () => Promise<string>;
  readFile?: (path: string) => Promise<string>;
  discover?: (options: DiscoverOptions) => Promise<Cockpit>;
  /** The transport; tests stub it where the test app cannot answer (a check needs a GitHub remote). */
  http?: (url: string, init?: { method?: string; body?: unknown; responseLimitBytes?: number }) => Promise<HttpResult>;
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
  add --name <name> (--cron "<M H * * *>" | --on <event>[,<event>] [--every <5m|1h>])
      [--prompt <text> | --prompt-file <path>] [--workflow <w>] [--runner <id>] [--model <m>]
      [--autonomous | --no-autonomous] [--label <l>]... [--author <a>]... [--enable]
                                           the same from flags. --cron takes "M H * * *" (daily), "M H * * 1-5"
                                           (weekdays), "M H * * D" (0 or 7 = Sunday) or "0 */N * * *"
                                           (N in 1,2,3,4,6,8,12); anything else needs the JSON form
  update <id> [--file <def.json> | --json '<json>']
                                           replace the editable keys you give; the rest keep their value;
                                           "task" merges key by key, and null removes a task key
  check <id> [--execute]                   GitHub poll: preview its matches (launches nothing), or --execute
  run <id>                                 schedule: launch it once now
  list | show <id> | enable <id> | pause <id> | delete <id>

Address: CEZ_COCKPIT_URL + CEZ_PROJECT_ID (set inside a task). --url <origin>, --repo <dir> or CEZ_URL look
for a cockpit instead.`;

const NO_COCKPIT = 'no cockpit address — this command works inside a task run by a cockpit with automations on; stop and report that automations are unavailable';
const CHECK_POLL_MS = 500;
const CHECK_TIMEOUT_MS = 120_000;

/** The keys `PUT /automations/:id` accepts besides `enabled` and `expectedRevision`. */
const EDITABLE_KEYS = ['name', 'description', 'kind', 'events', 'intervalSeconds', 'filters', 'schedule', 'task'] as const;

const ADDRESS_FLAGS = { url: { type: 'string' }, repo: { type: 'string' } } as const;
const DEFINITION_FLAGS = { file: { type: 'string' }, json: { type: 'string' } } as const;
const ADD_FLAGS = {
  name: { type: 'string' }, cron: { type: 'string' }, on: { type: 'string' }, every: { type: 'string' },
  prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
  workflow: { type: 'string' }, runner: { type: 'string' }, model: { type: 'string' },
  autonomous: { type: 'boolean' }, 'no-autonomous': { type: 'boolean' },
  label: { type: 'string', multiple: true }, author: { type: 'string', multiple: true },
  enable: { type: 'boolean' },
} as const;

/** Positional count and flags per command; `schema` is handled before any of this. */
const COMMANDS = {
  create: { positionals: 0, options: { ...DEFINITION_FLAGS, enable: { type: 'boolean' } } },
  add: { positionals: 0, options: ADD_FLAGS },
  update: { positionals: 1, options: DEFINITION_FLAGS },
  check: { positionals: 1, options: { execute: { type: 'boolean' } } },
  run: { positionals: 1, options: {} },
  list: { positionals: 0, options: {} },
  show: { positionals: 1, options: {} },
  enable: { positionals: 1, options: {} },
  pause: { positionals: 1, options: {} },
  delete: { positionals: 1, options: {} },
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
  label?: string[]; author?: string[]; enable?: boolean;
}

/** The `add` flags as the `create` body they stand for. Anything they cannot say is exit 64. */
export function bodyFromAddFlags(values: AddFlags, prompt: string): CreateAutomationInput {
  if (!values.name?.trim()) usageError('--name is required');
  if (!prompt.trim()) usageError('--prompt (or --prompt-file) is required');
  if (values.cron && values.on) usageError('give --cron (a schedule) OR --on (a GitHub poll), not both');
  if (!values.cron && !values.on) usageError('give --cron "<M H * * *>" for a schedule or --on <event> for a GitHub poll');
  if (values.autonomous && values['no-autonomous']) usageError('give --autonomous OR --no-autonomous, not both');
  const task: CreateAutomationInput['task'] = { prompt, worktree: true, autonomous: !values['no-autonomous'] };
  if (values.workflow) task.workflow = values.workflow;
  if (values.runner) task.runner = values.runner as CreateAutomationInput['task']['runner'];
  if (values.model) task.model = values.model;
  let body: CreateAutomationInput;
  if (values.cron) {
    const schedule: AutomationSchedule | null = parseCron(values.cron);
    if (!schedule) {
      usageError(`--cron "${values.cron}" is not one of the shapes a schedule can take (${SCHEDULE_TYPES.join(', ')}): "M H * * *", "M H * * 1-5", "M H * * D" (0 or 7 = Sunday) or "0 */N * * *" (N in 1,2,3,4,6,8,12). For anything else use the JSON form: create --json with a definition shaped as the schema command prints`);
    }
    body = { name: values.name.trim(), kind: 'schedule', schedule, task };
  } else {
    const filters: NonNullable<CreateAutomationInput['filters']> = { lookbackDays: 7, maxRecords: 25 };
    if (values.label?.length) filters.anyLabels = values.label;
    if (values.author?.length) filters.authors = values.author;
    body = {
      name: values.name.trim(),
      kind: 'github',
      events: values.on!.split(',').map((event) => event.trim()).filter(Boolean) as AutomationEvent[],
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

/** The env address first; discovery only when the caller named a cockpit or a checkout. */
async function resolveCockpit(env: NodeJS.ProcessEnv, values: { url?: string; repo?: string }, io: AutomationIo): Promise<Cockpit> {
  const address = env.CEZ_COCKPIT_URL?.trim();
  const projectId = env.CEZ_PROJECT_ID?.trim();
  if (address && projectId) {
    let origin: string;
    try { origin = new URL(address).origin; } catch {
      throw new TaskCliError(EXIT.refused, { code: 'no-cockpit', error: `CEZ_COCKPIT_URL is not a URL: ${address}` });
    }
    return { origin, projectId, api: `${origin}/api/v1/p/${encodeURIComponent(projectId)}` };
  }
  const url = values.url ?? (env.CEZ_URL?.trim() || undefined);
  if (url === undefined && values.repo === undefined) throw new TaskCliError(EXIT.refused, { code: 'no-cockpit', error: NO_COCKPIT });
  try {
    return await (io.discover ?? discoverCockpit)({ url, repoDir: resolve(values.repo ?? process.cwd()) });
  } catch (error) {
    // Discovery's hint says to start a cockpit; this command never suggests that.
    if (error instanceof TaskCliError) {
      const { hint: _hint, ...body } = error.body;
      throw new TaskCliError(error.exitCode, body);
    }
    throw error;
  }
}

interface Parsed { command: Command; id: string; values: Record<string, unknown> }

function parse(argv: string[]): Parsed {
  const [name, ...rest] = argv;
  if (name === undefined) usageError('missing command (schema, create, add, update, check, run, list, show, enable, pause, delete)');
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
      body = bodyFromAddFlags(flags, prompt) as Record<string, unknown>;
    } else if (command === 'create' || command === 'update') {
      body = await readDefinition(values as { file?: string; json?: string }, io);
    }
    const cockpit = await resolveCockpit(env, values as { url?: string; repo?: string }, io);
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

type Definition = { id: string; name: string; enabled: boolean; revision: number; kind?: string; schedule?: AutomationSchedule } & Record<string, unknown>;

async function execute(
  command: Command,
  id: string,
  values: Record<string, unknown>,
  body: Record<string, unknown> | undefined,
  cockpit: Cockpit,
  io: AutomationIo,
  print: (value: unknown) => void,
): Promise<number> {
  const http = io.http ?? fetchJson;
  const path = (suffix = '') => `${cockpit.api}/automations${id ? `/${encodeURIComponent(id)}` : ''}${suffix}`;
  const call = async (url: string, init?: { method?: string; body?: unknown; responseLimitBytes?: number }, ok = 200): Promise<unknown> => {
    const result = await http(url, init);
    if (result.status !== ok) refuse(result);
    return result.data;
  };
  const summary = (automation: Definition) => ({
    id: automation.id,
    name: automation.name,
    kind: automation.kind,
    enabled: automation.enabled,
    revision: automation.revision,
    ...(automation.kind === 'schedule' && automation.schedule ? { schedule: scheduleLabel(automation.schedule) } : {}),
    url: automationPageUrl(cockpit, automation.id),
  });

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
      print(summary(automation));
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
      print(summary(automation));
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
      const sleep = io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
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
      const data = await call(path(), { responseLimitBytes: Infinity }) as {
        available: boolean;
        reason?: string;
        automations: Array<Definition & {
          events?: string[]; intervalSeconds?: number; nextRunAt?: string;
          counts: Record<string, number>; state?: { nextCheckAt?: string };
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
            url: automationPageUrl(cockpit, item.id),
          };
        }),
      });
      return EXIT.ok;
    }
    case 'show': {
      const data = await call(path()) as Record<string, unknown>;
      print({ ...data, url: automationPageUrl(cockpit, id) });
      return EXIT.ok;
    }
    case 'enable':
    case 'pause': {
      const { automation } = await call(path(`/${command}`), { method: 'POST' }) as { automation: Definition };
      print(summary(automation));
      return EXIT.ok;
    }
    case 'delete': {
      const result = await http(path(), { method: 'DELETE' });
      if (result.status < 200 || result.status >= 300) refuse(result);
      print({ id, deleted: true });
      return EXIT.ok;
    }
  }
}
