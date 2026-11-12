import { describe, expectTypeOf, it } from 'vitest';
import type { CheckoutProgressEvent, RunEvent as WebRunEvent, UiEvent as WebUiEvent } from '@open-mercato/cezar-api-client';
import type { UiEvent } from '../core/ui-events.ts';
import type { RunEvent } from '../runs/store.ts';

/**
 * What is left of the hand-written mirror — and only that.
 *
 * This file used to pin 58 shapes, because every response type was declared twice: once by the
 * server and once by hand in the api-client. `@open-mercato/cezar-contract` removed the
 * duplication, and `contract-parity*.test.ts` now checks each schema against the ROUTE it
 * describes, which is a strictly better comparison — the route IS the wire, whereas the pairs
 * below compare against the server's internal types.
 *
 * That distinction is why the retired assertions could not simply be repointed at the contract.
 * The contract describes what a client receives, and `JSON.stringify` drops an undefined value,
 * so `foo?: T` there is correct even where the server's in-memory type says `foo: T | undefined`.
 * `ExactKeys` reads that as drift; it is not — the two are describing different things. Pointing
 * the old guard at the contract would have manufactured failures and taught the next person to
 * loosen it.
 *
 * Two shapes genuinely cannot be derived from a route, so they stay hand-mirrored and stay
 * guarded here. Both are SSE FRAME payloads delivered over `text/event-stream`, which Hono types
 * as a string body — the frame shape is invisible to `InferResponseType`.
 *
 * The v2 `UiEvent` vocabulary rides inside those frames. `packages/api-client/src/protocol/
 * ui-events.ts` is a hand-kept copy of `core/ui-events.ts`, so it has a pair here too.
 */
describe('the shapes that cannot come from a route are still mirrored faithfully', () => {
  /** Mutual assignability. `[…]` wrappers stop a naked union from distributing. */
  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  /** Key-set equality — `Exact` alone is blind to a missing OPTIONAL property (#472). */
  type ExactKeys<A, B> = Exact<keyof A, keyof B>;

  /**
   * A type as JSON carries it: an optional property never holds `undefined`, at any depth. The
   * api-client copy lets three optional fields take an explicit `undefined` for its callers
   * (`UiToolItem.output`, `.error`, `UiHookItem.name`); the wire drops such a value.
   */
  type Wire<T> = T extends readonly (infer E)[] ? Wire<E>[] : T extends object ? { [K in keyof T]: Wire<Exclude<T[K], undefined>> } : T;
  /** The `type` or `kind` of a union member, so one member's keys do not stand in for another's. */
  type Tag<T> = T extends { type: infer D extends string } ? `<${D}>` : T extends { kind: infer D extends string } ? `<${D}>` : '';
  /** Every key at every depth as a path, optional keys included: `<item.completed>.item<hook>.name`. */
  type KeyPaths<T> = T extends readonly (infer E)[] ? `[]${KeyPaths<E>}`
    : T extends object ? { [K in keyof T & string]-?: `${Tag<T>}.${K}` | `${Tag<T>}.${K}${KeyPaths<T[K]>}` }[keyof T & string] : never;


  /**
   * No `ExactKeys` pair here, deliberately. `RunEvent` carries a string index signature, and
   * TypeScript reports `keyof` of an interface with one as `string | number` while the zod loose
   * object infers `string` — a difference in how the two are spelled, not in what they accept
   * (`Exact` above passes both ways). `ExactKeys` exists to catch a MISSING OPTIONAL property
   * (#472), which cannot happen on a type that already accepts arbitrary keys, so pinning it
   * here would fail forever while proving nothing.
   */
  type _KeysNotApplicable = ExactKeys<{ a: 1 }, { a: 1 }>;

  // Compile-time only: `npm run typecheck` fails when a mirror drifts.
  it('holds every pair', () => {
    /** `GET /api/v1/runs/:id/events` and `/api/v1/events` — the run event stream. */
    expectTypeOf<Exact<RunEvent, WebRunEvent>>().toEqualTypeOf<true>();
    /** The v2 events inside that stream, against the api-client's hand-kept copy. */
    expectTypeOf<Exact<Wire<UiEvent>, Wire<WebUiEvent>>>().toEqualTypeOf<true>();
    /** `Exact` is blind to a missing optional property, and `UiEvent` is a union, so compare key paths. */
    expectTypeOf<Exact<KeyPaths<UiEvent>, KeyPaths<WebUiEvent>>>().toEqualTypeOf<true>();
  });

  it('records why the other SSE shape has no pair here', () => {
    // `checkout-progress` frames are assembled inline in the workspace-events handler, so there
    // is no server-side type to pin the mirror against. Noted so its absence above reads as
    // deliberate rather than as an oversight.
    expectTypeOf<'cloning' | 'done' | 'error'>().toExtend<CheckoutProgressEvent['phase']>();
  });
});
