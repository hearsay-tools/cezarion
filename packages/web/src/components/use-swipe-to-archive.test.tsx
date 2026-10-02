import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ACTION_PX,
  AXIS_LOCK_PX,
  COMMIT_RATIO,
  FLING_PX_PER_MS,
  PARK_PX,
  SNAP_MS,
  resetSwipeStore,
  useSwipeToArchive,
} from './use-swipe-to-archive'

const WIDTH = 320

function Row({ id, enabled = true, onArchive }: { id: string; enabled?: boolean; onArchive: () => void | Promise<unknown> }) {
  const swipe = useSwipeToArchive({ id, enabled, onArchive })
  return (
    <div data-testid={`surface-${id}`} ref={swipe.surfaceRef}>
      <div
        data-testid={id}
        data-offset={swipe.offset}
        data-phase={swipe.phase}
        data-past={swipe.past ? 'true' : 'false'}
        {...swipe.bind}
      >
        <a href="#row" data-testid={`link-${id}`}>row {id}</a>
      </div>
      <button type="button" data-testid={`close-${id}`} onClick={swipe.close}>close</button>
    </div>
  )
}

const row = (id: string) => screen.getByTestId(id)
const state = (id: string) => ({
  offset: Number(row(id).dataset.offset),
  phase: row(id).dataset.phase,
  past: row(id).dataset.past === 'true',
})

let clock = 1_000_000
const advance = (ms: number) => {
  clock += ms
  vi.setSystemTime(clock)
}

