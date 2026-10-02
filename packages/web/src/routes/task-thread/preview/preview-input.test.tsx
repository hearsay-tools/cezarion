import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import type { PreviewClientMessage } from '@open-mercato/cezar-api-client'

import { useKeyShortcut } from '@/lib/use-command-shortcut'

import { PreviewInput } from './preview-input'

const frames: FrameRequestCallback[] = []

beforeEach(() => {
  frames.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = () => undefined })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The layer, with the box the stage would give it: its top-left corner at (left, top). */
function mount(scale = 1, box = { left: 0, top: 0 }) {
  const send = vi.fn<(message: PreviewClientMessage) => void>()
  render(<PreviewInput scale={scale} send={send} />)
  const layer = screen.getByRole('application')
  layer.getBoundingClientRect = () => ({ ...box, right: 0, bottom: 0, width: 0, height: 0, x: box.left, y: box.top, toJSON: () => ({}) })
  return { layer, send }
}

describe('PreviewInput', () => {
  it('a click on a viewport scaled to 83% lands on the same page pixel', () => {
    const { layer, send } = mount(0.83, { left: 20, top: 40 })
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: 'mouse', clientX: 120, clientY: 140, button: 0, buttons: 1 })
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: 'mouse', clientX: 120, clientY: 140, button: 0, buttons: 0 })
    // (120 - 20) / 0.83 = 120.48 and (140 - 40) / 0.83 = 120.48: the page pixel under the pointer.
    expect(send.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ t: 'mouse', type: 'mousePressed', x: 120, y: 120, button: 'left' }),
      expect.objectContaining({ t: 'mouse', type: 'mouseReleased', x: 120, y: 120, button: 'left' }),
    ])
  })

  it('reads the scale it is given at each event, not the one it mounted with', () => {
    const send = vi.fn<(message: PreviewClientMessage) => void>()
    const { rerender } = render(<PreviewInput scale={1} send={send} />)
    rerender(<PreviewInput scale={0.5} send={send} />)
    fireEvent.pointerDown(screen.getByRole('application'), { pointerId: 1, pointerType: 'mouse', clientX: 50, clientY: 50, buttons: 1 })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ x: 100, y: 100 }))
  })

  it('sends one mouse move per frame, the newest, and flushes it before a release', () => {
    const { layer, send } = mount()
    fireEvent.pointerMove(layer, { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10 })
    fireEvent.pointerMove(layer, { pointerId: 1, pointerType: 'mouse', clientX: 30, clientY: 30 })
    expect(send).not.toHaveBeenCalled()
    frames[0]!(0)
    expect(send.mock.calls.map(call => call[0])).toEqual([expect.objectContaining({ type: 'mouseMoved', x: 30, y: 30 })])

    send.mockClear()
    fireEvent.pointerMove(layer, { pointerId: 1, pointerType: 'mouse', clientX: 50, clientY: 50, buttons: 1 })
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: 'mouse', clientX: 60, clientY: 60 })
    expect(send.mock.calls.map(call => (call[0] as { type: string }).type)).toEqual(['mouseMoved', 'mouseReleased'])
    frames.at(-1)!(0)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('scrolls the page with a touch drag and clicks with a tap', () => {
    const { layer, send } = mount()
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 })
    fireEvent.pointerMove(layer, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 240 })
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 240 })
    expect(send.mock.calls.map(call => call[0])).toEqual([expect.objectContaining({ type: 'mouseWheel', deltaY: 60 })])

    send.mockClear()
    fireEvent.pointerDown(layer, { pointerId: 2, pointerType: 'touch', clientX: 50, clientY: 50 })
    fireEvent.pointerUp(layer, { pointerId: 2, pointerType: 'touch', clientX: 50, clientY: 50 })
    expect(send.mock.calls.map(call => (call[0] as { type: string }).type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('forwards the wheel and keeps the cockpit from scrolling', () => {
    const { layer, send } = mount(0.5)
    const notPrevented = fireEvent.wheel(layer, { clientX: 10, clientY: 20, deltaY: 40 })
    expect(notPrevented).toBe(false)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'mouseWheel', x: 20, y: 40, deltaY: 80 }))
  })

  it('swallows the page-bound keys and lets Ctrl+V and Ctrl+K through', () => {
    const { layer, send } = mount()
    expect(fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 })).toBe(false)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ t: 'key', type: 'keyDown', text: 'a' }))
    expect(fireEvent.keyUp(layer, { key: 'a', code: 'KeyA', keyCode: 65 })).toBe(false)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ t: 'key', type: 'keyUp' }))

    send.mockClear()
    expect(fireEvent.keyDown(layer, { key: 'v', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(layer, { key: 'k', metaKey: true })).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps the keys the page receives away from the cockpit window shortcuts', () => {
    const newTask = vi.fn()
    const quickReply = vi.fn()
    // The two window-global listeners that fire on a bare key: `c` opens a new task, and the
    // composer sends a canned approval on Alt+A / Alt+C (matched by `event.code`).
    function CockpitShortcuts() {
      useKeyShortcut('c', newTask)
      return null
    }
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && (event.code === 'KeyA' || event.code === 'KeyC')) quickReply(event.code)
    }
    window.addEventListener('keydown', onWindowKeyDown)
    onTestFinished(() => window.removeEventListener('keydown', onWindowKeyDown))
    const send = vi.fn<(message: PreviewClientMessage) => void>()
    render(<><CockpitShortcuts /><PreviewInput scale={1} send={send} /></>)
    const layer = screen.getByRole('application')

    fireEvent.keyDown(layer, { key: 'c', code: 'KeyC', keyCode: 67 })
    fireEvent.keyDown(layer, { key: 'å', code: 'KeyA', keyCode: 65, altKey: true })
    expect(send).toHaveBeenCalledTimes(2)
    expect(newTask).not.toHaveBeenCalled()
    expect(quickReply).not.toHaveBeenCalled()

    // The page gets keyup too, and it stays off the window as well.
    const onWindowKeyUp = vi.fn()
    window.addEventListener('keyup', onWindowKeyUp)
    onTestFinished(() => window.removeEventListener('keyup', onWindowKeyUp))
    fireEvent.keyUp(layer, { key: 'c', code: 'KeyC', keyCode: 67 })
    expect(onWindowKeyUp).not.toHaveBeenCalled()

    // Cmd/Ctrl+K and paste stay with cezar: they are not sent, so they keep going.
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    onTestFinished(() => window.removeEventListener('keydown', seen))
    send.mockClear()
    fireEvent.keyDown(layer, { key: 'k', ctrlKey: true })
    fireEvent.keyDown(layer, { key: 'v', metaKey: true })
    expect(send).not.toHaveBeenCalled()
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('sends pasted text as insertText only while the layer has focus', () => {
    const { layer, send } = mount()
    const paste = (text: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
      document.dispatchEvent(event)
    }
    layer.blur()
    paste('ignored')
    expect(send).not.toHaveBeenCalled()
    layer.focus()
    paste('hello')
    expect(send).toHaveBeenCalledWith({ t: 'insertText', text: 'hello' })
  })

  it('does not open the browser context menu over the page', () => {
    const { layer } = mount()
    expect(fireEvent.contextMenu(layer)).toBe(false)
  })

  it('takes the keyboard on mount only when nothing else has it', () => {
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    mount()
    expect(document.activeElement).toBe(field)
    field.remove()
    cleanup()
    mount()
    expect(document.activeElement).toBe(screen.getByRole('application'))
  })
})
