import { hc, type InferResponseType } from 'hono/client';
import type { ExtractSchema } from 'hono/types';
import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { DelegationApp } from '../delegation/transport.ts';
import type { AppType } from './app-type.ts';
import type { workerCollectedResultSchema, workerCancelWaitRequestSchema, workerCancelWaitResultSchema, runRelationshipsSchema, runIdParamSchema, workerSpawnResultSchema, workerInspectionSchema, workerSteerResultSchema, workerStopResultSchema, workerDestroyResultSchema, workerDiffSchema, workerWaitResultSchema, workerSpawnRequestSchema, workerWaitRequestSchema, workerParamsSchema, workerSteerRequestSchema, workerEmptyRequestSchema } from '@open-mercato/cezar-contract';

describe('delegation contract and chained type surface', () => {
  const client = hc<DelegationApp>('http://127.0.0.1');
  const family = client.api.v1.delegation;
  const human = hc<AppType>('http://127.0.0.1');
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-wider') : 'schema-wider';
  type Assert<T extends true> = T;
  type Schema = ExtractSchema<DelegationApp>;
  type HumanSchema = ExtractSchema<AppType>;
  type _Checks = [
    Assert<Mutual<z.infer<typeof workerCollectedResultSchema>, InferResponseType<typeof family[':workerId']['collect']['$post'], 200>>>,
    Assert<Mutual<z.input<typeof workerParamsSchema>, Schema['/api/v1/delegation/:workerId/collect']['$post']['input']['param']>>,
    Assert<Mutual<z.input<typeof workerEmptyRequestSchema>, Schema['/api/v1/delegation/:workerId/collect']['$post']['input']['json']>>,
    Assert<Mutual<z.infer<typeof runRelationshipsSchema>, InferResponseType<typeof human.api.v1.runs[':id']['relationships']['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof runRelationshipsSchema>, InferResponseType<typeof human.api.v1.p[':projectId']['runs'][':id']['relationships']['$get'], 200>>>,
    Assert<Mutual<z.input<typeof runIdParamSchema>, HumanSchema['/api/v1/runs/:id/relationships']['$get']['input']['param']>>,
    Assert<Mutual<z.infer<typeof workerSpawnResultSchema>, InferResponseType<typeof family.spawn.$post, 201>>>,
    Assert<Mutual<z.infer<typeof workerInspectionSchema>, InferResponseType<typeof family[':workerId']['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof workerSteerResultSchema>, InferResponseType<typeof family[':workerId']['steer']['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof workerStopResultSchema>, InferResponseType<typeof family[':workerId']['stop']['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof workerDestroyResultSchema>, InferResponseType<typeof family[':workerId']['destroy']['$post'], 200>>>,
    Assert<Mutual<z.infer<typeof workerDiffSchema>, InferResponseType<typeof family[':workerId']['diff']['$get'], 200>>>,
    Assert<Mutual<z.infer<typeof workerCancelWaitResultSchema>, InferResponseType<typeof family['cancel-wait']['$post'], 200>>>,
    Assert<Mutual<z.input<typeof workerCancelWaitRequestSchema>, Schema['/api/v1/delegation/cancel-wait']['$post']['input']['json']>>,
    Assert<Mutual<z.infer<typeof workerWaitResultSchema>, InferResponseType<typeof family.wait.$post, 200>>>,
    Assert<Mutual<z.infer<typeof workerDestroyResultSchema>, InferResponseType<typeof human.api.v1.runs[':id']['worker-destroy']['$post'], 200>>>,
    Assert<Mutual<z.input<typeof workerSpawnRequestSchema>, Schema['/api/v1/delegation/spawn']['$post']['input']['json']>>,
    Assert<Mutual<z.input<typeof workerWaitRequestSchema>, Schema['/api/v1/delegation/wait']['$post']['input']['json']>>,
    Assert<Mutual<z.input<typeof workerSteerRequestSchema>, Schema['/api/v1/delegation/:workerId/steer']['$post']['input']['json']>>,
    Assert<Mutual<z.input<typeof workerEmptyRequestSchema>, Schema['/api/v1/delegation/:workerId/stop']['$post']['input']['json']>>,
    Assert<Mutual<z.input<typeof workerEmptyRequestSchema>, Schema['/api/v1/delegation/:workerId/destroy']['$post']['input']['json']>>,
    Assert<Mutual<z.input<typeof workerParamsSchema>, Schema['/api/v1/delegation/:workerId']['$get']['input']['param']>>,
  ];
  it('rejects wider and narrower comparators', () => {
    const a: Mutual<{ a: string }, { a: string; b: string }> = 'schema-wider';
    const b: Mutual<{ a: string; b: string }, { a: string }> = 'route-wider';
    expect([a, b]).toEqual(['schema-wider', 'route-wider']);
  });
});