/** One drag: down at (200, 100), the moves in order (each `ms` after the last), then up. */
function drag(id: string, moves: Array<{ dx: number; dy?: number; ms?: number }>, { release = true } = {}) {
  const el = row(id)
  fireEvent.pointerDown(el, { pointerId: 1, clientX: 200, clientY: 100, button: 0, isPrimary: true })
  let last = { dx: 0, dy: 0 }
  for (const move of moves) {
    advance(move.ms ?? 100)
    last = { dx: move.dx, dy: move.dy ?? 0 }
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 200 + last.dx, clientY: 100 + last.dy })
  }
  if (release) fireEvent.pointerUp(el, { pointerId: 1, clientX: 200 + last.dx, clientY: 100 + last.dy })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(clock)
  // jsdom lays nothing out: give every row the 320px the gesture measures against.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: WIDTH, height: 47, top: 0, left: 0, right: WIDTH, bottom: 47, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  cleanup()
  resetSwipeStore()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useSwipeToArchive', () => {
  it('exports the gesture constants the design names', () => {
    expect({ AXIS_LOCK_PX, PARK_PX, ACTION_PX, COMMIT_RATIO, SNAP_MS, FLING_PX_PER_MS }).toEqual({
      AXIS_LOCK_PX: 10, PARK_PX: 40, ACTION_PX: 88, COMMIT_RATIO: 0.6, SNAP_MS: 200, FLING_PX_PER_MS: 0.5,
    })
  })

  it('never captures a mostly vertical move (Review Focus 4)', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -4, dy: 15 }, { dx: -8, dy: 30 }], { release: false })
    expect(state('a')).toEqual({ offset: 0, phase: 'idle', past: false })
    // Even a later horizontal turn in the same gesture: the axis locked vertical.
    advance(100)
    fireEvent.pointerMove(row('a'), { pointerId: 1, clientX: 100, clientY: 130 })
    expect(state('a')).toEqual({ offset: 0, phase: 'idle', past: false })
  })

  it('does not move before 10px of travel', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -9 }], { release: false })
    expect(state('a').phase).toBe('idle')
    expect(state('a').offset).toBe(0)
  })

  it('tracks the finger once locked horizontal', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -12 }, { dx: -30 }], { release: false })
    expect(state('a').phase).toBe('dragging')
    expect(state('a').offset).toBe(-30)
  })

  it('parks open on the action after a short swipe past 40px', () => {
    const onArchive = vi.fn()
    render(<Row id="a" onArchive={onArchive} />)
    drag('a', [{ dx: -20 }, { dx: -50 }])
    expect(state('a')).toEqual({ offset: -ACTION_PX, phase: 'open', past: false })
    expect(onArchive).not.toHaveBeenCalled()
  })

  it('snaps back under 40px', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -20 }, { dx: -30 }])
    expect(state('a')).toEqual({ offset: 0, phase: 'idle', past: false })
  })

  it('crosses the commit threshold past 60% of the width and archives once on release', () => {
    const onArchive = vi.fn()
    render(<Row id="a" onArchive={onArchive} />)
    drag('a', [{ dx: -100 }, { dx: -(COMMIT_RATIO * WIDTH + 8) }], { release: false })
    expect(state('a').past).toBe(true)
    expect(onArchive).not.toHaveBeenCalled()
    fireEvent.pointerUp(row('a'), { pointerId: 1, clientX: 0, clientY: 100 })
    expect(onArchive).toHaveBeenCalledTimes(1)
    expect(state('a').phase).toBe('committing')
    expect(state('a').offset).toBe(-WIDTH)
  })

  it('drops back below the threshold when the finger comes back', () => {
    const onArchive = vi.fn()
    render(<Row id="a" onArchive={onArchive} />)
    drag('a', [{ dx: -100, ms: 300 }, { dx: -220, ms: 300 }, { dx: -60, ms: 300 }])
    expect(onArchive).not.toHaveBeenCalled()
    expect(state('a').phase).toBe('open')
  })

  it('archives on a fast fling', () => {
    const onArchive = vi.fn()
    render(<Row id="a" onArchive={onArchive} />)
    drag('a', [{ dx: -15, ms: 10 }, { dx: -60, ms: 40 }])
    expect(onArchive).toHaveBeenCalledTimes(1)
  })

  it('a slow drag to the same distance only parks', () => {
    const onArchive = vi.fn()
    render(<Row id="a" onArchive={onArchive} />)
    drag('a', [{ dx: -15, ms: 300 }, { dx: -60, ms: 300 }])
    expect(onArchive).not.toHaveBeenCalled()
    expect(state('a').phase).toBe('open')
  })

  it('snaps back to idle when the archive fails', async () => {
    const onArchive = vi.fn(() => Promise.resolve(false))
    render(<Row id="a" onArchive={onArchive} />)
    drag('a', [{ dx: -100 }, { dx: -250 }])
    expect(state('a').phase).toBe('committing')
    await act(async () => {})
    expect(state('a')).toEqual({ offset: 0, phase: 'idle', past: false })
  })

  it('opening row B closes open row A', () => {
    render(<><Row id="a" onArchive={vi.fn()} /><Row id="b" onArchive={vi.fn()} /></>)
    drag('a', [{ dx: -20 }, { dx: -50 }])
    expect(state('a').phase).toBe('open')
    drag('b', [{ dx: -20 }], { release: false })
    expect(state('a')).toEqual({ offset: 0, phase: 'idle', past: false })
    expect(state('b').phase).toBe('dragging')
  })

  it('a scroll closes the open row', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -20 }, { dx: -50 }])
    act(() => { fireEvent.scroll(document.body) })
    expect(state('a').phase).toBe('idle')
  })

  it('a pointerdown outside the row closes it; one inside the surface does not', () => {
    render(<><Row id="a" onArchive={vi.fn()} /><div data-testid="elsewhere" /></>)
    drag('a', [{ dx: -20 }, { dx: -50 }])
    act(() => { fireEvent.pointerDown(screen.getByTestId('close-a')) })
    expect(state('a').phase).toBe('open')
    act(() => { fireEvent.pointerDown(screen.getByTestId('elsewhere')) })
    expect(state('a').phase).toBe('idle')
  })

  it('a tap on the open row closes it and does not follow the link', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -20 }, { dx: -50 }])
    fireEvent.pointerDown(row('a'), { pointerId: 2, clientX: 150, clientY: 100 })
    fireEvent.pointerUp(row('a'), { pointerId: 2, clientX: 150, clientY: 100 })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    screen.getByTestId('link-a').dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(state('a').phase).toBe('idle')
  })

  it('suppresses the click that follows a drag, and only that one', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -20 }, { dx: -30 }])
    const first = new MouseEvent('click', { bubbles: true, cancelable: true })
    screen.getByTestId('link-a').dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    const second = new MouseEvent('click', { bubbles: true, cancelable: true })
    screen.getByTestId('link-a').dispatchEvent(second)
    expect(second.defaultPrevented).toBe(false)
  })

  it('a plain tap is a click', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    fireEvent.pointerDown(row('a'), { pointerId: 1, clientX: 150, clientY: 100 })
    fireEvent.pointerUp(row('a'), { pointerId: 1, clientX: 151, clientY: 100 })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    screen.getByTestId('link-a').dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
  })

  it('vibrates 10ms once as it crosses the threshold, where vibrate exists', () => {
    const vibrate = vi.fn(() => true)
    vi.stubGlobal('navigator', { ...navigator, vibrate })
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -100 }, { dx: -220 }, { dx: -240 }, { dx: -230 }], { release: false })
    expect(vibrate).toHaveBeenCalledTimes(1)
    expect(vibrate).toHaveBeenCalledWith(10)
  })

  it('does not throw where vibrate does not exist (iOS Safari)', () => {
    const { vibrate: _omit, ...rest } = navigator as Navigator & { vibrate?: unknown }
    vi.stubGlobal('navigator', { ...rest, vibrate: undefined })
    render(<Row id="a" onArchive={vi.fn()} />)
    expect(() => drag('a', [{ dx: -100 }, { dx: -220 }], { release: false })).not.toThrow()
    expect(state('a').past).toBe(true)
  })

  it('a right swipe never goes positive', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: 20 }, { dx: 80 }], { release: false })
    expect(state('a').offset).toBe(0)
  })

  it('a right swipe on an open row closes it', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -20 }, { dx: -50 }])
    drag('a', [{ dx: 20 }, { dx: 60 }])
    expect(state('a')).toEqual({ offset: 0, phase: 'idle', past: false })
  })

  it('never moves when disabled', () => {
    const onArchive = vi.fn()
    render(<Row id="a" enabled={false} onArchive={onArchive} />)
    drag('a', [{ dx: -100 }, { dx: -250 }])
    expect(state('a')).toEqual({ offset: 0, phase: 'idle', past: false })
    expect(onArchive).not.toHaveBeenCalled()
  })

  it('a cancelled pointer (the browser took the pan) snaps back', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -20 }, { dx: -50 }], { release: false })
    fireEvent.pointerCancel(row('a'), { pointerId: 1 })
    expect(state('a')).toEqual({ offset: 0, phase: 'idle', past: false })
  })

  it('close() closes', () => {
    render(<Row id="a" onArchive={vi.fn()} />)
    drag('a', [{ dx: -20 }, { dx: -50 }])
    act(() => { screen.getByTestId('close-a').click() })
    expect(state('a').phase).toBe('idle')
  })
})
