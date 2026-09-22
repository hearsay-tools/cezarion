import { readBoundedContextFile } from './context.ts';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  conversationSendRequestSchema, conversationSendResultSchema, conversationInspectResultSchema, conversationInspectRequestSchema, conversationCancelRequestSchema, inboxReserveResultSchema, inboxReceiptResultSchema, requestOutcomeSchema, requestWaitRequestSchema,
  workerCollectedResultSchema, workerCancelWaitRequestSchema, workerCancelWaitResultSchema, workerOperationSchema, workerParamsSchema, workerSpawnRequestSchema, workerSteerRequestSchema, workerWaitRequestSchema,
  workerSpawnResultSchema, workerInspectionSchema, workerSteerResultSchema, workerStopResultSchema, workerDestroyResultSchema,
  workerDiffSchema, workerWaitResultSchema, delegationErrorResponseSchema,
} from '@open-mercato/cezar-contract';
import { DelegationPolicyError } from './policy.ts';

/** Accept exactly the endpoint format minted by this installation's private listener. */
export function delegationEndpoint(value: string | undefined): URL {
  if (!value) throw new Error('Delegation endpoint absent');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1 ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1/delegation') throw new Error('Invalid delegation endpoint');
  return url;
}

const conversationOperationSchema = z.enum(['send', 'progress', 'follow-up', 'reply', 'conversation', 'inbox', 'cancel-request', 'wait-requests']);
const responseSchemas = { send: conversationSendResultSchema, progress: conversationSendResultSchema, 'follow-up': conversationSendResultSchema, reply: conversationSendResultSchema, conversation: conversationInspectResultSchema, 'cancel-request': requestOutcomeSchema, 'wait-requests': workerWaitResultSchema, collect: workerCollectedResultSchema, spawn: workerSpawnResultSchema, inspect: workerInspectionSchema, steer: workerSteerResultSchema,
  stop: workerStopResultSchema, destroy: workerDestroyResultSchema, diff: workerDiffSchema, wait: workerWaitResultSchema, 'cancel-wait': workerCancelWaitResultSchema };
