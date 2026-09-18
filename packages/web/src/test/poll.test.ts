// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { pollFor, waitForHealth, waitForStatus } from '../../e2e/poll'

/**
 * The shared spec-side poll (#416). It replaced 34 copies, one of which — `queued-stack`'s
 * `getRun` — retried five times through a transient fetch failure before giving up. That
 * guarantee is what these cases pin, because losing it is exactly the way a consolidation goes
 * wrong: every spec keeps working until a connection resets mid-run, and then one aborts where
 * it used to poll on.
 *
 * Nothing here starts a server or a browser; `fetch` is stubbed, and every poll runs with a
 * 0 ms interval so the suite stays the fast unit gate.
 */
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const fast = { intervalMs: 0 }

describe('pollFor', () => {
  it('returns the first answer that is not undefined, and stops probing', async () => {
    const probe = vi.fn<() => string | undefined>().mockReturnValueOnce(undefined).mockReturnValue('ready')
    await expect(pollFor(probe, () => 'never', fast)).resolves.toBe('ready')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('treats a throwing probe as "not yet" and keeps polling', async () => {
    let attempt = 0
    const probe = () => {
      attempt += 1
      if (attempt < 3) throw new Error('ECONNRESET')
      return 'ready'
    }
    await expect(pollFor(probe, () => 'never', fast)).resolves.toBe('ready')
    expect(attempt).toBe(3)
  })

  it('reports the last probe error alongside the failure, and carries it as the cause', async () => {
    const boom = new Error('GET run answered 503')
    await expect(
      pollFor(
        () => {
          throw boom
        },
        () => 'cezar e2e: run never settled',
        { ...fast, tries: 3 },
      ),
    ).rejects.toThrow('cezar e2e: run never settled (last probe error: GET run answered 503)')

    const raised = await pollFor(() => {
      throw boom
    }, () => 'x', { ...fast, tries: 1 }).catch((error: unknown) => error)
    expect((raised as Error).cause).toBe(boom)
  })

  it('says only what failed when the probe never threw — an empty poll is not an error', async () => {
    const raised = await pollFor(() => undefined, () => 'cezar e2e: nothing appeared', { ...fast, tries: 2 }).catch(
      (error: unknown) => error,
    )
    expect((raised as Error).message).toBe('cezar e2e: nothing appeared')
    expect((raised as Error).cause).toBeUndefined()
  })

  it('gives up after `tries` probes', async () => {
    const probe = vi.fn(() => undefined)
    await expect(pollFor(probe, () => 'out', { ...fast, tries: 4 })).rejects.toThrow('out')
    expect(probe).toHaveBeenCalledTimes(4)
  })
})

describe('waitForStatus', () => {
  it('polls through a rejected fetch until the run reaches a wanted status', async () => {
    const answers: Array<() => Promise<Response>> = [
      () => Promise.reject(new Error('ECONNRESET')),
      () => Promise.resolve(new Response(JSON.stringify({ status: 'running' }), { status: 200 })),
      () => Promise.resolve(new Response(JSON.stringify({ status: 'review' }), { status: 200 })),
    ]
    vi.stubGlobal('fetch', vi.fn(() => (answers.shift() ?? (() => Promise.reject(new Error('exhausted'))))()))

    await expect(waitForStatus('http://127.0.0.1:1', 'run-1', ['review', 'done'], fast)).resolves.toBe('review')
  })

  it('polls through a 5xx rather than aborting on it', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1
        return Promise.resolve(
          call < 3
            ? new Response('<html>gateway</html>', { status: 502 })
            : new Response(JSON.stringify({ status: 'done' }), { status: 200 }),
        )
      }),
    )

    await expect(waitForStatus('http://127.0.0.1:1', 'run-1', ['done'], fast)).resolves.toBe('done')
    expect(call).toBe(3)
  })

  it('names the run, the wanted statuses and the last server answer when it runs out', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 503 }))))

    await expect(waitForStatus('http://127.0.0.1:1', 'run-1', ['done'], { ...fast, tries: 2 })).rejects.toThrow(
      'cezar e2e: run run-1 never reached status "done" (last probe error: GET run run-1 answered 503)',
    )
  })
})

describe('waitForHealth', () => {
  it('polls until the server answers, and does not report the connection refusals on the way', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1
        return call < 3 ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(new Response('', { status: 200 }))
      }),
    )

    await expect(waitForHealth('http://127.0.0.1:1', 'the fixture server', fast)).resolves.toBeUndefined()
    expect(call).toBe(3)
  })

  it('names what never answered, without an ECONNREFUSED tail nobody needs', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))

    await expect(
      waitForHealth('http://127.0.0.1:1', 'the worst-case fixture server', { ...fast, tries: 2 }),
    ).rejects.toThrow('cezar e2e: the worst-case fixture server never answered at http://127.0.0.1:1')
  })
})
