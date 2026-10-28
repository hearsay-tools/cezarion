import { execFileSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readBoundedContextFile } from './context.ts';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  conversationSendRequestSchema,
  conversationSendResultSchema,
  conversationInspectResultSchema,
  conversationInspectRequestSchema,
  conversationCancelRequestSchema,
  inboxReserveResultSchema,
  inboxReceiptResultSchema,
  requestOutcomeSchema,
  requestWaitRequestSchema,
} from '@open-mercato/cezar-contract/conversations';
import {
  workerListPageSchema,
  workerListResultSchema,
  workerCollectedResultSchema,
  workerCancelWaitRequestSchema,
  delegationCancelWaitResultSchema,
  workerOperationSchema,
  workerParamsSchema,
  workerSpawnRequestSchema,
  workerSteerRequestSchema,
  workerWaitRequestSchema,
  workerSpawnResultSchema,
  workerInspectionSchema,
  workerSteerResultSchema,
  workerStopResultSchema,
  workerDestroyResultSchema,
  workerDiffSchema,
  workerWaitResultSchema,
  delegationWaitResultSchema,
  peerWaitRequestSchema,
  delegationErrorResponseSchema,
} from '@open-mercato/cezar-contract/delegation';
import { discoveryRequestSchema, discoveredTasksSchema } from '@open-mercato/cezar-contract/discovery';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { runnerFlag, skillFlagIssue } from '../workflows/types.ts';
import { DelegationPolicyError } from './policy.ts';

/** Accept exactly the endpoint format minted by this installation's private listener. */
export function delegationEndpoint(value: string | undefined): URL {
  if (!value) throw new Error('Delegation endpoint absent');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1 ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1/delegation') throw new Error('Invalid delegation endpoint');
  return url;
}

const conversationOperationSchema = z.enum(['list', 'send', 'progress', 'follow-up', 'reply', 'conversation', 'inbox', 'cancel-request', 'wait-requests']);
const responseSchemas = { tasks: discoveredTasksSchema, list: workerListResultSchema, send: conversationSendResultSchema, progress: conversationSendResultSchema, 'follow-up': conversationSendResultSchema, reply: conversationSendResultSchema, conversation: conversationInspectResultSchema, 'cancel-request': requestOutcomeSchema, 'wait-requests': workerWaitResultSchema, collect: workerCollectedResultSchema, spawn: workerSpawnResultSchema, inspect: workerInspectionSchema, steer: workerSteerResultSchema,
  stop: workerStopResultSchema, destroy: workerDestroyResultSchema, diff: workerDiffSchema, wait: delegationWaitResultSchema, 'cancel-wait': delegationCancelWaitResultSchema };
const RESPONSE_BYTES = 3_145_728;
const CLI_FLAG: Record<string, string> = {
  requestId: '--request-id', baseline: '--baseline', backend: '--runner', model: '--model', effort: '--effort', workflow: '--workflow', skill: '--skill',
  timeoutSeconds: '--timeout-seconds', mode: '--mode', kind: '--kind', id: '--id', context: '--context',
  requestIds: '--request', peerIds: '--peer', workerIds: 'worker-id', workerId: 'worker-id', waitId: 'wait-id', recipientRunId: 'recipient-run-id',
  task: 'task', text: 'text',
};
/** Generic zod message for a refine that sets none; any other message is the schema's own words. */
const ZOD_DEFAULT_MESSAGE = 'Invalid input';
/**
 * `--attach` rides in `context.artifacts`, so a schema issue under it is an `--attach` failure. The
 * schema's own custom messages (duplicate, .gitignore) already name the path; any other issue names
 * the value as typed, found by the artifact index (the CLI sends one `parent-file` per `--attach`).
 */
