import { describe, expect, it } from 'vitest'

import {
  createPointerState,
  keyToMessage,
  pasteToMessage,
  pointerToMessages,
  toPagePoint,
  wheelToMessage,
  type KeyLike,
  type PointerLike,
  type PointerState,
} from './input-map'

const rect = { left: 0, top: 0 }

const pointer = (overrides: Partial<PointerLike> & Pick<PointerLike, 'type'>): PointerLike => ({
  pointerId: 1,
  pointerType: 'mouse',
  clientX: 0,
  clientY: 0,
  button: 0,
  buttons: 0,
  detail: 0,
  timeStamp: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
})

const touch = (overrides: Partial<PointerLike> & Pick<PointerLike, 'type'>): PointerLike => pointer({ pointerType: 'touch', ...overrides })

const key = (overrides: Partial<KeyLike>): KeyLike => ({
  type: 'keydown',
  key: 'a',
  code: 'KeyA',
  keyCode: 65,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
})

const fresh = (scale = 1): PointerState => createPointerState(rect, scale)

describe('toPagePoint', () => {
  it('divides by the display scale so a click on a viewport shrunk to 83% lands on the same page pixel', () => {
    expect(toPagePoint(100, 100, { left: 0, top: 0 }, 0.83)).toEqual({ x: 120, y: 120 })
  })

  it('measures from the layer origin and rounds', () => {
    expect(toPagePoint(310, 220, { left: 200, top: 100 }, 1)).toEqual({ x: 110, y: 120 })
    expect(toPagePoint(10.4, 10.6, { left: 0, top: 0 }, 1)).toEqual({ x: 10, y: 11 })
  })

  it('maps through the scale the pointer events carry', () => {
    const state = fresh(0.5)
    const down = pointerToMessages(pointer({ type: 'pointerdown', clientX: 50, clientY: 40, buttons: 1 }), state)
    expect(down).toEqual([expect.objectContaining({ t: 'mouse', type: 'mousePressed', x: 100, y: 80 })])
  })
})

