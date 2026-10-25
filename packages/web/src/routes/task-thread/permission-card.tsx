import { useId, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError } from '@/api/client'
import { usePermissionDecision } from '@/api/permissions'
import { Button } from '@/components/ui/button'
import type { ThreadPermission } from './thread-state'

const subscribeOnline = (notify: () => void) => {
  window.addEventListener('online', notify)
  window.addEventListener('offline', notify)
  return () => {
    window.removeEventListener('online', notify)
    window.removeEventListener('offline', notify)
  }
}
const isOnline = () => navigator.onLine

/** Native permission choices stay bound to the session that offered them. */
export function PermissionCard({ permission, runId, sessionOpen = false }: {
  permission: ThreadPermission
  runId: string
  sessionOpen?: boolean
}) {
  if (permission.status !== 'pending' || !sessionOpen) {
    return <PermissionChoices permission={permission} state={permission.status === 'resolved' ? 'resolved' : 'expired'} />
  }
  return <PendingPermission key={permission.requestId} permission={permission} runId={runId} />
}

function PendingPermission({ permission, runId }: { permission: ThreadPermission; runId: string }) {
  const decision = usePermissionDecision(runId)
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => false)
  const sending = useRef(false)
  const [state, setState] = useState<'pending' | 'sending' | 'resolved' | 'expired'>('pending')
  const [optionId, setOptionId] = useState<string>()
  const [error, setError] = useState<string>()
  const select = async (id: string) => {
    if (sending.current || !online || state !== 'pending') return
    sending.current = true
    setState('sending')
    setError(undefined)
    try {
      await decision.mutateAsync({ requestId: permission.requestId, optionId: id })
      setOptionId(id)
      setState('resolved')
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setState('expired')
      } else {
        setError(cause instanceof Error ? cause.message : String(cause))
        setState('pending')
      }
    } finally {
      sending.current = false
    }
  }
  return <PermissionChoices permission={{ ...permission, ...(optionId === undefined ? {} : { optionId }) }} state={state} offline={!online} error={error} onSelect={id => { void select(id) }} />
}

function PermissionChoices({ permission, state, offline = false, error, onSelect }: {
  permission: ThreadPermission
  state: 'pending' | 'sending' | 'resolved' | 'expired'
  offline?: boolean
  error?: string | undefined
  onSelect?: ((optionId: string) => void) | undefined
}) {
  const titleId = useId()
  const selected = permission.options.find(option => option.id === permission.optionId)
  const disabled = state !== 'pending' || offline || !onSelect
  const status = state === 'expired' ? 'Approval expired. This session can no longer accept a decision.'
    : state === 'resolved' ? `Decision sent: ${selected?.label ?? 'Recorded'}.`
    : state === 'sending' ? 'Sending decision…'
    : offline ? 'Offline. Reconnect to send a decision.'
    : 'Choose an option to respond to this permission request.'
  return (
    <section data-slot="permission-card" data-request-id={permission.requestId} data-state={offline && state === 'pending' ? 'offline' : state} aria-labelledby={titleId} aria-busy={state === 'sending'}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3.5 text-sm [overflow-wrap:anywhere]">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Permission request</span>
        <h3 id={titleId} className="font-semibold whitespace-pre-wrap">{permission.title}</h3>
      </div>
      {permission.details ? <pre className="min-w-0 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{permission.details}</pre> : null}
      <div role="group" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2">
        {permission.options.map(option => (
          <Button key={option.id} type="button" variant="outline" disabled={disabled} aria-pressed={permission.optionId === option.id}
            className="h-auto min-h-11 min-w-0 max-w-full justify-start py-2 text-start whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => onSelect?.(option.id)}>{option.label}</Button>
        ))}
      </div>
      <p role="status" className="text-xs text-muted-foreground">{status}{permission.reason ? ` ${permission.reason}` : ''}</p>
      {error && state === 'pending' ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    </section>
  )
}