function attachIssue(error: z.ZodError, operation: string, typed: string[]): string | undefined {
  const first = error.issues[0];
  if (first?.path[0] !== 'context' || first.path[1] !== 'artifacts') return undefined;
  if (first.code === 'custom' && first.message !== ZOD_DEFAULT_MESSAGE) return first.message;
  const value = typeof first.path[2] === 'number' ? typed[first.path[2]] : undefined;
  return value === undefined ? `${operation} has invalid --attach` : `${operation} has invalid --attach: ${value}`;
}
const WORKER_USAGE = { operations: [
  { name: 'resume', positionals: 2, required: ['--id'], optional: ['--timeout-seconds'] },
  { name: 'spawn', positionals: 1, required: ['--baseline', '--request-id'], optional: ['--workflow', '--skill', '--runner', '--backend', '--model', '--effort', '--context', '--context-file', '--attach'] },
  { name: 'list', positionals: 0 },
  { name: 'inspect', positionals: 1 },
  { name: 'steer', positionals: 2 },
  { name: 'stop', positionals: 1 },
  { name: 'destroy', positionals: 1 },
  { name: 'diff', positionals: 1 },
  { name: 'collect', positionals: 1 },
  { name: 'wait', positionals: 1, optional: ['--mode', '--timeout-seconds'] },
  { name: 'wait', positionals: 0, required: ['--request'], optional: ['--mode', '--timeout-seconds'] },
  { name: 'cancel-wait', positionals: 1 },

] };
const WORKER_HELP: Record<string, { args: string; description: string }> = {
  resume: { args: '<worker-id> \"<instruction>\" --id <UUID>', description: 'Resume a settled owned worker with a request; --timeout-seconds accepts 1-86400.' },
  spawn: { args: '"<task>" --baseline <ref> --request-id <UUID>', description: 'Create an owned worker from a committed baseline.' },
  list: { args: '', description: 'List your owned workers, execution revisions and remaining cleanup resources.' },
  inspect: { args: '<worker-id>', description: 'Show worker state and input locations.' },
  steer: { args: '<worker-id> "<text>"', description: 'Send instructions to a running worker.' },
  stop: { args: '<worker-id>', description: 'Stop a worker.' },
  destroy: { args: '<worker-id>', description: 'Remove owned worker resources after collecting results.' },
  diff: { args: '<worker-id>', description: 'Show the bounded worker diff.' },
  collect: { args: '<worker-id>', description: 'Collect the latest worker results; does not merge changes.' },
  wait: { args: '<worker-id>...', description: 'Register a wait for owned workers, then end your turn. Several waits can be open at once (workers, CI, timers); messages wake you and close no wait.' },
  'cancel-wait': { args: '<wait-id>', description: 'Stops one wait by its id; never cancels requests or workers, and your other waits stay open.' },

};
const WORKER_FLAG_HELP: Record<string, string> = {
  '--baseline': '<ref>                 Committed ref or parent-head; excludes dirty edits.',
  '--request-id': '<UUID>              Spawn retry ID, or request being followed up/replied to.',
  '--runner': `<name>                  ${RUNNER_IDS.join(' | ')}.`,
  '--backend': '<name>                 Alias of --runner.',
  '--model': '<model>                  Model override.',
  '--effort': '<level>                 low | medium | high | xhigh | max | auto.',
  '--workflow': '<name>                Catalog workflow to run (built-in quick-task or .ai/cezar/workflows); default quick-task.',
  '--skill': '<name>                   Run one discovered skill as the worker task; not with --workflow.',
  '--context': '<text>                 Selected context; mutually exclusive with --context-file.',
  '--context-file': '<path>            UTF-8 context file; mutually exclusive with --context.',
  '--attach': '<path>                  Copy a git-ignored file from your worktree into the worker worktree at the same path; repeatable.',
  '--mode': '<one|any|all>             Wait mode (default any); one requires one target.',
  '--timeout-seconds': '<1-1800>       Wait or request deadline (default 600 seconds); --resume requests accept 1-86400.',
  '--request': '<UUID>                 Request to wait for; repeat for multiple requests.',
  '--id': '<UUID>                      Message ID; reuse only for an exact retry.',
  '--kind': '<request|progress>        Whether the message requires an explicit reply.',
  '--resume': '                         Resume an owned finished worker; request deadline defaults to 600 s, --timeout-seconds accepts up to 86400 s.',
};
function workerHelp(operation?: string): string {
  const operations = WORKER_USAGE.operations.filter(entry => !REMOVED_WORKER_VERBS[entry.name] && !(entry.name === 'wait' && entry.positionals === 0) && (operation === undefined || entry.name === operation));
  const names = [...new Set(operations.map(entry => entry.name))];
  const flags = [...new Set(operations.flatMap(entry => [...(entry.required ?? []), ...(entry.optional ?? [])]))];
  return [
    'cezar worker — manage owned coding workers', '', 'Usage:',
    ...names.flatMap(name => {
      const help = WORKER_HELP[name]!;
      return [`  cez worker ${name} ${help.args}`, `    ${help.description}`];
    }), '', 'Options:',
    ...flags.map(flag => `  ${flag} ${WORKER_FLAG_HELP[flag]}`),
    '  -h, --help                       Show help without a delegation session.', '',
    'Required flags are shown in each synopsis. Other flags are optional.',
    'Use cez worker <operation> --help for operation help.',
    'Commands require an active cezar delegation session and return JSON.',
    'Explicit help prints text and exits successfully; invalid commands return JSON errors.',
  ].join('\n');
}
class WorkerCliError extends Error {}
/**
 * Resolve each `--attach` value against the caller's directory into a path relative to its worktree
 * root, which is what the server resolves against. Existence, file type and symlinks are checked here
 * so a typo fails before any request; whether git ignores the path is the server's call (hearsay-tools/cezarion#1149).
 */
