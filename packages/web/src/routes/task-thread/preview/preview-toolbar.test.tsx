import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewServer } from '@open-mercato/cezar-api-client'

import type { ThreadPreviewServer } from '../thread-state'

import { PreviewToolbar, type PreviewToolbarProps } from './preview-toolbar'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-10-02T10:00:00.000Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const web: PreviewServer = {
  port: 5173,
  command: 'npm run dev',
  label: 'web',
  registeredAt: '2026-10-02T09:00:00.000Z',
  answeredAtRegistration: false,
}
const storybook: PreviewServer = { ...web, port: 6006, label: 'storybook' }

function props(extra: Partial<PreviewToolbarProps> = {}): PreviewToolbarProps {
  return {
    url: 'http://localhost:5173/members',
    servers: [web],
    current: web,
    adopted: false,
    viewport: 'fit',
    navEnabled: true,
    stats: { fps: 24, kbps: 180, rttMs: 38, lastFrameAt: Date.now() },
    onNavigate: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onPickServer: vi.fn(),
    onViewport: vi.fn(),
    onCopyUrl: vi.fn(),
    onStop: vi.fn(),
    onClose: vi.fn(),
    ...extra,
  }
}

/** Radix opens its menus on pointerdown, not click. */
const openMenu = (trigger: HTMLElement) => fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })

