import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_SECTIONS_STORAGE_KEY as STORAGE_KEY } from './sidebar-collapse'
import { useSidebarSections } from './use-sidebar-sections'

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
const mount = (projectId: string | null) => renderHook(
  ({ projectId }) => useSidebarSections(projectId),
  { initialProps: { projectId }, wrapper },
)

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe('pending sidebar section toggles', () => {
  it('uses the saved canonical choices when discovery completes without user input', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ '["boot","Finished"]': true }))
    const hook = mount(null)
    expect(hook.result.current.isCollapsed('Finished')).toBe(false)
    hook.rerender({ projectId: 'boot' })
    expect(hook.result.current.isCollapsed('Finished')).toBe(true)
    expect(stored()).toEqual({ '["boot","Finished"]': true })
  })

  it('adopts a pre-health fold under the canonical project, preserving unrelated stored sections on remount', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      '["other","Working"]': true,
      '["other","Finished"]': false,
      '["boot","Needs you"]': true,
    }))
    const hook = mount(null)
    act(() => hook.result.current.toggle('Finished'))
    expect(hook.result.current.isCollapsed('Finished')).toBe(true)
    expect(stored()).not.toHaveProperty('[null,"Finished"]')

    hook.rerender({ projectId: 'boot' })
    expect(hook.result.current.isCollapsed('Finished')).toBe(true)
    expect(stored()).toEqual({
      '["other","Working"]': true,
      '["other","Finished"]': false,
      '["boot","Needs you"]': true,
      '["boot","Finished"]': true,
    })
    hook.unmount()
    expect(mount('boot').result.current.isCollapsed('Finished')).toBe(true)
  })

  it('preserves an explicit toggle back open rather than falling back to a stored fold', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ '["boot","Finished"]': true }))
    const hook = mount(null)
    act(() => { hook.result.current.toggle('Finished'); hook.result.current.toggle('Finished') })
    expect(hook.result.current.isCollapsed('Finished')).toBe(false)
    hook.rerender({ projectId: 'boot' })
    expect(hook.result.current.isCollapsed('Finished')).toBe(false)
    expect(stored()).toEqual({ '["boot","Finished"]': false })
  })

  it('synchronizes mounted copies on resolution without an untouched copy overwriting the pending choice', () => {
    const desktop = mount(null)
    const mobile = mount(null)
    act(() => desktop.result.current.toggle('Working'))
    desktop.rerender({ projectId: 'boot' })
    mobile.rerender({ projectId: 'boot' })
    expect(desktop.result.current.isCollapsed('Working')).toBe(true)
    expect(mobile.result.current.isCollapsed('Working')).toBe(true)
    act(() => mobile.result.current.toggle('Working'))
    expect(desktop.result.current.isCollapsed('Working')).toBe(false)
    expect(stored()).toEqual({ '["boot","Working"]': false })
  })

  it('retains pending input across another tab update, then keeps cross-tab updates authoritative after adoption', () => {
    const hook = mount(null)
    act(() => hook.result.current.toggle('Finished'))
    act(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ '["other","Working"]': true }))
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
    })
    expect(hook.result.current.isCollapsed('Finished')).toBe(true)
    hook.rerender({ projectId: 'boot' })
    expect(stored()).toEqual({ '["other","Working"]': true, '["boot","Finished"]': true })
    act(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ '["boot","Finished"]': false }))
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
    })
    expect(hook.result.current.isCollapsed('Finished')).toBe(false)
  })

  it('does not transfer an adopted choice between known projects or replay it on returning', () => {
    const hook = mount(null)
    act(() => hook.result.current.toggle('Finished'))
    hook.rerender({ projectId: 'boot' })
    hook.rerender({ projectId: 'other' })
    expect(hook.result.current.isCollapsed('Finished')).toBe(false)
    act(() => hook.result.current.toggle('Working'))
    hook.rerender({ projectId: 'boot' })
    expect(hook.result.current.isCollapsed('Finished')).toBe(true)
    expect(hook.result.current.isCollapsed('Working')).toBe(false)
    act(() => hook.result.current.toggle('Finished'))
    hook.rerender({ projectId: 'other' })
    hook.rerender({ projectId: 'boot' })
    expect(hook.result.current.isCollapsed('Finished')).toBe(false)
    expect(stored()).toEqual({ '["boot","Finished"]': false, '["other","Working"]': true })
  })

  it('shares an adopted fold with a mounted canonical copy even when storage rejects writes', () => {
    const desktop = mount(null)
    const mobile = mount('boot')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable') })
    act(() => desktop.result.current.toggle('Finished'))
    desktop.rerender({ projectId: 'boot' })
    expect(desktop.result.current.isCollapsed('Finished')).toBe(true)
    expect(mobile.result.current.isCollapsed('Finished')).toBe(true)
  })

  it('merges different pending sections from copies that resolve together', () => {
    const copies = renderHook(({ projectId }: { projectId: string | null }) => ({
      desktop: useSidebarSections(projectId),
      mobile: useSidebarSections(projectId),
    }), { initialProps: { projectId: null as string | null }, wrapper })
    act(() => {
      copies.result.current.desktop.toggle('Finished')
      copies.result.current.mobile.toggle('Working')
    })
    copies.rerender({ projectId: 'boot' })
    for (const copy of Object.values(copies.result.current)) {
      expect(copy.isCollapsed('Finished')).toBe(true)
      expect(copy.isCollapsed('Working')).toBe(true)
    }
    expect(stored()).toEqual({ '["boot","Finished"]': true, '["boot","Working"]': true })
  })
})
