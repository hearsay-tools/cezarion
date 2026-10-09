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
