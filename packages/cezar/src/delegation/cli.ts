import { readBoundedContextFile } from './context.ts';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  conversationSendRequestSchema, conversationSendResultSchema, conversationStateSchema, conversationInspectRequestSchema, conversationCancelRequestSchema, requestOutcomeSchema, requestWaitRequestSchema,
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

const conversationOperationSchema = z.enum(['send', 'progress', 'follow-up', 'reply', 'conversation', 'cancel-request', 'wait-requests']);
const responseSchemas = { send: conversationSendResultSchema, progress: conversationSendResultSchema, 'follow-up': conversationSendResultSchema, reply: conversationSendResultSchema, conversation: conversationStateSchema, 'cancel-request': requestOutcomeSchema, 'wait-requests': workerWaitResultSchema, collect: workerCollectedResultSchema, spawn: workerSpawnResultSchema, inspect: workerInspectionSchema, steer: workerSteerResultSchema,
  stop: workerStopResultSchema, destroy: workerDestroyResultSchema, diff: workerDiffSchema, wait: workerWaitResultSchema, 'cancel-wait': workerCancelWaitResultSchema };
const RESPONSE_BYTES = 3_145_728;
const CLI_FLAG: Record<string, string> = {
  requestId: '--request-id', baseline: '--baseline', backend: '--backend', model: '--model', effort: '--effort',
  timeoutSeconds: '--timeout-seconds', mode: '--mode', kind: '--kind', id: '--id', context: '--context',
  requestIds: '--request', workerIds: 'worker-id', workerId: 'worker-id', waitId: 'wait-id', recipientRunId: 'recipient-run-id',
  task: 'task', text: 'text',
};
const WORKER_USAGE = { operations: [
  { name: 'spawn', positionals: 1, required: ['--baseline', '--request-id'], optional: ['--backend', '--model', '--effort', '--context', '--context-file'] },
  { name: 'inspect', positionals: 1 },
  { name: 'steer', positionals: 2 },
  { name: 'stop', positionals: 1 },
  { name: 'destroy', positionals: 1 },
  { name: 'diff', positionals: 1 },
  { name: 'collect', positionals: 1 },
  { name: 'wait', positionals: 1, optional: ['--mode', '--timeout-seconds'] },
  { name: 'wait', positionals: 0, required: ['--request'], optional: ['--mode', '--timeout-seconds'] },
  { name: 'cancel-wait', positionals: 1 },
  { name: 'send', positionals: 2, required: ['--id', '--kind'], optional: ['--request-id', '--timeout-seconds'] },
  { name: 'progress', positionals: 2, required: ['--id'], optional: ['--timeout-seconds'] },
  { name: 'follow-up', positionals: 2, required: ['--id', '--request-id'], optional: ['--timeout-seconds'] },
  { name: 'reply', positionals: 2, required: ['--id', '--request-id'], optional: ['--timeout-seconds'] },
  { name: 'conversation', positionals: 1 },
  { name: 'wait-requests', positionals: 1, optional: ['--mode', '--timeout-seconds'] },
  { name: 'cancel-request', positionals: 1 },
] };
class WorkerCliError extends Error {}
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
    if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
      print({ code: 'invalid_input', error: 'Invalid worker command arguments', usage: WORKER_USAGE });
      return 1;
    }
    const operation = argv[0] === 'collect' ? 'collect' : argv[0] === 'cancel-wait' ? 'cancel-wait' : z.union([workerOperationSchema, conversationOperationSchema]).parse(argv[0]);
    const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true, options: {
      ...(operation === 'spawn' ? { baseline: { type: 'string' as const }, 'request-id': { type: 'string' as const }, backend: { type: 'string' as const }, model: { type: 'string' as const }, effort: { type: 'string' as const }, context: { type: 'string' as const }, 'context-file': { type: 'string' as const } } : {}),
      ...(['send', 'progress', 'reply', 'follow-up'].includes(operation) ? { id: { type: 'string' as const }, kind: { type: 'string' as const }, 'request-id': { type: 'string' as const }, 'timeout-seconds': { type: 'string' as const } } : {}),
      ...(operation === 'wait' || operation === 'wait-requests' ? { request: { type: 'string' as const, multiple: true }, 'timeout-seconds': { type: 'string' as const }, mode: { type: 'string' as const } } : {}),
    } });
    let path: string = operation;
    let body: unknown;
    if (operation === 'send' || operation === 'progress' || operation === 'reply' || operation === 'follow-up') {
      expectCount(operation, positionals, 2);
      if (operation !== 'send' && values.kind !== undefined) throw new WorkerCliError(`${operation} has extra argument --kind`);
      const timeout = values['timeout-seconds'];
      if (timeout !== undefined && !/^\d+$/.test(String(timeout))) throw new WorkerCliError(`${operation} has invalid --timeout-seconds`);
      body = conversationSendRequestSchema.parse({ id: values.id, recipientRunId: positionals[0], text: positionals[1], kind: operation === 'send' ? values.kind : operation,
        ...(values['request-id'] === undefined ? {} : { requestId: values['request-id'] }), ...(timeout === undefined ? {} : { timeoutSeconds: Number(timeout) }) });
      if (operation === 'progress') path = 'send';
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
      const response = await fetch(`${endpoint.href}/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000) });
      const data = await boundedJson(response);
      if (operation === 'destroy' && response.status === 409) {
        const incomplete = workerDestroyResultSchema.safeParse(data);
        if (incomplete.success && incomplete.data.state === 'incomplete') { print(incomplete.data); return 1; }
      }
      if (!response.ok) { print(delegationErrorResponseSchema.parse(data)); return 1; }
      print(responseSchemas[operation].parse(data)); return 0;
    } catch { throw new DelegationPolicyError('unavailable_transport', 'Delegation transport failed or returned an invalid response'); }
  } catch (error) {
    print(error instanceof DelegationPolicyError ? { code: error.code, error: error.message } : { code: 'invalid_input', error: formatWorkerCliError(error, argv[0]) });
    return 1;
  }
}
