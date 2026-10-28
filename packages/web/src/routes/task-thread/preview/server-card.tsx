import { AppWindowIcon, FileTextIcon, PlayIcon, RotateCcwIcon, ServerIcon, SquareTerminalIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { ThreadPreviewServer } from '../thread-state'
import { serverScript, serverStatus, type PreviewOpenRequest } from './preview-state'

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

/** Each server state supplies the same next action as its card row. */
const ACTIONS: Record<ThreadPreviewServer['state'], (entry: ThreadPreviewServer) => CardView['action']> = {
  registered: entry => entry.server.answeredAtRegistration
    ? { label: 'Open', run: false }
    : { label: 'Run and open', run: true },
  adopted: () => ({ label: 'Open', run: false }),
  starting: () => ({ label: 'Open', run: false }),
  up: () => ({ label: 'Open', run: false }),
  stalled: () => ({ label: 'View', run: false }),
  exited: () => ({ label: 'Start again', run: true }),
  stopped: () => ({ label: 'Start again', run: true }),
  unavailable: () => undefined,
}

function view(entry: ThreadPreviewServer): CardView {
  const { text, ...look } = serverStatus(entry)
  const status = { ...look, status: text }
  const action = ACTIONS[entry.state](entry)
  return action ? { ...status, action } : status
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
  onOpen?: ((request: Required<Pick<PreviewOpenRequest, 'port' | 'run'>>) => void) | undefined
}) {
  const { server } = entry
  const current = view(entry)
  const unavailable = entry.state === 'unavailable'
  const action = onOpen ? current.action : undefined
  // The exact command sits in the block above the note; the note names only the script.
  const script = serverScript(server.command)
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
        <CardAction entry={entry} inPreview={inPreview} action={action} onOpen={onOpen} />
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

function CardAction({ entry, inPreview, action, onOpen }: {
  entry: ThreadPreviewServer
  inPreview: boolean
  action: CardView['action']
  onOpen: ((request: Required<Pick<PreviewOpenRequest, 'port' | 'run'>>) => void) | undefined
}) {
  const { server } = entry
  const showingHere = inPreview && action !== undefined && !action.run
  const label = showingHere ? 'In preview' : action?.label
  const Icon = showingHere ? AppWindowIcon : action ? ICONS[action.label] : null
  return action && label && Icon ? (
    <Button
      variant={showingHere || action.label === 'View' || (action.label === 'Open' && entry.state === 'starting') ? 'outline' : 'contrast'}
      size="sm"
      className="max-md:h-11 max-md:px-3.5"
      onClick={() => onOpen?.({ port: server.port, run: action.run })}
    >
      <Icon aria-hidden="true" />
      {label}
    </Button>
  ) : null
}

function Note({ icon, children }: { icon?: ReactNode | undefined; children: string }) {
  return (
    <p className="mt-2.5 flex items-start gap-2 text-xs text-muted-foreground">
      {icon}
      <span>{children}</span>
    </p>
  )
}
