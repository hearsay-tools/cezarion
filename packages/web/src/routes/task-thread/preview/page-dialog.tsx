import { useEffect, useRef, useState } from 'react'

import type { PreviewServerMessage } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'

/** 5.13: the page's own alert, confirm or prompt, drawn by cezar and labelled with the origin. */
export function PageDialog({
  dialog,
  onResult,
}: {
  dialog: Extract<PreviewServerMessage, { t: 'dialog' }>
  onResult: (result: { accept: boolean; text?: string }) => void
}) {
  const [text, setText] = useState(dialog.defaultPrompt ?? '')
  const leaving = dialog.type === 'beforeunload'
  const ok = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ;(dialog.type === 'prompt' ? field.current : ok.current)?.focus()
  }, [dialog.type])
  // The page is frozen until it is answered, so Esc cancels wherever focus sits.
  const answer = useRef(onResult)
  answer.current = onResult
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      answer.current({ accept: false })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  const accept = () => onResult(dialog.type === 'prompt' ? { accept: true, text } : { accept: true })
  return (
    <div data-slot="preview-page-dialog" className="absolute inset-0 z-20 flex items-center justify-center bg-foreground/30 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={`${dialog.origin} says`}
        className="w-full max-w-[380px] rounded-xl border border-border bg-card p-4 shadow-lg"
      >
        <p className="mb-3 truncate font-mono text-xs text-muted-foreground">{`${dialog.origin} says`}</p>
        <p className="mb-4 text-sm break-words whitespace-pre-wrap text-foreground">{dialog.message || (leaving ? 'Changes you made may not be saved.' : '')}</p>
        {dialog.type === 'prompt' ? (
          <input
            ref={field}
            value={text}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') accept() }}
            className="mb-4 h-11 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        ) : null}
        <div className="flex justify-end gap-2">
          {dialog.type === 'alert' ? null : (
            <Button variant="outline" onClick={() => onResult({ accept: false })}>{leaving ? 'Stay' : 'Cancel'}</Button>
          )}
          <Button ref={ok as never} variant="contrast" onClick={accept}>{leaving ? 'Leave' : 'OK'}</Button>
        </div>
      </div>
    </div>
  )
}
