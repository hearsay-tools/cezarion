import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { voiceDecisionSchema, voiceOutcomeResponseSchema } from '@open-mercato/cezar-contract/voice';
import type { AppType } from './app-type.ts';

/**
 * `packages/contract/src/voice.ts` must describe EXACTLY what the voice routes send, in both
 * directions (same guard and reasoning as `contract-parity.automations.test.ts`). Compile-time:
 * `tsc -p tsconfig.test.json` enforces it. The `it()` keeps the file visible as a test.
 */
describe('voice contract schemas match the routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Assert<T extends true> = T;

  type Decide200 = InferResponseType<typeof client.api.v1.voice.decide.$post, 200>;
  type Outcome200 = InferResponseType<typeof client.api.v1.voice.outcome.$post, 200>;

  type _Checks = [
    Assert<Mutual<z.infer<typeof voiceDecisionSchema>, Decide200>>,
    Assert<Mutual<z.infer<typeof voiceOutcomeResponseSchema>, Outcome200>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    const optionality: Mutual<{ a: string }, { a?: string }> = 'route-is-wider';
    expect([wider, narrower, optionality]).toEqual(['schema-is-wider', 'route-is-wider', 'route-is-wider']);
  });
});
