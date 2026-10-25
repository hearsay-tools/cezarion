import { describe, expect, it } from 'vitest'

import { answerFixture, answerFromRoutes, jsonResponse, type FetchRoute } from './fetch-routes'

const notFound = ({ method, url }: { method: string; url: string }) =>
  jsonResponse({ error: `unmocked ${method} ${url}` }, 404)

async function read(answer: Response | Promise<Response>) {
  const response = await answer
  return { status: response.status, body: (await response.json()) as unknown }
}

describe('answerFromRoutes', () => {
  it('answers from the first route that matches, in table order', async () => {
    const routes: FetchRoute[] = [
      { path: '/api/v1/repo', respond: () => jsonResponse('first') },
      { path: '/api/v1/repo', respond: () => jsonResponse('second') },
    ]
    expect(await read(answerFromRoutes(routes, { method: 'GET', url: '/api/v1/repo' }, notFound))).toEqual({ status: 200, body: 'first' })
  })

  it('matches every method when a route names none, and only its own method when it names one', async () => {
    const routes: FetchRoute[] = [
      { method: 'PUT', path: '/api/v1/config', respond: () => jsonResponse('put') },
      { path: '/api/v1/health', respond: ({ method }) => jsonResponse(method) },
    ]
    expect(await read(answerFromRoutes(routes, { method: 'POST', url: '/api/v1/health' }, notFound))).toEqual({ status: 200, body: 'POST' })
    expect(await read(answerFromRoutes(routes, { method: 'PUT', url: '/api/v1/config' }, notFound))).toEqual({ status: 200, body: 'put' })
    expect(await read(answerFromRoutes(routes, { method: 'GET', url: '/api/v1/config' }, notFound))).toEqual({
      status: 404,
      body: { error: 'unmocked GET /api/v1/config' },
    })
  })

  it('compares a string path with the whole URL, query string included', async () => {
    const routes: FetchRoute[] = [{ path: '/api/v1/models?runner=codex', respond: () => jsonResponse('codex') }]
    expect(await read(answerFromRoutes(routes, { method: 'GET', url: '/api/v1/models?runner=codex' }, notFound))).toEqual({ status: 200, body: 'codex' })
    expect((await answerFromRoutes(routes, { method: 'GET', url: '/api/v1/models' }, notFound)).status).toBe(404)
    expect((await answerFromRoutes(routes, { method: 'GET', url: '/api/v1/models?runner=claude' }, notFound)).status).toBe(404)
  })

  it('hands a RegExp route its match, and a string route none', async () => {
    const seen: Array<RegExpExecArray | null> = []
    const routes: FetchRoute[] = [
      {
        path: '/api/v1/projects',
        respond: (_request, match) => {
          seen.push(match)
          return jsonResponse('list')
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/p\/([^/]+)\/runs\/([^/]+)\/archive$/,
        respond: (_request, match) => {
          seen.push(match)
          return jsonResponse({ projectId: match?.[1], id: match?.[2] })
        },
      },
    ]
    expect(await read(answerFromRoutes(routes, { method: 'POST', url: '/api/v1/p/web/runs/r1/archive' }, notFound))).toEqual({
      status: 200,
      body: { projectId: 'web', id: 'r1' },
    })
    await answerFromRoutes(routes, { method: 'GET', url: '/api/v1/projects' }, notFound)
    expect(seen.map((match) => match?.[0] ?? null)).toEqual(['/api/v1/p/web/runs/r1/archive', null])
    expect((await answerFromRoutes(routes, { method: 'POST', url: '/api/v1/p/web/runs/r1/archive/extra' }, notFound)).status).toBe(404)
  })

  it('passes the request on when a route answers undefined, down to the unmatched answer', async () => {
    let projects: unknown
    const routes: FetchRoute[] = [
      { method: 'GET', path: '/api/v1/projects', respond: () => (projects ? jsonResponse(projects) : undefined) },
      { path: /^\/api\/v1\/projects/, respond: () => jsonResponse('fallthrough') },
    ]
    expect(await read(answerFromRoutes(routes, { method: 'GET', url: '/api/v1/projects' }, notFound))).toEqual({ status: 200, body: 'fallthrough' })
    projects = { projects: [] }
    expect(await read(answerFromRoutes(routes, { method: 'GET', url: '/api/v1/projects' }, notFound))).toEqual({ status: 200, body: { projects: [] } })
    projects = undefined
    expect(await read(answerFromRoutes(routes.slice(0, 1), { method: 'GET', url: '/api/v1/projects' }, notFound))).toEqual({
      status: 404,
      body: { error: 'unmocked GET /api/v1/projects' },
    })
  })
})

describe('answerFixture', () => {
  it('sends a payload as JSON with the given status', async () => {
    const response = await answerFixture({ id: 'r1' }, 201)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await read(response)).toEqual({ status: 201, body: { id: 'r1' } })
    expect(await read(answerFixture(['main']))).toEqual({ status: 200, body: ['main'] })
  })

  it('calls a handler for its own delayed or failing answer and ignores the status', async () => {
    let release!: () => void
    const answer = answerFixture(() => new Promise<Response>((resolve) => {
      release = () => resolve(jsonResponse({ error: 'no repo' }, 404))
    }), 201)
    release()
    expect(await read(answer)).toEqual({ status: 404, body: { error: 'no repo' } })
  })
})
