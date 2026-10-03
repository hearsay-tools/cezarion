import './preview.css'
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'

import { PreviewErrorBoundary } from './preview-error-boundary'
import type { PreviewPaneState } from './preview-state'
import { PREVIEW_DOCK_QUERY, PREVIEW_PHONE_QUERY, useMediaQuery } from './use-media-query'

/**
 * The task view's split layout (#781): the transcript on the left, the pane on the right, a
 * draggable divider between them. Below 1180 px the pane takes the main area and a `Session`
 * control steps back to the transcript; on a phone the pane is full screen.
 *
 * The transcript is never unmounted, only hidden, so its scroll position, composer draft and
 * live stream survive opening and closing the pane.
 */

/** Lazy ON PURPOSE: live preview is experimental and off by default, so the pane (toolbar, states,
 *  menus) is a chunk only an owner who opens it pays for. */
const PreviewPane = lazy(() => import('./preview-pane-connected').then(module => ({ default: module.ConnectedPreviewPane })))

const STORAGE_KEY = 'cez.preview.pane-width'
const DEFAULT_PERCENT = 58
const MIN_PERCENT = 30
const MAX_PERCENT = 75
const KEY_STEP = 2

const clamp = (percent: number): number => Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(percent)))

function loadPercent(): number {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY))
    return stored > 0 ? clamp(stored) : DEFAULT_PERCENT
  } catch {
    return DEFAULT_PERCENT
  }
}

/** The height of the shell's scrolling main: the pane sticks to it while the transcript scrolls. */
function useScrollerHeight(element: { current: HTMLElement | null }): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined)
  useEffect(() => {
    const scroller = element.current?.closest<HTMLElement>('[data-slot="main"]')
    if (!scroller) return
    const measure = () => setHeight(scroller.clientHeight || undefined)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [element])
  return height
}

export function PreviewSplit({ run, state, children }: { run: ApiRun | undefined; state: PreviewPaneState; children: ReactNode }) {
  const docked = useMediaQuery(PREVIEW_DOCK_QUERY, true)
  const phone = useMediaQuery(PREVIEW_PHONE_QUERY, false)
  const wrapper = useRef<HTMLDivElement>(null)
  const scrollerHeight = useScrollerHeight(wrapper)
  const [percent, setPercent] = useState(loadPercent)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(percent))
    } catch {
      /* a private window keeps the width for this visit only */
    }
  }, [percent])

  const showPane = state.open && run !== undefined
  const takeover = showPane && !docked
  // Pane in front: below 1180 px it takes the main area, under the task header (design 02); on a
  // phone it is the whole screen and the task view steps aside entirely.
  const paneInFront = takeover && !state.session
  const paneHidden = takeover && state.session

  const dragTo = (clientX: number) => {
    const box = wrapper.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    setPercent(clamp(((box.right - clientX) / box.width) * 100))
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) dragTo(event.clientX)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') setPercent(value => clamp(value + KEY_STEP))
    else if (event.key === 'ArrowRight') setPercent(value => clamp(value - KEY_STEP))
    else return
    event.preventDefault()
  }

  const style = {
    '--preview-pane': `${percent}%`,
    ...(scrollerHeight === undefined ? {} : { '--preview-h': `${scrollerHeight}px` }),
  } as CSSProperties

  return (
    <div
      ref={wrapper}
      data-slot="task-split"
      data-pane={showPane ? 'open' : 'closed'}
      data-takeover={paneInFront ? '' : undefined}
      className="preview-split flex min-h-full"
      style={style}
    >
      <div
        data-slot="task-main"
        hidden={paneInFront && phone}
        data-collapsed={paneInFront && !phone ? '' : undefined}
        className="min-w-0 flex-1"
      >
        {children}
      </div>
      {showPane ? (
        <>
          {docked ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize preview"
              aria-valuemin={MIN_PERCENT}
              aria-valuemax={MAX_PERCENT}
              aria-valuenow={percent}
              tabIndex={0}
              data-slot="preview-divider"
              className="preview-divider"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onKeyDown={onKeyDown}
            />
          ) : null}
          <aside data-slot="preview-pane" data-phone={phone ? '' : undefined} hidden={paneHidden} className="preview-pane">
            <PreviewErrorBoundary onClose={state.closePane}>
              <Suspense fallback={<p role="status" className="p-6 text-sm text-muted-foreground">Opening the preview…</p>}>
                <PreviewPane
                  run={run}
                  servers={run.previewServers ?? []}
                  request={state.request}
                  onSession={paneInFront ? state.showSession : undefined}
                  onPort={state.setPort}
                  onLive={state.setLive}
                  onClose={state.closePane}
                />
              </Suspense>
            </PreviewErrorBoundary>
          </aside>
        </>
      ) : null}
    </div>
  )
}