describe('PreviewToolbar', () => {
  it('orders its controls: back, forward, reload, URL, viewport, stats, badge, More, close', () => {
    render(<PreviewToolbar {...props()} />)
    const order = [...document.querySelectorAll<HTMLElement>('[data-slot="preview-toolbar"] button, [data-slot="preview-toolbar"] input')].map(
      el => el.getAttribute('aria-label') ?? el.textContent,
    )
    expect(order).toEqual(['Back', 'Forward', 'Reload', 'Page address', 'Viewport size: Fit', 'More', 'Close preview'])
    expect(screen.getByText('24 fps · 180 KB/s · 38 ms')).toBeTruthy()
    expect(screen.getByText('Experimental')).toBeTruthy()
  })

  it('reads idle once a second passes without a frame', () => {
    render(<PreviewToolbar {...props()} />)
    expect(screen.queryByText('idle')).toBeNull()
    act(() => { vi.advanceTimersByTime(1100) })
    expect(screen.getByText('idle')).toBeTruthy()
    expect(screen.queryByText(/fps/)).toBeNull()
  })

  it('with two servers the switcher appears and the badge shrinks to its icon', () => {
    render(<PreviewToolbar {...props({ servers: [web, storybook] })} />)
    expect(screen.getByRole('button', { name: /^Server: web :5173/ })).toBeTruthy()
    const badge = screen.getByLabelText('Experimental')
    expect(badge.textContent).toBe('')
    expect(screen.queryByText('Experimental')).toBeNull()
    // The stats shrink to their dot; the numbers live in More.
    expect(screen.queryByText(/fps/)).toBeNull()
    expect(screen.getByLabelText('Preview is live')).toBeTruthy()
  })

  it('the switcher rows show each server as it is now', () => {
    const states = new Map<number, ThreadPreviewServer>([
      [5173, { kind: 'preview-server', id: 'a', server: web, state: 'up', stateAt: '2026-10-02T09:54:00.000Z' }],
      [6006, { kind: 'preview-server', id: 'b', server: storybook, state: 'exited', exitCode: 1 }],
    ])
    render(<PreviewToolbar {...props({ servers: [web, storybook], serverStates: states })} />)
    openMenu(screen.getByRole('button', { name: /^Server: web/ }))
    expect(screen.getByRole('menuitem', { name: /web.*:5173.*up · 6m/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /storybook.*:6006.*exited · code 1/ })).toBeTruthy()
  })

  it('shows no badge when the stage carries it instead (5.14)', () => {
    render(<PreviewToolbar {...props({ badge: false, stats: undefined, status: { tone: 'neutral', label: 'not supported' } })} />)
    expect(document.querySelector('[data-slot="preview-experimental"]')).toBeNull()
  })

  it('an adopted server also shrinks the badge, and says so inside the URL field', () => {
    render(<PreviewToolbar {...props({ adopted: true })} />)
    expect(screen.getByLabelText('Experimental').textContent).toBe('')
    expect(screen.getByText('Not started by cezar')).toBeTruthy()
  })

  it('the switcher picks a server and offers to type a URL instead', () => {
    const onPickServer = vi.fn()
    render(<PreviewToolbar {...props({ servers: [web, storybook], onPickServer })} />)
    openMenu(screen.getByRole('button', { name: /^Server: web/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /storybook/ }))
    expect(onPickServer).toHaveBeenCalledWith(6006)
    openMenu(screen.getByRole('button', { name: /^Server: web/ }))
    expect(screen.getByRole('menuitem', { name: 'Type a URL instead' })).toBeTruthy()
  })

  it('Stop is disabled with the reason on an adopted server', () => {
    const onStop = vi.fn()
    render(<PreviewToolbar {...props({ adopted: true, onStop })} />)
    openMenu(screen.getByRole('button', { name: 'More' }))
    const stop = screen.getByRole('menuitem', { name: /Stop server · web :5173/ })
    expect(stop.getAttribute('aria-disabled')).toBe('true')
    expect(within(stop).getByText("cezar didn't start this server, so it won't stop it. Stop it where it was started.")).toBeTruthy()
    fireEvent.click(stop)
    expect(onStop).not.toHaveBeenCalled()
  })

  it('Stop ends a cezar-started server', () => {
    const onStop = vi.fn()
    render(<PreviewToolbar {...props({ onStop })} />)
    openMenu(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop server · web :5173' }))
    expect(onStop).toHaveBeenCalledWith(5173)
  })

  it('More reloads without cache and copies the page URL', () => {
    const onReload = vi.fn()
    const onCopyUrl = vi.fn()
    render(<PreviewToolbar {...props({ onReload, onCopyUrl })} />)
    openMenu(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reload without cache' }))
    expect(onReload).toHaveBeenCalledWith(true)
    openMenu(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy page URL' }))
    expect(onCopyUrl).toHaveBeenCalledTimes(1)
  })

  it('offers no Stop item when the page is a typed URL with no registered server', () => {
    render(<PreviewToolbar {...props({ current: undefined })} />)
    openMenu(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('menuitem', { name: /Stop server/ })).toBeNull()
  })

  it('the viewport menu lists sizes only and picks one', () => {
    const onViewport = vi.fn()
    render(<PreviewToolbar {...props({ onViewport })} />)
    openMenu(screen.getByRole('button', { name: 'Viewport size: Fit' }))
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Fitpane size', '390 × 844', '820 × 1180', '1440 × 900'])
    fireEvent.click(screen.getByRole('menuitem', { name: '1440 × 900' }))
    expect(onViewport).toHaveBeenCalledWith({ w: 1440, h: 900 })
  })

  it('hides the viewport menu on phones and moves close into More', () => {
    const onClose = vi.fn()
    render(<PreviewToolbar {...props({ compact: true, onClose })} />)
    expect(screen.queryByRole('button', { name: /^Viewport size/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close preview' })).toBeNull()
    openMenu(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close preview' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the Session control only when the pane replaces the transcript', () => {
    const onSession = vi.fn()
    const { rerender } = render(<PreviewToolbar {...props()} />)
    expect(screen.queryByRole('button', { name: 'Session' })).toBeNull()
    rerender(<PreviewToolbar {...props({ onSession })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Session' }))
    expect(onSession).toHaveBeenCalledTimes(1)
  })

  it('submits the typed address on Enter and shows the full URL while focused', () => {
    const onNavigate = vi.fn()
    render(<PreviewToolbar {...props({ onNavigate })} />)
    const field = screen.getByRole('textbox', { name: 'Page address' }) as HTMLInputElement
    expect(field.value).toBe('localhost:5173/members')
    fireEvent.focus(field)
    expect(field.value).toBe('http://localhost:5173/members')
    fireEvent.change(field, { target: { value: '3000' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith('3000')
  })

  it('shows the status label in place of the stats outside a stream', () => {
    render(<PreviewToolbar {...props({ stats: undefined, status: { tone: 'danger', label: 'server exited' } })} />)
    expect(screen.getByText('server exited')).toBeTruthy()
  })

  it('disables the navigation controls until a page streams', () => {
    render(<PreviewToolbar {...props({ navEnabled: false, stats: undefined })} />)
    for (const name of ['Back', 'Forward', 'Reload']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