const RESPONSE_BYTES = 3_145_728;
const CLI_FLAG: Record<string, string> = {
  requestId: '--request-id', baseline: '--baseline', backend: '--backend', model: '--model', effort: '--effort', workflow: '--workflow',
  timeoutSeconds: '--timeout-seconds', mode: '--mode', kind: '--kind', id: '--id', context: '--context',
  requestIds: '--request', workerIds: 'worker-id', workerId: 'worker-id', waitId: 'wait-id', recipientRunId: 'recipient-run-id',
  task: 'task', text: 'text',
};
const WORKER_USAGE = { operations: [
  { name: 'spawn', positionals: 1, required: ['--baseline', '--request-id'], optional: ['--workflow', '--backend', '--model', '--effort', '--context', '--context-file'] },
  { name: 'inspect', positionals: 1 },
  { name: 'steer', positionals: 2 },
  { name: 'stop', positionals: 1 },
  { name: 'destroy', positionals: 1 },
  { name: 'diff', positionals: 1 },
  { name: 'collect', positionals: 1 },
  { name: 'wait', positionals: 1, optional: ['--mode', '--timeout-seconds'] },
  { name: 'wait', positionals: 0, required: ['--request'], optional: ['--mode', '--timeout-seconds'] },
  { name: 'cancel-wait', positionals: 1 },
  { name: 'send', positionals: 2, required: ['--id', '--kind'], optional: ['--timeout-seconds', '--resume'] },
  { name: 'progress', positionals: 2, required: ['--id'], optional: ['--timeout-seconds', '--resume'] },
  { name: 'follow-up', positionals: 2, required: ['--id', '--request-id'], optional: ['--timeout-seconds'] },
  { name: 'reply', positionals: 2, required: ['--id', '--request-id'], optional: ['--timeout-seconds'] },
  { name: 'conversation', positionals: 1 },
  { name: 'inbox', positionals: 0 },
  { name: 'wait-requests', positionals: 1, optional: ['--mode', '--timeout-seconds'] },
  { name: 'cancel-request', positionals: 1 },
] };
const WORKER_HELP: Record<string, { args: string; description: string }> = {
  spawn: { args: '"<task>" --baseline <ref> --request-id <UUID>', description: 'Create an owned worker from a committed baseline.' },
  inspect: { args: '<worker-id>', description: 'Show worker state and input locations.' },
  steer: { args: '<worker-id> "<text>"', description: 'Send instructions to a running worker.' },
  stop: { args: '<worker-id>', description: 'Stop a worker.' },
  destroy: { args: '<worker-id>', description: 'Remove owned worker resources after collecting results.' },
  diff: { args: '<worker-id>', description: 'Show the bounded worker diff.' },
  collect: { args: '<worker-id>', description: 'Collect the latest worker results; does not merge changes.' },
  wait: { args: '<worker-id>... | --request <UUID> [--request <UUID>...]', description: 'Register a wait for workers or message requests, then end your turn.' },
  'cancel-wait': { args: '<wait-id>', description: 'Cancel a wait without cancelling requests or workers.' },
  send: { args: '<recipient-run-id> "<text>" --id <UUID> --kind <request|progress>', description: 'Send a request requiring a reply, or a progress update.' },
  progress: { args: '<recipient-run-id> "<text>" --id <UUID>', description: 'Send an update without a reply obligation.' },
  'follow-up': { args: '<recipient-run-id> "<text>" --id <UUID> --request-id <UUID>', description: 'Clarify an existing request.' },
  reply: { args: '<recipient-run-id> "<text>" --id <UUID> --request-id <UUID>', description: 'Reply to an existing request.' },
  conversation: { args: '<recipient-run-id>', description: 'Inspect conversation messages and outcomes.' },
  inbox: { args: '', description: 'Read new messages and acknowledge only those printed successfully.' },
  'wait-requests': { args: '<request-id>...', description: 'Register a wait for message requests, then end your turn.' },
  'cancel-request': { args: '<request-id>', description: 'Cancel a request obligation.' },
};
const WORKER_FLAG_HELP: Record<string, string> = {
  '--baseline': '<ref>                 Committed ref or parent-head; excludes dirty edits.',
  '--request-id': '<UUID>              Spawn retry ID, or request being followed up/replied to.',
  '--backend': '<name>                 claude | codex | opencode | pi | cursor.',
  '--model': '<model>                  Model override.',
  '--effort': '<level>                 low | medium | high | xhigh | max | auto.',
  '--workflow': '<name>                Catalog workflow to run (built-in quick-task or .ai/cezar/workflows); default quick-task.',
  '--context': '<text>                 Selected context; mutually exclusive with --context-file.',
  '--context-file': '<path>            UTF-8 context file; mutually exclusive with --context.',
  '--mode': '<one|any|all>             Wait mode (default any); one requires one target.',
  '--timeout-seconds': '<1-1800>       Wait or request deadline (default 600 seconds).',
  '--request': '<UUID>                 Request to wait for; repeat for multiple requests.',
  '--id': '<UUID>                      Message ID; reuse only for an exact retry.',
  '--kind': '<request|progress>        Whether the message requires an explicit reply.',
  '--resume': '                         Resume an owned finished worker with this new instruction.',
};
function workerHelp(operation?: string): string {
  const operations = WORKER_USAGE.operations.filter(entry => operation === undefined || entry.name === operation);
  const names = [...new Set(operations.map(entry => entry.name))];
  const flags = [...new Set(operations.flatMap(entry => [...(entry.required ?? []), ...(entry.optional ?? [])]))];
  return [
    'cezar worker — manage owned coding workers and conversations', '', 'Usage:',
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
class InboxHttpError extends Error { constructor(readonly status: number) { super('Inbox operation failed'); } }
function cliName(path: PropertyKey[]): string {
  return CLI_FLAG[String(path[0] ?? '')] ?? String(path[0] ?? 'argument');
}
function expectCount(operation: string, positionals: string[], count: number): void {
  if (positionals.length === count) return;
  throw new WorkerCliError(positionals.length > count ? `${operation} has extra argument` : `${operation} is missing a positional`);
}
function formatWorkerCliError(error: unknown, argv0: string | undefined): string {
  if (error instanceof WorkerCliError) return error.message;
  if (error instanceof z.ZodError) {
    const operationUnknown = error.issues.every(issue => issue.path.length === 0)
      && error.issues.some(issue => issue.code === 'invalid_union' || issue.code === 'invalid_value');
    if (operationUnknown) return `unknown operation '${argv0 ?? ''}'`;
    const operation = argv0 ?? 'worker';
    const missing = error.issues.filter(issue => issue.code === 'invalid_type' && issue.message.includes('undefined'));
    if (missing.length) return `${operation} is missing ${missing.map(issue => cliName(issue.path)).join(' and ')}`;
    const first = error.issues[0];
    return first ? `${operation} has invalid ${cliName(first.path)}` : 'Invalid worker command arguments';
  }
  if (error instanceof Error && 'code' in error && error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const unknown = error.message.match(/Unknown option ['"]([^'"]+)['"]/);
    return `${argv0 ?? 'worker'} has extra argument ${unknown?.[1] ?? 'flag'}`;
  }
  return 'Invalid worker command arguments';
}
async function boundedJson(response: Response): Promise<unknown> {
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

export async function runWorkerCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let token: string | undefined;
  const print = (value: unknown) => {
    const json = JSON.stringify(value);
    console.log(token ? json.replaceAll(token, '[REDACTED]') : json);
  };
  try {
    if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) {
      console.log(workerHelp());
      return 0;
    }
    if (argv.length === 0) {
      print({ code: 'invalid_input', error: 'Invalid worker command arguments', usage: WORKER_USAGE });
      return 1;
    }
    const operation = argv[0] === 'collect' ? 'collect' : argv[0] === 'cancel-wait' ? 'cancel-wait' : z.union([workerOperationSchema, conversationOperationSchema]).parse(argv[0]);
    const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' },
      ...(operation === 'spawn' ? { baseline: { type: 'string' as const }, 'request-id': { type: 'string' as const }, workflow: { type: 'string' as const }, backend: { type: 'string' as const }, model: { type: 'string' as const }, effort: { type: 'string' as const }, context: { type: 'string' as const }, 'context-file': { type: 'string' as const } } : {}),
      ...(['send', 'progress', 'reply', 'follow-up'].includes(operation) ? { id: { type: 'string' as const }, kind: { type: 'string' as const }, 'request-id': { type: 'string' as const }, 'timeout-seconds': { type: 'string' as const } } : {}),
      ...(operation === 'send' || operation === 'progress' ? { resume: { type: 'boolean' as const } } : {}),
      ...(operation === 'wait' || operation === 'wait-requests' ? { request: { type: 'string' as const, multiple: true }, 'timeout-seconds': { type: 'string' as const }, mode: { type: 'string' as const } } : {}),
    } });
    if (values.help) {
      console.log(workerHelp(operation));
      return 0;
    }
    let path: string = operation;
    let body: unknown;
    if (operation === 'send' || operation === 'progress' || operation === 'reply' || operation === 'follow-up') {
      expectCount(operation, positionals, 2);
      if (operation !== 'send' && values.kind !== undefined) throw new WorkerCliError(`${operation} has extra argument --kind`);
      const timeout = values['timeout-seconds'];
      if (timeout !== undefined && !/^\d+$/.test(String(timeout))) throw new WorkerCliError(`${operation} has invalid --timeout-seconds`);
      body = conversationSendRequestSchema.parse({ id: values.id, recipientRunId: positionals[0], text: positionals[1], kind: operation === 'send' ? values.kind : operation,
        ...(values.resume === undefined ? {} : { resume: values.resume }),
        ...(values['request-id'] === undefined ? {} : { requestId: values['request-id'] }), ...(timeout === undefined ? {} : { timeoutSeconds: Number(timeout) }) });
      if (operation === 'progress') path = 'send';
    } else if (operation === 'inbox') {
      expectCount(operation, positionals, 0);
      body = {};
    } else if (operation === 'conversation' || operation === 'cancel-request') {
      expectCount(operation, positionals, 1);
      body = operation === 'conversation' ? conversationInspectRequestSchema.parse({ recipientRunId: positionals[0] }) : conversationCancelRequestSchema.parse({ requestId: positionals[0] });
    } else if (operation === 'spawn') {
      expectCount(operation, positionals, 1);
      if (values.context !== undefined && values['context-file'] !== undefined) throw new WorkerCliError('spawn has extra argument --context-file');
      const contextText = values['context-file'] === undefined ? values.context
        : new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedContextFile(String(values['context-file']), 400_000));
      body = workerSpawnRequestSchema.parse({ task: positionals[0], baseline: values.baseline, requestId: values['request-id'],
        ...(values.backend === undefined ? {} : { backend: values.backend }), ...(values.model === undefined ? {} : { model: values.model }),
        ...(values.effort === undefined ? {} : { effort: values.effort }),
        ...(values.workflow === undefined ? {} : { workflow: values.workflow }),
        ...(contextText === undefined ? {} : { context: { text: contextText } }),
      });
    } else if (operation === 'wait' || operation === 'wait-requests') {
      const timeout = values['timeout-seconds'];
      if (timeout !== undefined && (typeof timeout !== 'string' || !/^\d+$/.test(timeout))) throw new WorkerCliError(`${operation} has invalid --timeout-seconds`);
      const requests = values.request;
      if (requests !== undefined && positionals.length > 0) throw new WorkerCliError(`${operation} has extra argument`);
      const requestWait = requests !== undefined || operation === 'wait-requests';
      if (requestWait) path = 'wait';
      body = (requestWait ? requestWaitRequestSchema : workerWaitRequestSchema).parse({ ...(requestWait ? { requestIds: requests ?? positionals } : { workerIds: positionals }), ...(values.mode === undefined ? {} : { mode: values.mode }), ...(timeout === undefined ? {} : { timeoutSeconds: Number(timeout) }) });
    } else if (operation === 'cancel-wait') {
      expectCount(operation, positionals, 1);
      body = workerCancelWaitRequestSchema.parse({ waitId: positionals[0] });
    } else {
      expectCount(operation, positionals, operation === 'steer' ? 2 : 1);
      const { workerId } = workerParamsSchema.parse({ workerId: positionals[0] });
      path = operation === 'inspect' ? workerId : `${workerId}/${operation}`;
      body = operation === 'steer' ? workerSteerRequestSchema.parse({ text: positionals[1] }) : operation === 'stop' || operation === 'destroy' || operation === 'collect' ? {} : undefined;
    }
    let endpoint: URL;
    try {
      endpoint = delegationEndpoint(env.CEZ_DELEGATION_URL);
      token = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(env.CEZ_DELEGATION_TOKEN);
    } catch { throw new DelegationPolicyError('unavailable_transport', 'Delegation session is unavailable'); }
    try {
      if (operation === 'inbox') {
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
          await new Promise<void>((resolve, reject) => { process.stdout.write(`${json}\n`, error => error ? reject(error) : resolve()); });
        } catch {
          if (snapshot.receiptId) {
            try { inboxReceiptResultSchema.parse(await postInbox('/release', { receiptId: snapshot.receiptId })); } catch { /* receipt expires */ }
          }
          throw new DelegationPolicyError('unavailable_transport', 'Inbox output failed; the receipt was released or will expire');
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
    print(error instanceof DelegationPolicyError ? { code: error.code, error: error.message } : { code: 'invalid_input', error: formatWorkerCliError(error, argv[0]) });
    return 1;
  }
}
