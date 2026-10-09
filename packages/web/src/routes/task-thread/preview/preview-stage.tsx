import { pageIsActive } from '@/api/live-visibility'
import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'

import { cn } from '@/lib/utils'

/**
 * The canvas the screencast frames land on, and the box that sizes it (#781).
 *
 * Frames arrive as JPEG blobs at the browser's viewport size. A `Fit` viewport is the stage's own
 * box, so the page renders 1:1; a fixed preset renders at its real size and only ever scales DOWN
 * to fit the pane (`scale`). `PreviewStage` draws and measures; it listens to nothing, so the
 * input layer (Task 10) attaches without touching the drawing:
 *
 *   SEAM (input): pass `renderInput`. It renders inside the surface, over the canvas, in the
 *   surface's own CSS box, and receives the canvas and the display `scale`. A pointer position
 *   inside that layer maps to a page pixel by dividing by `scale`; the page is `viewport` wide.
 */

export interface StageGeometry {
  canvas: HTMLCanvasElement | null
  /** CSS pixels per page pixel. 1 in Fit; below 1 when a fixed viewport is shrunk to fit. */
  scale: number
  /** The page's viewport in page pixels. Null until the stage is measured. */
  viewport: { w: number; h: number } | null
}

export interface PreviewStageHandle {
  /** Decodes and draws one frame. Resolves once it is on the canvas (or could not be drawn). */
  draw(frame: Blob): Promise<void>
}

export interface StageSize {
  w: number
  h: number
}

async function decode(frame: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(frame)
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
  }
  const url = URL.createObjectURL(frame)
  const image = new Image()
  image.src = url
  await image.decode()
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) }
}

export function PreviewStage({
  ref,
  viewport,
  dimmed = false,
  cursor,
  onSize,
  renderInput,
  children,
}: {
  ref?: Ref<PreviewStageHandle>
  /** `fit` follows the stage; a size is a fixed preset. */
  viewport: 'fit' | StageSize
  /** 5.11: the last frame stays, dimmed. */
  dimmed?: boolean
  /** The CSS cursor the page asked for. It sits on the surface, so the input layer over the canvas shows it too. */
  cursor?: string
  /** The stage's box changed (CSS pixels). Fit sends this to the browser as its viewport. */
  onSize?: (size: StageSize) => void
  renderInput?: (geometry: StageGeometry) => ReactNode
  /** Overlays: states, banners, dialogs. They fill the stage. */
  children?: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<StageSize | null>(null)
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize

  useImperativeHandle(ref, () => ({
    async draw(frame) {
      const target = canvas.current
      const context = target?.getContext('2d')
      if (!target || !context || !pageIsActive()) return
      try {
        const decoded = await decode(frame)
        try {
          if (!pageIsActive() || canvas.current !== target) return
          if (target.width !== decoded.width) target.width = decoded.width
          if (target.height !== decoded.height) target.height = decoded.height
          context.drawImage(decoded.source, 0, 0)
        } finally {
          decoded.release()
        }
      } catch {
        // A frame that does not decode is skipped; the next one replaces it.
      }
    },
  }), [])

  useEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => {
      const w = Math.round(element.clientWidth)
      const h = Math.round(element.clientHeight)
      if (w === 0 || h === 0) return
      setSize(previous => (previous && previous.w === w && previous.h === h ? previous : { w, h }))
      onSizeRef.current?.({ w, h })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const page = viewport === 'fit' ? size : viewport
  // A fixed preset sits in a 12 px frame, so it shrinks to what is left inside it.
  const scale = viewport === 'fit' || !size ? 1 : Math.min(1, (size.w - 24) / viewport.w, (size.h - 24) / viewport.h)
  const surface: CSSProperties | undefined = page
    ? { width: Math.floor(page.w * scale), height: Math.floor(page.h * scale) }
    : undefined

  return (
    <div
      ref={box}
      data-slot="preview-stage"
      data-viewport={viewport === 'fit' ? 'fit' : `${viewport.w}x${viewport.h}`}
      className={cn('relative min-h-0 flex-1 overflow-hidden bg-muted', viewport !== 'fit' && 'flex items-start justify-center overflow-auto p-3')}
    >
      {page ? (
        <div
          data-slot="preview-surface"
          data-scale={scale}
          style={{ ...surface, cursor }}
          className={cn('relative shrink-0 bg-card', viewport !== 'fit' && 'shadow-md', dimmed && 'opacity-60 saturate-50')}
        >
          <canvas ref={canvas} aria-label="Page preview" role="img" style={surface} className="block touch-none select-none" />
          {renderInput?.({ canvas: canvas.current, scale, viewport: page })}
        </div>
      ) : null}
      {children}
    </div>
  )
}
