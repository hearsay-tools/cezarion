import { useEffect, useMemo, useRef, useState } from 'react'

import { getCheckoutProgress } from '@/api/client'
import { onWorkspaceEvent } from '@/api/global-events'
import { onLiveReconcile } from '@/api/live-coordinator'
import type { CheckoutProgressEvent } from '@open-mercato/cezar-api-client'

export function useCheckoutProgress(idPrefix: string, isPending: boolean) {
  const [progress, setProgress] = useState<string | null>(null)
  // One id per mounted dialog. Each dialog mounts only while open, so a stale event
  // from an abandoned attempt never drives this one's progress line.
  const checkoutId = useMemo(() => `${idPrefix}${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`, [])

  // Kept in a ref, not state: the listener below must read the CURRENT id without re-subscribing
  // (a resubscribe per render would drop events between teardown and setup).
  const idRef = useRef(checkoutId)
  idRef.current = checkoutId

  useEffect(() => {
    return onWorkspaceEvent((eventName, payload) => {
      if (eventName !== 'checkout-progress') return
      const event = payload as CheckoutProgressEvent
      if (event?.checkoutId !== idRef.current) return
      // `error` is surfaced through the mutation's own rejection (the response carries it too),
      // so the terminal phases only stop the progress line rather than racing it.
      if (event.phase === 'cloning' && event.line) setProgress(event.line)
      else if (event.phase !== 'cloning') setProgress(null)
    })
  }, [])

  useEffect(() => onLiveReconcile(async signal => {
    if (!isPending) return
    // Progress is optional; the checkout mutation owns success/error reporting. A
    // failed progress refresh must not hold the document's live restoration gate.
    const response = await getCheckoutProgress(checkoutId, { signal }).catch(() => null)
    if (!response) return
    const { progress: event } = response
    if (signal.aborted || event?.checkoutId !== idRef.current) return
    setProgress(event?.phase === 'cloning' ? event.line ?? null : null)
  }), [isPending, checkoutId])

  return { checkoutId, progress, setProgress }
}