describe('pointerToMessages: mouse and pen', () => {
  it('presses with the button, the held buttons, the click count and the modifiers', () => {
    const messages = pointerToMessages(
      pointer({ type: 'pointerdown', clientX: 30, clientY: 40, button: 2, buttons: 2, shiftKey: true, ctrlKey: true }),
      fresh(),
    )
    expect(messages).toEqual([
      { t: 'mouse', type: 'mousePressed', x: 30, y: 40, button: 'right', buttons: 2, clickCount: 1, modifiers: 2 | 8 },
    ])
  })

  it('counts quick presses in place as a double click, and a slow or distant one as a new click', () => {
    const state = fresh()
    const press = (at: number, x: number) =>
      pointerToMessages(pointer({ type: 'pointerdown', clientX: x, clientY: 10, buttons: 1, timeStamp: at }), state)[0] as { clickCount: number }
    expect(press(0, 10).clickCount).toBe(1)
    expect(press(200, 11).clickCount).toBe(2)
    expect(press(400, 11).clickCount).toBe(3)
    expect(press(1500, 11).clickCount).toBe(1)
    expect(press(1600, 80).clickCount).toBe(1)
  })

  it('moves with the left button reported while it is held', () => {
    expect(pointerToMessages(pointer({ type: 'pointermove', clientX: 5, clientY: 6, buttons: 0 }), fresh())).toEqual([
      { t: 'mouse', type: 'mouseMoved', x: 5, y: 6, button: 'none', buttons: 0, clickCount: 1, modifiers: 0 },
    ])
    expect(pointerToMessages(pointer({ type: 'pointermove', buttons: 1 }), fresh())[0]).toMatchObject({ button: 'left', buttons: 1 })
  })

  it('releases on pointerup', () => {
    expect(pointerToMessages(pointer({ type: 'pointerup', clientX: 9, clientY: 9, button: 0, buttons: 0 }), fresh())).toEqual([
      { t: 'mouse', type: 'mouseReleased', x: 9, y: 9, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
    ])
  })

  it('treats a pen like a mouse', () => {
    const messages = pointerToMessages(pointer({ type: 'pointerdown', pointerType: 'pen', buttons: 1 }), fresh())
    expect(messages).toEqual([expect.objectContaining({ type: 'mousePressed', button: 'left' })])
  })
})

describe('pointerToMessages: touch', () => {
  it('turns a 5 px tap into move, press and release at the tap point', () => {
    const state = fresh()
    expect(pointerToMessages(touch({ type: 'pointerdown', clientX: 100, clientY: 200, timeStamp: 0 }), state)).toEqual([])
    expect(pointerToMessages(touch({ type: 'pointermove', clientX: 103, clientY: 204, timeStamp: 40 }), state)).toEqual([])
    const tap = pointerToMessages(touch({ type: 'pointerup', clientX: 103, clientY: 204, timeStamp: 90 }), state)
    expect(tap.map(message => (message.t === 'mouse' ? message.type : message.t))).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    for (const message of tap) expect(message).toMatchObject({ x: 100, y: 200 })
    expect(tap[1]).toMatchObject({ button: 'left', buttons: 1, clickCount: 1 })
    expect(tap[2]).toMatchObject({ button: 'left', buttons: 0, clickCount: 1 })
  })

  it('maps the tap through the display scale', () => {
    const state = fresh(0.5)
    pointerToMessages(touch({ type: 'pointerdown', clientX: 50, clientY: 60 }), state)
    const tap = pointerToMessages(touch({ type: 'pointerup', clientX: 50, clientY: 60, timeStamp: 50 }), state)
    for (const message of tap) expect(message).toMatchObject({ x: 100, y: 120 })
  })

  it('scrolls the page with a 60 px upward drag: the wheel delta is the movement, negated', () => {
    const state = fresh()
    pointerToMessages(touch({ type: 'pointerdown', clientX: 100, clientY: 300, timeStamp: 0 }), state)
    const drag = pointerToMessages(touch({ type: 'pointermove', clientX: 100, clientY: 240, timeStamp: 50 }), state)
    expect(drag).toEqual([{ t: 'mouse', type: 'mouseWheel', x: 100, y: 240, button: 'none', buttons: 0, deltaX: 0, deltaY: 60, modifiers: 0 }])
    expect(pointerToMessages(touch({ type: 'pointerup', clientX: 100, clientY: 240, timeStamp: 100 }), state)).toEqual([])
  })

  it('keeps scrolling by the movement since the last move, horizontal too', () => {
    const state = fresh()
    pointerToMessages(touch({ type: 'pointerdown', clientX: 200, clientY: 200 }), state)
    pointerToMessages(touch({ type: 'pointermove', clientX: 150, clientY: 200, timeStamp: 30 }), state)
    const next = pointerToMessages(touch({ type: 'pointermove', clientX: 140, clientY: 205, timeStamp: 60 }), state)
    expect(next[0]).toMatchObject({ type: 'mouseWheel', deltaX: 10, deltaY: -5 })
  })

  it('a drag moves the page as far as the finger, whatever the display scale', () => {
    const state = fresh(0.5)
    pointerToMessages(touch({ type: 'pointerdown', clientX: 100, clientY: 300 }), state)
    const drag = pointerToMessages(touch({ type: 'pointermove', clientX: 100, clientY: 240, timeStamp: 50 }), state)
    expect(drag[0]).toMatchObject({ type: 'mouseWheel', y: 480, deltaY: 120 })
  })

  it('a long press does nothing', () => {
    const state = fresh()
    pointerToMessages(touch({ type: 'pointerdown', clientX: 100, clientY: 200, timeStamp: 0 }), state)
    expect(pointerToMessages(touch({ type: 'pointerup', clientX: 100, clientY: 200, timeStamp: 800 }), state)).toEqual([])
  })

  it('a two-finger touch does nothing, not even a tap when the first finger lifts', () => {
    const state = fresh()
    expect(pointerToMessages(touch({ type: 'pointerdown', pointerId: 1, clientX: 100, clientY: 200 }), state)).toEqual([])
    expect(pointerToMessages(touch({ type: 'pointerdown', pointerId: 2, clientX: 160, clientY: 200 }), state)).toEqual([])
    expect(pointerToMessages(touch({ type: 'pointermove', pointerId: 2, clientX: 200, clientY: 260, timeStamp: 30 }), state)).toEqual([])
    expect(pointerToMessages(touch({ type: 'pointerup', pointerId: 2, clientX: 200, clientY: 260, timeStamp: 60 }), state)).toEqual([])
    expect(pointerToMessages(touch({ type: 'pointerup', pointerId: 1, clientX: 100, clientY: 200, timeStamp: 70 }), state)).toEqual([])
    // The gesture ended with the last finger: the next tap is a tap again.
    pointerToMessages(touch({ type: 'pointerdown', clientX: 10, clientY: 10, timeStamp: 1000 }), state)
    expect(pointerToMessages(touch({ type: 'pointerup', clientX: 10, clientY: 10, timeStamp: 1050 }), state)).toHaveLength(3)
  })

  it('a cancelled touch sends nothing', () => {
    const state = fresh()
    pointerToMessages(touch({ type: 'pointerdown', clientX: 100, clientY: 200 }), state)
    expect(pointerToMessages(touch({ type: 'pointercancel', clientX: 100, clientY: 200, timeStamp: 40 }), state)).toEqual([])
    expect(pointerToMessages(touch({ type: 'pointerup', clientX: 100, clientY: 200, timeStamp: 60 }), state)).toEqual([])
  })
})

describe('wheelToMessage', () => {
  it('sends the wheel at the page point, in page pixels, with lines expanded to pixels', () => {
    expect(wheelToMessage({ clientX: 50, clientY: 50, deltaX: 0, deltaY: 100, deltaMode: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }, rect, 0.5)).toEqual({
      t: 'mouse', type: 'mouseWheel', x: 100, y: 100, button: 'none', buttons: 0, deltaX: 0, deltaY: 200, modifiers: 0,
    })
    expect(wheelToMessage({ clientX: 0, clientY: 0, deltaX: 0, deltaY: 3, deltaMode: 1, altKey: false, ctrlKey: false, metaKey: false, shiftKey: true }, rect, 1)).toMatchObject({ deltaY: 48, modifiers: 8 })
  })
})

describe('keyToMessage', () => {
  it('sends a printable key as keyDown with its text', () => {
    expect(keyToMessage(key({ key: 'a', code: 'KeyA', keyCode: 65 }))).toEqual({ t: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', modifiers: 0, vk: 65 })
  })

  it('sends Enter and Tab with their control text, and other keys raw', () => {
    expect(keyToMessage(key({ key: 'Enter', code: 'Enter', keyCode: 13 }))).toMatchObject({ type: 'keyDown', text: '\r' })
    expect(keyToMessage(key({ key: 'Tab', code: 'Tab', keyCode: 9 }))).toMatchObject({ type: 'keyDown', text: '\t' })
    expect(keyToMessage(key({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }))).toMatchObject({ type: 'rawKeyDown', text: '' })
  })

  it('Ctrl+A carries the selectAll editing command and no text', () => {
    expect(keyToMessage(key({ ctrlKey: true }))).toEqual({
      t: 'key', type: 'rawKeyDown', key: 'a', code: 'KeyA', text: '', modifiers: 2, vk: 65, commands: ['selectAll'],
    })
  })

  it('maps every editing shortcut, with Cmd the same as Ctrl', () => {
    const command = (k: string, extra: Partial<KeyLike> = {}) => {
      const message = keyToMessage(key({ key: k, metaKey: true, ...extra }))
      return message?.t === 'key' ? message.commands : undefined
    }
    expect(command('c')).toEqual(['copy'])
    expect(command('x')).toEqual(['cut'])
    expect(command('z')).toEqual(['undo'])
    expect(command('y')).toEqual(['redo'])
    expect(command('Z', { shiftKey: true })).toEqual(['redo'])
    expect(command('b')).toBeUndefined()
  })

  it('leaves Ctrl+V to the paste event and Cmd+K or Ctrl+K to cezar', () => {
    expect(keyToMessage(key({ key: 'v', ctrlKey: true }))).toBeUndefined()
    expect(keyToMessage(key({ key: 'V', metaKey: true }))).toBeUndefined()
    expect(keyToMessage(key({ key: 'k', metaKey: true }))).toBeUndefined()
    expect(keyToMessage(key({ key: 'k', ctrlKey: true }))).toBeUndefined()
    expect(keyToMessage(key({ type: 'keyup', key: 'k', metaKey: true }))).toBeUndefined()
  })

  it('types AltGr characters instead of reading them as a shortcut', () => {
    const message = keyToMessage(key({ key: 'ą', code: 'KeyA', ctrlKey: true, altKey: true, getModifierState: name => name === 'AltGraph' }))
    expect(message).toMatchObject({ type: 'keyDown', text: 'ą' })
    expect(message).not.toHaveProperty('commands')
  })

  it('sends keyup as keyUp without text or commands', () => {
    expect(keyToMessage(key({ type: 'keyup', ctrlKey: true }))).toEqual({ t: 'key', type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, vk: 65 })
  })
})

describe('pasteToMessage', () => {
  it('inserts the clipboard text and ignores an empty clipboard', () => {
    expect(pasteToMessage('hello')).toEqual({ t: 'insertText', text: 'hello' })
    expect(pasteToMessage('')).toBeUndefined()
  })
})
