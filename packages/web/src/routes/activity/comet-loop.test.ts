import { describe, expect, it, vi } from 'vitest'

import { cometProgress, createCometLoop, easeInOut, type CometFlight } from './comet-loop'

/** A frame clock the test drives: each `step` runs the frame the loop asked for. */
function frames() {
  const pending = new Map<number, (time: number) => void>()
  let next = 0
  return {
    frame: vi.fn((callback: (time: number) => void) => {
      pending.set(++next, callback)
      return next
    }),
    cancel: vi.fn((handle: number) => pending.delete(handle)),
    step(time: number) {
      const due = [...pending.values()]
      pending.clear()
      for (const callback of due) callback(time)
    },
    scheduled: () => pending.size,
  }
}

const flight = (id: string, duration = 1_000): CometFlight => ({ id, requestId: `r-${id}`, reverse: false, tone: 'peer', duration })

describe('createCometLoop', () => {
  it('asks for no frame while no comet is in flight', () => {
    const clock = frames()
    const loop = createCometLoop({ ...clock, draw: vi.fn() })
    expect(loop.running()).toBe(false)
    expect(clock.frame).not.toHaveBeenCalled()
  })

  it('runs while a comet flies and stops at its end, with a last frame that clears it', () => {
    const clock = frames()
    const draw = vi.fn()
    const loop = createCometLoop({ ...clock, draw })
    loop.launch(flight('a'))
    expect(loop.running()).toBe(true)
    clock.step(100) // the comet's first frame: its start
    clock.step(600)
    expect(draw).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a', start: 100 })], 600)
    clock.step(1_100) // 1 000 ms after its start
    expect(draw).toHaveBeenLastCalledWith([], 1_100)
    expect(loop.running()).toBe(false)
    expect(clock.scheduled()).toBe(0)
  })

  it('keeps one frame loop for several comets, until the last one lands', () => {
    const clock = frames()
    const loop = createCometLoop({ ...clock, draw: vi.fn() })
    loop.launch(flight('a', 500))
    loop.launch(flight('b', 1_000))
    loop.launch(flight('a', 500)) // the same comet again: ignored
    expect(clock.frame).toHaveBeenCalledTimes(1)
    clock.step(0)
    clock.step(600)
    expect(loop.running()).toBe(true)
    clock.step(1_000)
    expect(loop.running()).toBe(false)
  })

  it('stops at once on stop, and clears every comet', () => {
    const clock = frames()
    const draw = vi.fn()
    const loop = createCometLoop({ ...clock, draw })
    loop.launch(flight('a'))
    loop.stop()
    expect(clock.cancel).toHaveBeenCalled()
    expect(loop.running()).toBe(false)
    expect(draw).toHaveBeenLastCalledWith([], 0)
  })
})

describe('cometProgress', () => {
  it('moves from the sender to the recipient, or back for a reply', () => {
    const go = { start: 0, duration: 1_000, reverse: false }
    expect(cometProgress(go, 0)).toBe(0)
    expect(cometProgress(go, 500)).toBe(easeInOut(0.5))
    expect(cometProgress(go, 2_000)).toBe(1)
    expect(cometProgress({ ...go, reverse: true }, 0)).toBe(1)
    expect(cometProgress({ ...go, reverse: true }, 1_000)).toBe(0)
  })
})
