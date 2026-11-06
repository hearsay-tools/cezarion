import type { ComponentType } from 'react'
import type { ActivityRequest } from '@open-mercato/cezar-api-client/contract/activity'
import type { LinkProps } from 'react-router'

import { nameOf, recipientName, sentPeerRequests, sentPeerWaits, type PeerWait, type RunEntry } from './activity-model'

/**
 * The text links that stand in for peer lines where no line is drawn (spec
 * 2026-11-05-live-activity-view, "Size, motion and access"): "→ <task>" for each peer request the
 * run sent, and "⋯ waits on <task>" for each peer it waits on. The project card and the global
 * pill each pass their own link component, task path and classes.
 */
export interface PeerLinksProps {
  runId: string
  requests: readonly ActivityRequest[]
  waits: readonly PeerWait[]
  index: ReadonlyMap<string, RunEntry>
  link: ComponentType<LinkProps>
  pathOf: (runId: string) => string
  /** The list's classes: its place in the card or pill, and when it shows. */
  className: string
  linkClassName: string
}

export function PeerLinks({ runId, requests, waits, index, link: To, pathOf, className, linkClassName }: PeerLinksProps) {
  const sent = sentPeerRequests(runId, requests)
  const waiting = sentPeerWaits(runId, waits)
  if (sent.length === 0 && waiting.length === 0) return null
  return (
    <ul data-slot="activity-peer-links" className={className}>
      {sent.map((request) => (
        <li key={request.requestId}>
          <To to={pathOf(request.recipientRunId)} className={linkClassName}>→ {recipientName(index, request)}</To>
        </li>
      ))}
      {waiting.map((wait) => (
        <li key={wait.id}>
          <To to={pathOf(wait.peerRunId)} className={linkClassName}>⋯ waits on {nameOf(index, wait.peerRunId)}</To>
        </li>
      ))}
    </ul>
  )
}
