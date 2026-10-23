import { hc } from 'hono/client'
import type { Hono } from 'hono'
import type { ClientRequestOptions, ClientResponse } from 'hono/client'
import type { SuccessStatusCode } from 'hono/utils/http-status'

/**
 * Typed HTTP client for /api/v1. Supply the service AppType as a type argument; this package has
 * no runtime service dependency. Example: createCezarClient<AppType>({ baseUrl }).
 */
export interface CezarClientOptions {
  /**
   * Where the service lives — `https://cezar.example.com`, or a path prefix behind a proxy.
   *
   * Defaults to `''` (same origin), which is the cockpit's own case: the service serves the
   * bundle and owns `/api/*` under the same authority, so a root-relative request is correct
   * and needs no configuration.
   */
  baseUrl?: string
  /**
   * Bearer token, attached as `Authorization: Bearer <token>` when set.
   *
   * Unset is the normal local case: a loopback cockpit has no auth to satisfy. It is the
   * opt-in remote-access mode that issues tokens.
   */
  token?: string
  /** Extra headers merged into every request (after the auth header, so they can override). */
  headers?: Record<string, string>
  /** Custom fetch — for tests (dispatch straight into a Hono app) or a wrapped transport. */
  fetch?: ClientRequestOptions['fetch']
}

/**
 * Build a typed client for a cezar service.
 *
 * `T` is the service's `AppType`. It is left unconstrained so that a JS consumer, or a
 * consumer that does not want the server package installed, still gets a working (untyped)
 * client instead of a type error.
 */
export function createCezarClient<
  // The three `any`s are Hono's own constraint on `hc` (Env, Schema, BasePath) — narrowing
  // them here would reject perfectly good app types. `Hono` as the default is the untyped
  // fallback: `createCezarClient()` with no type argument still returns a working client.
  T extends Hono<any, any, any> = Hono,
>(options: CezarClientOptions = {}): ReturnType<typeof hc<T>> {
  const { baseUrl = '', token, headers, fetch } = options
  return hc<T>(baseUrl, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(fetch ? { fetch } : {}),
  })
}

/**
 * Select every successful 2xx JSON response branch, including 201, while excluding error and
 * non-JSON branches.
 */
export type Ok<R> = R extends ClientResponse<infer T, infer S, 'json'>
  ? S extends SuccessStatusCode
    ? T
    : never
  : never

/**
 * Like Ok<R>, with a branded error type when no successful JSON branch exists. Mixed-format
 * routes keep their successful JSON branch.
 */
export type OkJson<R> = [Ok<R>] extends [never]
  ? { readonly __error: 'this route has no JSON response; read it as text instead' }
  : Ok<R>
