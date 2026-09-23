import * as React from 'react'
import type { ApplicationUpdateState } from '@open-mercato/cezar-api-client'
import { DownloadIcon, RefreshCwIcon } from '@/components/design-icons'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { isNewerVersion } from '@/lib/is-newer-version'

export type ApplicationUpdateControlProps = {
  version: string | null
  latestVersion: string | null
  state?: ApplicationUpdateState
  onApplyUpdate?: () => Promise<void>
  onRestart?: () => Promise<void>
  error?: string | null
  busy?: boolean
  offline?: boolean
}

/** The same compact control is rendered in the desktop sidebar and mobile drawer. */
export function ApplicationUpdateControl({ version, latestVersion, state, onApplyUpdate, onRestart, error, busy = false, offline = false }: ApplicationUpdateControlProps) {
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const restartTrigger = React.useRef<HTMLButtonElement>(null)
  const pending = React.useRef(false)
  const ready = state?.status === 'ready'
  const preparing = state?.status === 'preparing'
  const restarting = state?.status === 'restarting'
  const available = Boolean(version && latestVersion && isNewerVersion(latestVersion, version))
  const canRestart = state?.supported && ready && Boolean(onRestart)
  const canApply = state?.supported && available && Boolean(onApplyUpdate)
  const action = !state?.supported ? null : ready || restarting ? 'restart' : preparing || canApply ? 'update' : null
  const actionBusy = busy || preparing || restarting
  const tooltip = action === 'restart' ? 'Restart required' : preparing ? 'Preparing update' : `Update from v${version} to v${latestVersion}`

  const apply = () => {
    if (!canApply || actionBusy || offline || pending.current) return
    pending.current = true
    void onApplyUpdate?.().finally(() => { pending.current = false })
  }
  const restart = () => {
    if (!canRestart || actionBusy || offline || pending.current) return
    pending.current = true
    setConfirmOpen(false)
    void onRestart?.().finally(() => { pending.current = false })
  }

  return <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
    <div data-slot="application-update-action" className="flex size-11 shrink-0 items-center justify-center">
      {action ? <TooltipProvider><Tooltip><TooltipTrigger asChild>
        {action === 'update' ? <Button variant="ghost" size="icon" className="size-11 motion-safe:transition-transform motion-safe:duration-[var(--app-duration-1)] motion-safe:active:scale-[0.97]" aria-label={preparing ? 'Preparing update' : 'Update application'} aria-busy={actionBusy} disabled={!canApply || actionBusy || offline} title={tooltip} onClick={apply}><DownloadIcon aria-hidden="true" className="size-[18px]" /></Button>
          : <Button ref={restartTrigger} variant="ghost" size="icon" className="size-11 motion-safe:transition-transform motion-safe:duration-[var(--app-duration-1)] motion-safe:active:scale-[0.97]" aria-label={restarting ? 'Reconnecting after restart' : 'Restart application'} aria-busy={actionBusy} disabled={!canRestart || actionBusy || offline} title={tooltip} onClick={() => setConfirmOpen(true)}><RefreshCwIcon aria-hidden="true" className="size-[18px]" /></Button>}
      </TooltipTrigger><TooltipContent side="bottom">{tooltip}</TooltipContent></Tooltip></TooltipProvider> : null}
    </div>
      <AlertDialogContent onCloseAutoFocus={(event) => { event.preventDefault(); restartTrigger.current?.focus() }}>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart Cezarion?</AlertDialogTitle>
          <AlertDialogDescription>Running tasks will be recovered after restart. The cockpit will reconnect when the new version is ready.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Restart Later</AlertDialogCancel>
          <AlertDialogAction onClick={restart}>Restart Now</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
  </AlertDialog>
}

export function ApplicationUpdateFeedback({ state, error, offline = false, busy = false }: Pick<ApplicationUpdateControlProps, 'state' | 'error' | 'offline' | 'busy'>) {
  const failure = error ?? (state?.status === 'error' ? state.message ?? 'Update failed.' : null)
  const message = failure ? null
    : offline ? 'Connection lost. Reconnect to continue.'
        : state?.status === 'preparing' || busy && state?.status !== 'ready' ? 'Preparing update.'
          : state?.status === 'restarting' ? 'Restarting. Reconnecting to the cockpit.'
            : busy && state?.status === 'ready' ? 'Checking update status.'
            : state && !state.supported ? state.message ?? 'Use your installation’s update method.' : null
  return <div data-slot="application-update-feedback" className="min-h-10 shrink-0 px-4 pt-1 text-[11px] leading-4 text-muted-foreground">
    {failure ? <p role="status"><span className="block truncate" title={failure}>{failure}</span><span className="block">Retry or update manually.</span></p> : message ? <p role="status" title={message}>{message}</p> : null}
  </div>
}
