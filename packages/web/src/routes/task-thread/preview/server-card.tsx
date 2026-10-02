import { AppWindowIcon, FileTextIcon, PlayIcon, RotateCcwIcon, ServerIcon, SquareTerminalIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { ThreadPreviewServer } from '../thread-state'
import type { PreviewOpenRequest } from './preview-state'

/**
 * The thread card for one registered dev server (#781, v1 design screen 05).
 *
 * The card makes no claim about a port cezar did not start: a server that answered when the agent
 * registered it reads "was running when registered" with a neutral dot, never "up". Whenever the
 * next click may run the command, the card says so beside the button. Stop is never on the card.
 */

interface CardView {
  tone: StatusDotTone
  ring?: boolean
  pulse?: boolean
  status: string
  action?: { label: 'Run and open' | 'Open' | 'View' | 'Start again'; run: boolean }
}

function view(entry: ThreadPreviewServer): CardView {
  const { state, server } = entry
  const age = shortAge(entry.stateAt)
  switch (state) {
    case 'registered':
      return server.answeredAtRegistration
        ? { tone: 'neutral', status: 'was running when registered', action: { label: 'Open', run: false } }
        : { tone: 'neutral', ring: true, status: 'registered · not started', action: { label: 'Run and open', run: true } }
    case 'adopted':
      return { tone: 'neutral', status: 'was running when registered', action: { label: 'Open', run: false } }
    case 'starting':
      return { tone: 'pending', pulse: true, status: 'starting', action: { label: 'Open', run: false } }
    case 'up':
      return { tone: 'success', status: age ? `up · ${age}` : 'up', action: { label: 'Open', run: false } }
    case 'stalled':
      return { tone: 'pending', status: 'stalled · port silent 2 min', action: { label: 'View', run: false } }
    case 'exited':
      return {
        tone: 'danger',
        status: entry.exitCode === undefined ? 'exited' : `exited · code ${entry.exitCode}`,
        action: { label: 'Start again', run: true },
      }
    case 'stopped':
      return {
        tone: 'neutral',
        ring: true,
        status: entry.reason === 'idle' ? 'stopped after 15 min idle' : 'stopped',
        action: { label: 'Start again', run: true },
      }
    case 'unavailable':
      return { tone: 'neutral', ring: true, status: 'unavailable' }
  }
}

const ICONS = { 'Run and open': PlayIcon, Open: AppWindowIcon, View: FileTextIcon, 'Start again': RotateCcwIcon } as const

export function PreviewServerCard({
  entry,
  inPreview,
  onOpen,
}: {
  entry: ThreadPreviewServer
  inPreview: boolean
  /** Absent when the task view hosts no pane: the card then shows no action at all. */
  onOpen?: (request: Required<PreviewOpenRequest>) => void
}) {
  const { server } = entry
  const current = view(entry)
  const unavailable = entry.state === 'unavailable'
  const action = onOpen ? current.action : undefined
  const showingHere = inPreview && action !== undefined && !action.run
  const label = showingHere ? 'In preview' : action?.label
  const Icon = showingHere ? AppWindowIcon : action ? ICONS[action.label] : null
  // Screen 05 names the script, not its flags: `npm run dev` for `npm run dev -- --port 5173 ...`.
  // The exact command sits in the block above the note.
  const script = server.command.split(' -- ')[0]!.trim()
  const registered = shortAge(server.registeredAt)

  return (
    <div
      data-slot="preview-server-card"
      data-state={entry.state}
      className={cn('min-w-0 rounded-lg border border-border bg-card px-3.5 py-3 text-sm', unavailable && 'text-muted-foreground')}
    >
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-soft-foreground">
        <span className="flex min-w-0 items-center gap-1.5 font-mono">
          <ServerIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">cezar_preview_serve</span>
        </span>
        {unavailable ? <span>worktree removed</span> : registered ? <span>{registered} ago</span> : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={current.tone} shape={current.ring ? 'ring' : 'filled'} pulse={current.pulse === true} aria-hidden="true" />
          <span className="font-semibold text-foreground">{server.label}</span>
          <span className="font-mono text-muted-foreground">:{server.port}</span>
          <span className="text-muted-foreground">{current.status}</span>
        </div>
        {action && label && Icon ? (
          <Button
            variant={showingHere || action.label === 'View' || (action.label === 'Open' && entry.state === 'starting') ? 'outline' : 'contrast'}
            size="sm"
            className="max-md:h-11 max-md:px-3.5"
            onClick={() => onOpen?.({ port: server.port, run: action.run })}
          >
            <Icon aria-hidden="true" />
            {label}
          </Button>
        ) : null}
      </div>

      <div className="mt-2.5 min-w-0 rounded-md bg-muted px-3 py-2 font-mono text-xs">
        <p className="break-words whitespace-pre-wrap text-foreground">{server.command}</p>
        {server.cwd ? (
          <p className="mt-1 flex gap-3 text-soft-foreground">
            <span>cwd</span>
            <span className="break-all">{server.cwd}</span>
          </p>
        ) : null}
      </div>

      {action?.run ? (
        <Note icon={<SquareTerminalIcon className="size-3.5 shrink-0" aria-hidden="true" />}>
          {`${action.label === 'Start again' ? 'Starting again' : 'Opening'} runs ${script} in this task's worktree, on the host.`}
        </Note>
      ) : null}
      {unavailable ? (
        <Note>The worktree this server ran in is gone. Register it again from a new task.</Note>
      ) : null}
    </div>
  )
}

function Note({ icon, children }: { icon?: ReactNode; children: string }) {
  return (
    <p className="mt-2.5 flex items-start gap-2 text-xs text-muted-foreground">
      {icon}
      <span>{children}</span>
    </p>
  )
}
