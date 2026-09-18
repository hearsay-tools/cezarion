import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppErrorBoundary } from './app-error-boundary'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

function Boom({ message }: { message: string }): never {
  throw new Error(message)
}

describe('AppErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error itself, and the boundary logs its own line. Both are noise
    // here, and both are deliberate in the browser.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders its children while nothing throws', () => {
    const { container } = render(
      <AppErrorBoundary>
        <p data-slot="child">the cockpit</p>
      </AppErrorBoundary>,
    )

    expect(container.querySelector('[data-slot="child"]')?.textContent).toBe('the cockpit')
    expect(container.querySelector('[data-slot="app-error"]')).toBeNull()
  })

  /** The regression this boundary exists for: without it React 19 unmounts the root and the
   *  document is left empty, which every cockpit wait reports exactly as a slow page would. */
  it('replaces an unmounted root with a failure surface when a child render throws', () => {
    const { container } = render(
      <AppErrorBoundary>
        <Boom message="rendered a replaced text node" />
      </AppErrorBoundary>,
    )

    const surface = container.querySelector('[data-slot="app-error"]')
    expect(surface).not.toBeNull()
    expect(container.childElementCount).toBeGreaterThan(0)
    expect(surface?.getAttribute('role')).toBe('alert')
    expect(screen.getByRole('heading').textContent).toBe('The cockpit hit an error')
    expect(container.querySelector('[data-slot="app-error-detail"]')?.textContent).toBe(
      'rendered a replaced text node',
    )
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  it('reports the caught error and its component stack to the console', () => {
    render(
      <AppErrorBoundary>
        <Boom message="boom" />
      </AppErrorBoundary>,
    )

    const logged = vi.mocked(console.error).mock.calls
    const ours = logged.find((call) => call[0] === 'cezar cockpit: uncaught render error')
    expect(ours, JSON.stringify(logged.map((call) => call[0]))).toBeDefined()
    expect((ours?.[1] as Error).message).toBe('boom')
  })

  it('shows a message for a thrown non-Error too', () => {
    function ThrowString(): never {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a third-party throw is not always an Error.
      throw 'a bare string'
    }
    const { container } = render(
      <AppErrorBoundary>
        <ThrowString />
      </AppErrorBoundary>,
    )

    expect(container.querySelector('[data-slot="app-error-detail"]')?.textContent).toBe('a bare string')
  })
})
