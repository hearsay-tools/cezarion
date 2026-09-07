import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  workerOperationSchema, workerParamsSchema, workerSpawnRequestSchema, workerSteerRequestSchema, workerWaitRequestSchema,
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

const responseSchemas = { spawn: workerSpawnResultSchema, inspect: workerInspectionSchema, steer: workerSteerResultSchema,
  stop: workerStopResultSchema, destroy: workerDestroyResultSchema, diff: workerDiffSchema, wait: workerWaitResultSchema };
const RESPONSE_BYTES = 3_145_728;
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
    const operation = workerOperationSchema.parse(argv[0]);
    const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true, options: {
      ...(operation === 'spawn' ? { baseline: { type: 'string' as const }, 'request-id': { type: 'string' as const } } : {}),
      ...(operation === 'wait' ? { 'timeout-seconds': { type: 'string' as const } } : {}),
    } });
    let path: string = operation;
    let body: unknown;
    if (operation === 'spawn') {
      if (positionals.length !== 1) throw Error('arguments');
      body = workerSpawnRequestSchema.parse({ task: positionals[0], baseline: values.baseline, requestId: values['request-id'] });
    } else if (operation === 'wait') {
      const timeout = values['timeout-seconds'];
      if (timeout !== undefined && (typeof timeout !== 'string' || !/^\d+$/.test(timeout))) throw Error('arguments');
      body = workerWaitRequestSchema.parse({ workerIds: positionals, ...(timeout === undefined ? {} : { timeoutSeconds: Number(timeout) }) });
    } else {
      if (positionals.length !== (operation === 'steer' ? 2 : 1)) throw Error('arguments');
      const { workerId } = workerParamsSchema.parse({ workerId: positionals[0] });
      path = operation === 'inspect' ? workerId : `${workerId}/${operation}`;
      body = operation === 'steer' ? workerSteerRequestSchema.parse({ text: positionals[1] }) : operation === 'stop' || operation === 'destroy' ? {} : undefined;
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
    print(error instanceof DelegationPolicyError ? { code: error.code, error: error.message } : { code: 'invalid_input', error: 'Invalid worker command arguments' });
    return 1;
  }
}
