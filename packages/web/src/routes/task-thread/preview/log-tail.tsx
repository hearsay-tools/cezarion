import { CopyIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * The last lines of a process's output (design 5.4 to 5.8). The server already cut the tail; this
 * only draws it and offers the whole thing to the clipboard.
 */
export function LogTail({
  text,
  source,
  onCopy,
  className,
}: {
  text: string
  /** What produced the lines: `npm run dev`, `chromium`. */
  source: string
  onCopy: (text: string) => void
  className?: string
}) {
  const lines = text.replace(/\s+$/, '').split('\n')
  return (
    <div data-slot="preview-log-tail" className={cn('min-w-0 rounded-lg bg-muted px-3.5 py-3 font-mono text-xs', className)}>
      <div className="mb-2 flex items-center justify-between gap-3 font-sans text-xs text-soft-foreground">
        <span className="min-w-0 truncate">
          <span className="font-semibold tracking-wide uppercase">Log tail</span>
          {` last ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} · ${source}`}
        </span>
        <button
          type="button"
          className="-m-2 inline-flex min-h-11 items-center gap-1.5 rounded-sm p-2 text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none md:m-0 md:min-h-0 md:p-0"
          onClick={() => onCopy(text)}
        >
          <CopyIcon className="size-3.5" aria-hidden="true" />
          Copy
        </button>
      </div>
      <pre className="max-h-48 overflow-auto break-words whitespace-pre-wrap text-foreground">{text.replace(/\s+$/, '')}</pre>
    </div>
  )
}