async function attachPaths(values: string[]): Promise<string[]> {
  if (values.length === 0) return [];
  const cwd = process.cwd();
  let top: string;
  try { top = await realpath(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
  catch { throw new WorkerCliError('spawn --attach needs a git worktree; run it from your worktree'); }
  const root = await realpath(cwd);
  const paths: string[] = [];
  for (const value of values) {
    const abs = resolve(root, value);
    const info = await lstat(abs).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new WorkerCliError(`spawn --attach path not found: ${value}`);
      throw new WorkerCliError(`spawn --attach path cannot be read: ${value}`);
    });
    if (!info.isFile()) throw new WorkerCliError(`spawn --attach path is not a regular file: ${value}`);
    const rel = relative(top, abs);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new WorkerCliError(`spawn --attach path is outside your worktree: ${value}`);
    paths.push(rel.split(sep).join('/'));
  }
  return paths;
}
class InboxHttpError extends Error { constructor(readonly status: number) { super('Inbox operation failed'); } }
function cliName(path: PropertyKey[], argv: string[]): string {
  // `backend` takes `--runner` or its alias `--backend`; name the spelling the caller typed (#632).
  if (path[0] === 'backend' && !argv.some(arg => arg === '--runner' || arg.startsWith('--runner='))) return '--backend';
  return CLI_FLAG[String(path[0] ?? '')] ?? String(path[0] ?? 'argument');
}
function expectCount(operation: string, positionals: string[], count: number): void {
  if (positionals.length === count) return;
  throw new WorkerCliError(positionals.length > count ? `${operation} has extra argument` : `${operation} is missing a positional`);
}
function formatWorkerCliError(error: unknown, argv: string[]): string {
  const argv0 = argv[0];
  if (error instanceof WorkerCliError) return error.message;
  if (error instanceof z.ZodError) {
    const operationUnknown = error.issues.every(issue => issue.path.length === 0)
      && error.issues.some(issue => issue.code === 'invalid_union' || issue.code === 'invalid_value');
    if (operationUnknown) return `unknown operation '${argv0 ?? ''}'`;
    const operation = argv0 ?? 'worker';
    const missing = error.issues.filter(issue => issue.code === 'invalid_type' && issue.message.includes('undefined'));
    if (missing.length) return `${operation} is missing ${missing.map(issue => cliName(issue.path, argv)).join(' and ')}`;
    const first = error.issues[0];
    return first ? `${operation} has invalid ${cliName(first.path, argv)}` : 'Invalid worker command arguments';
  }
  if (error instanceof Error && 'code' in error && error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const unknown = error.message.match(/Unknown option ['"]([^'"]+)['"]/);
    return `${argv0 ?? 'worker'} has extra argument ${unknown?.[1] ?? 'flag'}`;
  }
  return 'Invalid worker command arguments';
}
export async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > RESPONSE_BYTES) { await response.body?.cancel(); throw Error('Response too large'); }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty response');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > RESPONSE_BYTES) { await reader.cancel(); throw Error('Response too large'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

