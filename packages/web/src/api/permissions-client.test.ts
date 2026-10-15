import { afterEach, describe, expect, it, vi } from 'vitest'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { ApiError, decidePermission } from './client'
afterEach(() => { vi.unstubAllGlobals(); setApiScope(null) })

describe('native permission API', () => {
  it.each([null, 'project-b'])('posts only exact request and option IDs in scope %s', async scope => {
    setApiScope(scope)
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ delivered: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(decidePermission('r1', { requestId: 'request-a', optionId: 'once' })).resolves.toEqual({ delivered: true })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(scope ? '/api/v1/p/project-b/runs/r1/permissions' : '/api/v1/runs/r1/permissions')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ requestId: 'request-a', optionId: 'once' })
    expect(init.credentials).toBe('include')
  })
  it('surfaces stale approval 409 without sending text or starting a new turn', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Approval expired' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(decidePermission('r1', { requestId: 'stale', optionId: 'once' })).rejects.toMatchObject({ status: 409, message: 'Approval expired' } satisfies Partial<ApiError>)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
