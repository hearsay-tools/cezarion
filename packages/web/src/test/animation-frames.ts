import { vi } from 'vitest'

/**
 * `useRunEvents` applies stream frames once per animation frame (#881). jsdom runs its own frames
 * on a real 16 ms clock, so a test that emits a frame and reads the list at once would race it.
 * This queue replaces the browser's frames with ones the test runs by hand.
 *
 * Install it before `vi.useFakeTimers()`: fake timers replace `requestAnimationFrame` too, and
 * then `flushAnimationFrames` advances the fake clock to the next frame instead.
 */
const queued = new Map<number, FrameRequestCallback>()
let nextHandle = 1

export function installAnimationFrameQueue(): void {
  queued.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = nextHandle++
    queued.set(handle, callback)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    queued.delete(handle)
  })
}

/** Run every frame requested so far. Call it inside `act`, after the frames it should apply. */
export function flushAnimationFrames(): void {
  if (vi.isFakeTimers()) {
    vi.advanceTimersToNextFrame()
    return
  }
  const callbacks = [...queued.values()]
  queued.clear()
  const now = performance.now()
  for (const callback of callbacks) callback(now)
}