/** A failed Writable emits `error` as well as reporting through its callback. */
async function writeInboxOutput(text: string): Promise<void> {
  const stream = process.stdout;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let callbackFailure: NodeJS.Immediate | undefined;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearImmediate(callbackFailure);
      stream.removeListener('error', onError);
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error) => finish(error);
    stream.on('error', onError);
    try {
      stream.write(text, error => {
        if (settled) return;
        // Node emits the paired error after this callback. Keep its listener
        // through that emission; callback-only streams still settle next tick.
        if (error) callbackFailure = setImmediate(() => finish(error));
        else finish();
      });
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

async function runDelegationCommand(argv: string[], env: NodeJS.ProcessEnv, help: (operation: string) => string = workerHelp): Promise<number> {
  let token: string | undefined;
  const print = (value: unknown, stderr = false) => {
    const json = JSON.stringify(value);
    (stderr ? console.error : console.log)(token ? json.replaceAll(token, '[REDACTED]') : json);
  };
  try {
    const operation = z.enum([...workerOperationSchema.options, ...conversationOperationSchema.options, 'tasks', 'collect', 'cancel-wait']).parse(argv[0]);
    const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true,
      options: { help: { type: 'boolean', short: 'h' }, ...COMMAND_OPTIONS[operation] } });
    if (values.help) {
      console.log(help(operation));
      return 0;
    }
    const { path, body } = await commandPayload(operation, values, positionals, argv);
    let endpoint: URL;
    try {
      endpoint = delegationEndpoint(env.CEZ_DELEGATION_URL);
      token = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(env.CEZ_DELEGATION_TOKEN);
    } catch { throw new DelegationPolicyError('unavailable_transport', 'Delegation session is unavailable'); }
    try {
      if (operation === 'list') return await printWorkerList(endpoint, token, print);
      if (operation === 'inbox') return await printInbox(endpoint, token, print);
      const response = await fetch(`${endpoint.href}/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000) });
      const data = await boundedJson(response);
      if (operation === 'destroy' && response.status === 409) {
        const incomplete = workerDestroyResultSchema.safeParse(data);
        if (incomplete.success && incomplete.data.state === 'incomplete') { print(incomplete.data); return 1; }
      }
      if (!response.ok) { print(delegationErrorResponseSchema.parse(data)); return 1; }
      const result = responseSchemas[operation].parse(data);
      print(result);
      return 'delivery' in result && result.delivery === 'not-delivered' ? 1 : 0;
    } catch (error) {
      if (error instanceof DelegationPolicyError) throw error;
      throw new DelegationPolicyError('unavailable_transport', 'Delegation transport failed or returned an invalid response');
    }
  } catch (error) {
    print(error instanceof DelegationPolicyError ? { code: error.code, error: error.message } : { code: 'invalid_input', error: formatWorkerCliError(error, argv) });
    return 1;
  }
}


const REMOVED_WORKER_VERBS: Record<string, string> = {
  send: 'request', progress: 'progress', 'follow-up': 'follow-up', reply: 'reply',
  conversation: 'conversation', inbox: 'inbox', 'cancel-request': 'cancel-request', 'wait-requests': 'wait --request',
};
function usageFailure(error: string): number {
  console.log(JSON.stringify({ code: 'invalid_input', error }));
  return 64;
}
export async function runWorkerCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) {
    console.log(workerHelp());
    return 0;
  }
  if (argv.length === 0) {
    console.log(JSON.stringify({ code: 'invalid_input', error: 'Invalid worker command arguments', usage: { operations: WORKER_USAGE.operations.filter(entry => !REMOVED_WORKER_VERBS[entry.name] && !(entry.name === 'wait' && entry.positionals === 0)) } }));
    return 1;
  }
  const replacement = Object.hasOwn(REMOVED_WORKER_VERBS, argv[0] ?? '') ? REMOVED_WORKER_VERBS[argv[0]!] : undefined;
  const flags = optionArguments(argv);
  if (replacement) return usageFailure(`Use cez message ${replacement}; cez worker ${argv[0]} was removed.`);
  if (argv[0] === 'wait' && flags.some(arg => arg === '--request' || arg.startsWith('--request='))) return usageFailure('Use cez message wait --request <UUID>.');
  if (argv[0] === 'wait' && flags.some(arg => arg === '--peer' || arg.startsWith('--peer='))) return usageFailure('Use cez message wait --peer <task-id>.');
  if (argv[0] === 'resume') {
    if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) { console.log(workerHelp('resume')); return 0; }
    if (flags.some(arg => /^--(?:kind|resume|request-id)(?:=|$)/.test(arg))) return usageFailure('Use cez worker resume <worker-id> "<instruction>" --id <UUID> [--timeout-seconds <1-86400>].');
    return runDelegationCommand(['send', '--kind', 'request', '--resume', ...argv.slice(1)], env, () => workerHelp('resume'));
  }
  if (argv[0] === 'tasks') return usageFailure('Use cez message tasks.');
  return runDelegationCommand(argv, env);
}
const MESSAGE_HELP: Record<string, string> = {
  request: '<task-id> "<text>" --id <UUID> [--timeout-seconds <1-1800>]',
  progress: '<task-id> "<text>" --id <UUID>',
  'follow-up': '<task-id> "<text>" --id <UUID> --request-id <UUID>',
  reply: '<task-id> "<text>" --id <UUID> --request-id <UUID>',
  conversation: '<task-id> [--before <cursor>]', inbox: '', 'cancel-request': '<UUID>',
  wait: '--request <UUID> [--request <UUID>...] [--mode one|any|all] [--timeout-seconds <1-1800>] | --peer <task-id> [--peer <task-id>...] [--timeout-seconds <1-1800>]',
  'cancel-wait': '<wait-id>', tasks: '[--all] [--offset <n>]',
};
function messageHelp(operation?: string): string {
  const entries = operation === undefined ? Object.entries(MESSAGE_HELP) : [[operation, MESSAGE_HELP[operation]!]];
  return ['cezar message — task conversations', '', 'Usage:', ...entries.map(([name, args]) => `  cez message ${name} ${args}`), '', 'Commands require an active delegation session and return JSON.'].join('\n');
}
/** Values after the option terminator are always message text or positionals. */
function optionArguments(argv: string[]): string[] {
  const end = argv.indexOf('--');
  return argv.slice(1, end < 0 ? undefined : end);
}
export async function runMessageCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const operation = argv[0];
  if (argv.length === 1 && (operation === '--help' || operation === '-h')) { console.log(messageHelp()); return 0; }
  if (!operation || !Object.hasOwn(MESSAGE_HELP, operation)) return usageFailure('Use cez message --help for task messaging commands.');
  const flags = optionArguments(argv);
  if (flags.some(arg => arg === '--resume' || arg.startsWith('--resume='))) return usageFailure('Use cez worker resume <worker-id> "<instruction>" --id <UUID> to resume an owned worker.');
  if (flags.some(arg => arg === '--kind' || arg.startsWith('--kind='))) return usageFailure('The cez message verb selects the kind; use request, progress, follow-up or reply.');
  if (flags.includes('--help') || flags.includes('-h')) {
    // Let parseArgs decide whether a flag is help or a string option's value.
    const internal = operation === 'request' ? 'send' : operation;
    return runDelegationCommand([internal, ...argv.slice(1)], env, () => messageHelp(operation));
  }
  if (operation === 'wait' && !flags.some(arg => /^--(?:request|peer)(?:=|$)/.test(arg))) return usageFailure('Use cez message wait --request <UUID>, or cez message wait --peer <task-id>.');
  const args = operation === 'request' ? ['send', '--kind', 'request', ...argv.slice(1)] : argv;
  return runDelegationCommand(args, env, () => messageHelp(operation));
}

type PrintResult = (value: unknown, stderr?: boolean) => void;
async function printWorkerList(endpoint: URL, token: string, print: PrintResult): Promise<number> {
        const workers: z.infer<typeof workerListResultSchema>['workers'] = [];
        let offset = 0;
        for (;;) {
          const response = await fetch(`${endpoint.href}/list${offset ? `?offset=${offset}` : ''}`, {
            method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45_000),
          });
          const data = await boundedJson(response);
          if (!response.ok) { print(delegationErrorResponseSchema.parse(data)); return 1; }
          const page = workerListPageSchema.parse(data);
          workers.push(...page.workers);
          if (workers.length > 1_024) throw Error('Worker list too large');
          if (page.nextOffset === undefined) break;
          if (page.nextOffset <= offset) throw Error('Worker list did not advance');
          offset = page.nextOffset;
        }
        print(workerListResultSchema.parse({ workers }));
        return 0;
}
async function printInbox(endpoint: URL, token: string, print: PrintResult): Promise<number> {
        const postInbox = async (action: '' | '/ack' | '/release', payload: object) => {
          const response = await fetch(`${endpoint.href}/inbox${action}`, { method: 'POST', redirect: 'error',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45_000) });
          const data = await boundedJson(response);
          if (!response.ok) throw new InboxHttpError(response.status);
          return data;
        };
        const snapshot = inboxReserveResultSchema.parse(await postInbox('', {}));
        try {
          const json = JSON.stringify(snapshot).replaceAll(token, '[REDACTED]');
          await writeInboxOutput(`${json}\n`);
        } catch {
          if (snapshot.receiptId) {
            try { inboxReceiptResultSchema.parse(await postInbox('/release', { receiptId: snapshot.receiptId })); } catch { /* receipt expires */ }
          }
          print({ code: 'unavailable_transport', error: 'Inbox output failed; the receipt was released or will expire' }, true);
          return 1;
        }
        if (snapshot.receiptId) {
          let acknowledged = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const result = inboxReceiptResultSchema.parse(await postInbox('/ack', { receiptId: snapshot.receiptId }));
              if (result.receiptId !== snapshot.receiptId || (result.status !== 'acknowledged' && result.status !== 'already-acknowledged')) throw Error('Invalid acknowledgement');
              acknowledged = true; break;
            } catch (error) {
              if (error instanceof InboxHttpError && [400, 401, 403].includes(error.status)) break;
              // A transport or server failure may have occurred after commit. Retry this receipt only.
            }
          }
          if (!acknowledged) throw new DelegationPolicyError('unavailable_transport', `Inbox acknowledgement failed for receipt ${snapshot.receiptId}; messages may reappear after expiry`);
        }
        return 0;
}

type CliValues = Record<string, string | boolean | string[] | undefined>;
const stringFlag = { type: 'string' } as const;
const repeatedFlag = { type: 'string', multiple: true } as const;
const messageOptions = { id: stringFlag, kind: stringFlag, 'request-id': stringFlag, 'timeout-seconds': stringFlag };
const waitOptions = { request: repeatedFlag, peer: repeatedFlag, 'timeout-seconds': stringFlag, mode: stringFlag };
const COMMAND_OPTIONS: Record<string, NonNullable<Parameters<typeof parseArgs>[0]>['options']> = {
  spawn: { baseline: stringFlag, 'request-id': stringFlag, workflow: stringFlag, skill: stringFlag, runner: stringFlag, backend: stringFlag,
    model: stringFlag, effort: stringFlag, context: stringFlag, 'context-file': stringFlag, attach: repeatedFlag },
  conversation: { before: stringFlag }, tasks: { all: { type: 'boolean' }, offset: stringFlag },
  send: { ...messageOptions, resume: { type: 'boolean' } }, progress: messageOptions, reply: messageOptions, 'follow-up': messageOptions,
  wait: waitOptions, 'wait-requests': waitOptions,
};
function cliInteger(operation: string, flag: string, value: CliValues[string]): number | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new WorkerCliError(`${operation} has invalid --${flag}`);
  return Number(value);
}
function messagePayload(operation: string, values: CliValues, positionals: string[]) {
  expectCount(operation, positionals, 2);
  return conversationSendRequestSchema.parse({ id: values.id, recipientRunId: positionals[0], text: positionals[1],
    kind: operation === 'send' ? values.kind : operation, resume: values.resume, requestId: values['request-id'],
    timeoutSeconds: cliInteger(operation, 'timeout-seconds', values['timeout-seconds']) });
}
async function spawnPayload(values: CliValues, positionals: string[], argv: string[]) {
  expectCount('spawn', positionals, 1);
  const skillIssue = skillFlagIssue({ skill: values.skill as string | undefined, workflow: values.workflow as string | undefined });
  if (skillIssue) throw new WorkerCliError(skillIssue);
  const { runner, issue } = runnerFlag({ runner: values.runner as string | undefined, backend: values.backend as string | undefined });
  if (issue) throw new WorkerCliError(issue);
  if (values.context !== undefined && values['context-file'] !== undefined) throw new WorkerCliError('spawn has extra argument --context-file');
  const text = values['context-file'] === undefined ? values.context
    : new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedContextFile(String(values['context-file']), 400_000));
  const typed = (values.attach as string[] | undefined) ?? [];
  const attached = await attachPaths(typed);
  const context = { text, artifacts: attached.length ? attached.map(path => ({ kind: 'parent-file' as const, path })) : undefined };
  const parsed = workerSpawnRequestSchema.safeParse({ task: positionals[0], baseline: values.baseline, requestId: values['request-id'], backend: runner,
    model: values.model, effort: values.effort, workflow: values.workflow, skill: values.skill,
    context: text === undefined && !attached.length ? undefined : context });
  if (!parsed.success) throw new WorkerCliError(attachIssue(parsed.error, 'spawn', typed) ?? formatWorkerCliError(parsed.error, argv));
  return parsed.data;
}
function waitPayload(operation: string, values: CliValues, positionals: string[]) {
  // `cez message wait --peer` (hearsay-tools/cezarion#1995): named peer tasks, never with requests or a mode.
  if (values.peer !== undefined) {
    if (positionals.length > 0) throw new WorkerCliError(`${operation} has extra argument`);
    if (values.request !== undefined) throw new WorkerCliError(`${operation} has extra argument --request`);
    if (values.mode !== undefined) throw new WorkerCliError(`${operation} has extra argument --mode`);
    return peerWaitRequestSchema.parse({ peerIds: values.peer, timeoutSeconds: cliInteger(operation, 'timeout-seconds', values['timeout-seconds']) });
  }
  const requests = values.request;
  if (requests !== undefined && positionals.length > 0) throw new WorkerCliError(`${operation} has extra argument`);
  const requestWait = requests !== undefined || operation === 'wait-requests';
  return (requestWait ? requestWaitRequestSchema : workerWaitRequestSchema).parse({
    ...(requestWait ? { requestIds: requests ?? positionals } : { workerIds: positionals }), mode: values.mode,
    timeoutSeconds: cliInteger(operation, 'timeout-seconds', values['timeout-seconds']) });
}
function workerPayload(operation: string, positionals: string[]) {
  expectCount(operation, positionals, operation === 'steer' ? 2 : 1);
  const { workerId } = workerParamsSchema.parse({ workerId: positionals[0] });
  const path = operation === 'inspect' ? workerId : `${workerId}/${operation}`;
  const body = operation === 'steer' ? workerSteerRequestSchema.parse({ text: positionals[1] }) : ['stop', 'destroy', 'collect'].includes(operation) ? {} : undefined;
  return { path, body };
}
async function commandPayload(operation: string, values: CliValues, positionals: string[], argv: string[]): Promise<{ path: string; body?: unknown }> {
  if (['send', 'progress', 'reply', 'follow-up'].includes(operation)) return { path: operation === 'progress' ? 'send' : operation, body: messagePayload(operation, values, positionals) };
  if (operation === 'spawn') return { path: 'spawn', body: await spawnPayload(values, positionals, argv) };
  if (operation === 'wait' || operation === 'wait-requests') return { path: 'wait', body: waitPayload(operation, values, positionals) };
  if (operation === 'tasks') {
    expectCount(operation, positionals, 0);
    return { path: 'discover', body: discoveryRequestSchema.parse({ kind: 'tasks', all: values.all, offset: cliInteger(operation, 'offset', values.offset) }) };
  }
  if (operation === 'list' || operation === 'inbox') { expectCount(operation, positionals, 0); return { path: operation }; }
  if (operation === 'conversation') {
    expectCount(operation, positionals, 1);
    return { path: operation, body: conversationInspectRequestSchema.parse({ recipientRunId: positionals[0], before: values.before }) };
  }
  if (operation === 'cancel-request' || operation === 'cancel-wait') {
    expectCount(operation, positionals, 1);
    const body = operation === 'cancel-request' ? conversationCancelRequestSchema.parse({ requestId: positionals[0] }) : workerCancelWaitRequestSchema.parse({ waitId: positionals[0] });
    return { path: operation, body };
  }
  return workerPayload(operation, positionals);
}
