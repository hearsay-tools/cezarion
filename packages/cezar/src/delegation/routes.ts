import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ZodError } from 'zod';
import { z } from 'zod';
import { conversationSendRequestSchema, conversationInspectRequestSchema, conversationCancelRequestSchema, requestWaitRequestSchema, workerCancelWaitRequestSchema, workerSpawnRequestSchema, workerSteerRequestSchema, workerWaitRequestSchema, workerParamsSchema, workerEmptyRequestSchema } from '@open-mercato/cezar-contract';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from '../server/validators.ts';
import { isLoopbackHostHeader } from '../server/capabilities.ts';
import { CredentialRegistry, type Caller } from './credentials.ts';
import { delegationEnabled, type DelegationService } from './service.ts';
import { DelegationPolicyError } from './policy.ts';

type Env = { Variables: { caller: Caller } };
export function delegationFailure(error: unknown) {
  const known = error instanceof DelegationPolicyError ? error : error instanceof ZodError
    ? new DelegationPolicyError('invalid_input', 'Invalid delegation input')
    : new DelegationPolicyError('incompatible_state', 'Delegation operation could not be completed');
  const status = known.code === 'unauthenticated' ? 401 : known.code === 'denied_scope' ? 403
    : known.code === 'invalid_input' || known.code === 'invalid_baseline' ? 400
    : known.code === 'unavailable_transport' ? 503 : 409;
  return { body: { code: known.code, error: known.message.slice(0, 2_000) }, status } as const;
}

/** Only this family runs on the private listener. It never inherits hosted cockpit exposure. */
export function createDelegationRoutes(service: DelegationService, credentials: CredentialRegistry) {
  const authenticateDelegation: MiddlewareHandler<Env> = async (c, next) => {
    const host = c.req.header('host');
    const origin = c.req.header('origin');
    let originOK = origin === undefined;
    try { if (origin !== undefined) originOK = new URL(origin).origin === new URL(c.req.url).origin && new URL(origin).host === host; } catch { /* reject */ }
    if (!isLoopbackHostHeader(host ?? '') || !originOK || c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json({ code: 'denied_scope' as const, error: 'Worker scope denied' }, 403);
    }
    if (!delegationEnabled()) return c.json({ code: 'unavailable_transport' as const, error: 'Delegation is unavailable' }, 503);
    const authorization = c.req.header('authorization');
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const caller = token ? credentials.authenticate(token) : undefined;
    if (!caller) return c.json({ code: 'unauthenticated' as const, error: 'Delegation authentication required' }, 401);
    c.set('caller', caller);
    await next();
  };
  const invalid = { code: 'invalid_input', message: 'Invalid delegation input' } as const;
  return new Hono<Env>()
    .onError((error, c) => { const failure = delegationFailure(error); return c.json(failure.body, failure.status); })
    .use('*', authenticateDelegation)
    .use('*', bodyLimit({ maxSize: 1_048_576, onError: c => c.json({ code: 'invalid_input' as const, error: 'Delegation request too large' }, 400) }))
    .use('*', queryZodValidator(workerEmptyRequestSchema, invalid))
    .post('/spawn', jsonZodValidator(workerSpawnRequestSchema, invalid), async c => c.json(await service.spawn(c.get('caller'), c.req.valid('json')), 201))
    .post('/wait', jsonZodValidator(z.union([workerWaitRequestSchema, requestWaitRequestSchema]), invalid), async c => { const value = c.req.valid('json'); return c.json(await ('requestIds' in value ? service.waitRequests(c.get('caller'), value) : service.wait(c.get('caller'), value)), 200); })
    .post('/cancel-wait', jsonZodValidator(workerCancelWaitRequestSchema, invalid), async c => c.json(await service.cancelWait(c.get('caller'), c.req.valid('json')), 200))
    .post('/send', jsonZodValidator(conversationSendRequestSchema, invalid), async c => c.json(await service.send(c.get('caller'), c.req.valid('json')), 200))
    .post('/follow-up', jsonZodValidator(conversationSendRequestSchema, invalid), async c => c.json(await service.followUp(c.get('caller'), c.req.valid('json')), 200))
    .post('/reply', jsonZodValidator(conversationSendRequestSchema, invalid), async c => c.json(await service.reply(c.get('caller'), c.req.valid('json')), 200))
    .post('/conversation', jsonZodValidator(conversationInspectRequestSchema, invalid), async c => c.json(await service.conversation(c.get('caller'), c.req.valid('json')), 200))
    .post('/cancel-request', jsonZodValidator(conversationCancelRequestSchema, invalid), async c => c.json(await service.cancelRequest(c.get('caller'), c.req.valid('json')), 200))
    .get('/:workerId', paramZodValidator(workerParamsSchema, invalid), async c => c.json(await service.inspect(c.get('caller'), c.req.valid('param')), 200))
    .post('/:workerId/collect', paramZodValidator(workerParamsSchema, invalid), jsonZodValidator(workerEmptyRequestSchema, { ...invalid, absent: {}, malformed: null }), async c => c.json(await service.collect(c.get('caller'), c.req.valid('param')), 200))
    .post('/:workerId/steer', paramZodValidator(workerParamsSchema, invalid), jsonZodValidator(workerSteerRequestSchema, invalid), async c => c.json(await service.steer(c.get('caller'), c.req.valid('param'), c.req.valid('json')), 200))
    .post('/:workerId/stop', paramZodValidator(workerParamsSchema, invalid), jsonZodValidator(workerEmptyRequestSchema, { ...invalid, absent: {}, malformed: null }), async c => c.json(await service.stop(c.get('caller'), c.req.valid('param')), 200))
    .post('/:workerId/destroy', paramZodValidator(workerParamsSchema, invalid), jsonZodValidator(workerEmptyRequestSchema, { ...invalid, absent: {}, malformed: null }), async c => {
      const result = await service.destroy(c.get('caller'), c.req.valid('param'));
      return result.state === 'incomplete' ? c.json(result, 409) : c.json(result, 200);
    })
    .get('/:workerId/diff', paramZodValidator(workerParamsSchema, invalid), async c => c.json(await service.diff(c.get('caller'), c.req.valid('param')), 200));
}
export type DelegationRoutes = ReturnType<typeof createDelegationRoutes>;
