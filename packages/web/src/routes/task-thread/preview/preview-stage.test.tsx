import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PreviewStage, type StageGeometry, type PreviewStageHandle } from './preview-stage'

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 })
})

afterEach(() => {
  cleanup()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
})

describe('PreviewStage', () => {
  it('Fit follows the stage 1:1 and reports its size as the browser viewport', () => {
    const onSize = vi.fn()
    const seen: StageGeometry[] = []
    render(<PreviewStage viewport="fit" onSize={onSize} renderInput={geometry => { seen.push(geometry); return null }} />)
    expect(onSize).toHaveBeenCalledWith({ w: 1000, h: 700 })
    expect(seen.at(-1)).toMatchObject({ scale: 1, viewport: { w: 1000, h: 700 } })
  })

  it('a fixed preset keeps its real size and only scales down to fit the pane', () => {
    const seen: StageGeometry[] = []
    render(<PreviewStage viewport={{ w: 1440, h: 900 }} renderInput={geometry => { seen.push(geometry); return null }} />)
    const surface = document.querySelector<HTMLElement>('[data-slot="preview-surface"]')!
    // 1000 x 700 minus the 12 px frame: 976 / 1440 is the tighter side.
    expect(Number(surface.dataset.scale)).toBeCloseTo(976 / 1440, 5)
    expect(surface.style.width).toBe('976px')
    expect(seen.at(-1)?.viewport).toEqual({ w: 1440, h: 900 })
  })

  it('never scales a small preset up', () => {
    render(<PreviewStage viewport={{ w: 390, h: 844 }} />)
    // 844 does not fit in 676, so it shrinks; the width follows the same scale.
    const surface = document.querySelector<HTMLElement>('[data-slot="preview-surface"]')!
    expect(Number(surface.dataset.scale)).toBeCloseTo(676 / 844, 5)
    cleanup()
    render(<PreviewStage viewport={{ w: 300, h: 300 }} />)
    expect(Number(document.querySelector<HTMLElement>('[data-slot="preview-surface"]')!.dataset.scale)).toBe(1)
  })
})


it('releases a decoded bitmap without painting after the document hides', async () => {
  const ref = createRef<PreviewStageHandle>()
  const draw = vi.fn(), close = vi.fn()
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as never)
  let finish!: (value: unknown) => void
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => { finish = resolve })))
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  try {
    render(<PreviewStage ref={ref} viewport={{ w: 390, h: 844 }} />)
    const pending = ref.current!.draw(new Blob(['frame']))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    finish({ width: 390, height: 844, close })
    await pending
    expect(close).toHaveBeenCalledTimes(1)
    expect(draw).not.toHaveBeenCalled()
  } finally {
    context.mockRestore(); vi.unstubAllGlobals()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  }
})

it('draws a 2x frame into a 2x backing store and keeps the CSS size and the input scale (hearsay-tools/cezarion#2069)', async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 })
  const ref = createRef<PreviewStageHandle>()
  const draw = vi.fn()
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as never)
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2000, height: 1400, close: vi.fn() })))
  const seen: StageGeometry[] = []
  try {
    render(<PreviewStage ref={ref} viewport="fit" renderInput={geometry => { seen.push(geometry); return null }} />)
    await ref.current!.draw(new Blob(['frame']))
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Page preview"]')!
    expect([canvas.width, canvas.height]).toEqual([2000, 1400])
    expect([canvas.style.width, canvas.style.height]).toEqual(['1000px', '700px'])
    expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0)
    // Input maps in CSS pixels: the page is 1000 wide at scale 1, whatever the frame's pixel size.
    expect(seen.at(-1)).toMatchObject({ scale: 1, viewport: { w: 1000, h: 700 } })
  } finally {
    context.mockRestore(); vi.unstubAllGlobals(); cleanup()
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  }
})

it('keeps the newest frame when an older decode finishes last', async () => {
  const ref = createRef<PreviewStageHandle>()
  const draw = vi.fn()
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as never)
  const finishes: Array<(bitmap: unknown) => void> = []
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => finishes.push(resolve))))
  const older = { width: 2000, height: 1400, close: vi.fn() }
  const newest = { width: 1000, height: 700, close: vi.fn() }
  try {
    render(<PreviewStage ref={ref} viewport="fit" />)
    const first = ref.current!.draw(new Blob(['older']))
    const second = ref.current!.draw(new Blob(['newest']))
    finishes[1]!(newest)
    await second
    finishes[0]!(older)
    await first
    const canvas = document.querySelector('canvas')!
    expect([canvas.width, canvas.height]).toEqual([1000, 700])
    expect(draw.mock.calls).toEqual([[newest, 0, 0]])
    expect(older.close).toHaveBeenCalledOnce()
    expect(newest.close).toHaveBeenCalledOnce()
  } finally {
    context.mockRestore(); vi.unstubAllGlobals()
  }
})
