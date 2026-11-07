import { hc, type InferResponseType } from 'hono/client';
import type { ExtractSchema } from 'hono/types';
import { expect, it } from 'vitest';
import type { HomeRecovery, HomeRecoveryAction } from '@open-mercato/cezar-contract/home-recovery';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type Schema = ExtractSchema<AppType>;
type Recovery = typeof client.api.v1.home.recovery;
type _Checks = [
  Assert<Mutual<HomeRecovery, InferResponseType<Recovery['$get'], 200>>>,
  Assert<Mutual<HomeRecovery, InferResponseType<Recovery['restore']['$post'], 200>>>,
  Assert<Mutual<HomeRecovery, InferResponseType<Recovery['accept']['$post'], 200>>>,
  Assert<Mutual<HomeRecoveryAction, Schema['/api/v1/home/recovery/restore']['$post']['input']['json']>>,
  Assert<Mutual<HomeRecoveryAction, Schema['/api/v1/home/recovery/accept']['$post']['input']['json']>>,
];

it('keeps recovery responses exact and action bodies typed through AppType', () => {
  const wider: Mutual<{ a: string }, { a: string; b: string }> = false;
  const narrower: Mutual<{ a: string; b: string }, { a: string }> = false;
  expect([wider, narrower]).toEqual([false, false]);
});
