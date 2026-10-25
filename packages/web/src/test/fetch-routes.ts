/**
 * A route table for a mocked `fetch` (hearsay-tools/cezarion#1615). Each route names a method and
 * a path; the first route that matches a request answers it, in table order. The test keeps its
 * own `vi.stubGlobal('fetch', …)`, body parsing and request log, and builds the table inside it,
 * so a route can close over the test's fixtures and over any state a stateful mock keeps.
 */

/** What a route sees of one request. A test passes its own record, which may carry more. */
export type RoutedRequest = { method: string; url: string }

/** A route's answer. `undefined` passes the request on to the next route. */
export type RouteAnswer = Response | Promise<Response> | undefined

export type FetchRoute<Request extends RoutedRequest = RoutedRequest> = {
  /** Absent matches every method. */
  method?: string
  /** A string matches the whole URL, query string included; a RegExp is executed against it. */
  path: string | RegExp
  /** `match` is the RegExp's result, and `null` for a string path. */
  respond: (request: Request, match: RegExpExecArray | null) => RouteAnswer
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** A route's fixture: a payload answered as JSON, or a handler for a delayed or failing answer. */
export type JsonFixture<T> = T | (() => Promise<Response>)

/** Call `fixture` when it is a handler; otherwise send it as JSON with `status`. */
export function answerFixture<T>(fixture: JsonFixture<T>, status = 200): Response | Promise<Response> {
  return typeof fixture === 'function' ? (fixture as () => Promise<Response>)() : jsonResponse(fixture, status)
}

/** Answer `request` from the first matching route that answers, or from `unmatched`. */
export function answerFromRoutes<Request extends RoutedRequest>(
  routes: readonly FetchRoute<Request>[],
  request: Request,
  unmatched: (request: Request) => Response | Promise<Response>,
): Response | Promise<Response> {
  for (const route of routes) {
    if (route.method !== undefined && route.method !== request.method) continue
    const match = typeof route.path === 'string' ? null : route.path.exec(request.url)
    if (typeof route.path === 'string' ? route.path !== request.url : match === null) continue
    const answer = route.respond(request, match)
    if (answer !== undefined) return answer
  }
  return unmatched(request)
}
