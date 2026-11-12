import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from './app'
import { useHomeRecoverySubscription } from './api/home-recovery'

const passthrough = vi.hoisted(() => ({ wrap: ({ children }: { children: ReactNode }) => children }))
vi.mock('./api/home-recovery', () => ({ useHomeRecoverySubscription: vi.fn() }))
vi.mock('./api/global-events', () => ({ GlobalEventsProvider: passthrough.wrap }))
vi.mock('./lib/cez-idle', () => ({ attachQueryIdle: () => { return () => {} } }))
vi.mock('./components/appearance-provider', () => ({ AppearanceProvider: passthrough.wrap }))
vi.mock('./components/theme-provider', () => ({ ThemeProvider: passthrough.wrap }))
vi.mock('./components/reference-status', () => ({ ReferenceStatusRegistry: passthrough.wrap }))
vi.mock('./components/app-shell-container', () => ({ AppShellContainer: passthrough.wrap }))
vi.mock('./components/last-location-controller', () => ({ LastLocationController: () => null }))
vi.mock('./components/run-notifications', () => ({ RunNotifications: () => null }))
vi.mock('./components/ui/toaster', () => ({ Toaster: () => null }))
vi.mock('./routes', () => ({ AppRoutes: () => <div>Active route</div>, matchProjectRoute: () => null }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('mounts one home recovery controller above every routed page', () => {
  render(<App />)
  expect(screen.getByText('Active route')).toBeTruthy()
  expect(useHomeRecoverySubscription).toHaveBeenCalledTimes(1)
})
