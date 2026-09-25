import { BellOffIcon, InfoIcon, MessageSquareIcon, SendIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { useNotifyRun, useProjects } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { ChevronDownIcon } from '@/components/design-icons'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { useActiveProjectId } from '@/lib/project-router'
import { webhookLabel } from '@/lib/webhook'

/**
 * "Hand off" (#589, spec 2026-09-25-task-webhook-handoff): give the rest of a task to the bot
 * behind the project's task webhook with one click. The button opens a dialog with an optional
 * note — a bottom sheet on a phone — and, once on, becomes a "Notifying" chip whose menu sends
 * another note or stops notifying.
 *
 * The note goes to the webhook only, never into the agent session, and the dialog says so: a
 * user who wants the agent to know something writes to the agent. Rendered only when there is
 * somewhere to notify — the project has a webhook, or this run is already notifying one that has
 * since been removed, so it can still be switched off.
 */
export function HandoffAction({ run }: { run: ApiRun }) {
  const projectId = useActiveProjectId()
  const projects = useProjects()
  const notify = useNotifyRun(run.id)
  const [dialog, setDialog] = useState<'handoff' | 'note' | null>(null)

  const entry = projects.data?.projects?.find((project) => project.id === (projectId ?? projects.data?.bootProject))
  const url = entry?.webhook?.url
  const notifying = run.notify === true
  if (!url && !notifying) return null

  const stop = () =>
    notify.mutate(
      { notify: false },
      {
        onSuccess: () => toast('Stopped notifying the webhook'),
        onError: (error: Error) => toast(`Could not stop notifying. ${error.message}`, { tone: 'danger' }),
      },
    )

  return (
    <>
      {notifying ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              data-slot="notifying-chip"
              className="h-11 gap-1.5 md:h-[30px]"
              aria-label={url ? `Notifying ${webhookLabel(url)} — webhook actions` : 'Notifying — webhook actions'}
            >
              <StatusDot tone="success" />
              <span>Notifying</span>
              <ChevronDownIcon aria-hidden="true" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-slot="notifying-menu" className="w-[240px] max-w-[calc(100vw-2rem)] p-2">
            {url ? (
              <DropdownMenuLabel className="truncate px-2 py-1.5 font-mono text-[11px] font-normal text-muted-foreground">
                {webhookLabel(url)}
              </DropdownMenuLabel>
            ) : null}
            {url ? (
              <DropdownMenuItem className="min-h-11" onSelect={() => setDialog('note')}>
                <MessageSquareIcon aria-hidden="true" /> Send a note…
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem variant="destructive" className="min-h-11" disabled={notify.isPending} onSelect={stop}>
              <BellOffIcon aria-hidden="true" /> Stop notifying
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          variant="outline"
          size="sm"
          data-action="handoff"
          className="size-11 px-0 md:h-[30px] md:w-auto md:px-2.5"
          aria-label="Hand off to webhook"
          onClick={() => setDialog('handoff')}
        >
          <SendIcon aria-hidden="true" />
          <span className="max-md:sr-only">Hand off</span>
        </Button>
      )}
      {url ? (
        <HandoffDialog
          mode={dialog}
          url={url}
          pending={notify.isPending}
          onOpenChange={(open) => !open && setDialog(null)}
          onSubmit={(message) =>
            notify.mutate(
              { notify: true, ...(message ? { message } : {}) },
              {
                onSuccess: () => {
                  setDialog(null)
                  toast(dialog === 'note' ? 'Note sent to the webhook' : 'Handed off to the webhook')
                },
                onError: (error: Error) => toast(`Could not hand off. ${error.message}`, { tone: 'danger' }),
              },
            )
          }
        />
      ) : null}
    </>
  )
}

/**
 * The hand-off dialog. One component for both widths: below `sm` the same Radix dialog is pinned
 * to the bottom edge as a sheet, with full-width stacked actions inside the thumb zone and the
 * safe-area inset under them. CSS only, so resizing never swaps the component under a user who
 * is typing a note.
 */
function HandoffDialog({
  mode,
  url,
  pending,
  onOpenChange,
  onSubmit,
}: {
  mode: 'handoff' | 'note' | null
  url: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (message: string) => void
}) {
  const noteId = useId()
  const hintId = useId()
  const [note, setNote] = useState('')
  // The dialog stays mounted between uses, so a note already sent must not reopen with it.
  useEffect(() => {
    if (mode !== null) setNote('')
  }, [mode])
  const isNote = mode === 'note'
  const label = webhookLabel(url)

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) setNote('')
        onOpenChange(open)
      }}
    >
      <DialogContent
        data-slot="handoff-dialog"
        className="max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-xl max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[max(1.5rem,env(safe-area-inset-bottom))] max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=closed]:slide-out-to-bottom max-sm:data-[state=closed]:zoom-out-100"
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(note.trim())
          }}
        >
          <DialogHeader className="text-left">
            <DialogTitle>{isNote ? 'Send a note to the webhook' : 'Hand off to webhook'}</DialogTitle>
            <DialogDescription>
              {isNote
                ? `The bot at ${label} gets this note with the task's current status.`
                : `The bot at ${label} will start receiving this task's status updates. Add a note for it (optional).`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor={noteId} className="text-[13px] font-medium">
              Note
            </label>
            <Textarea
              id={noteId}
              data-slot="handoff-note"
              aria-describedby={hintId}
              rows={4}
              maxLength={100_000}
              className="min-h-24"
              placeholder="e.g. Take over from here, ping me when the PR is green"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <p id={hintId} className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
              The note goes to the webhook only, not to the agent.
            </p>
          </div>
          <DialogFooter className="gap-2 max-sm:flex-col-reverse max-sm:[&>button]:h-11 max-sm:[&>button]:w-full">
            <Button type="button" variant="ghost" className="sm:h-9" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contrast"
              className="sm:h-9"
              data-action="handoff-submit"
              disabled={pending || (isNote && note.trim() === '')}
            >
              <SendIcon aria-hidden="true" />
              {isNote ? 'Send note' : 'Hand off'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
