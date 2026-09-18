import type { ToolStatus } from '@open-mercato/cezar-api-client'

import { subagentActivityText, type SubagentSummary } from './subagent-dock'

/**
 * The sub-agent rows (spec `.ai/specs/2026-07-20-grouped-subagent-display.md` §"Agents dock",
 * issue #474): one line per agent of the current fan-out — glyph, title, type badge, what it
 * is doing now, tool count.
 *
 * They answer the one question the transcript cannot — *what is running right now* — because
 * task cards sit at their stream position and scroll away while their agents still work.
 * Since #402 the rows no longer carry a dock of their own: they are the body of the Run
 * activity accordion's **Subagents** section, which owns the head, the odometer and the
 * collapse memory (`run-activity-dock.tsx`).
 *
 * Unlike the plan, this does NOT hide anything from the thread: sub-agent cards stay where
 * they streamed (spec Q4). The plan is state, an agent's output is transcript.
 */
export function AgentList({
  agents,
  onSelect,
}: {
  agents: SubagentSummary[]
  /** Phase 2: opens the drill-down sheet. Absent ⇒ rows are static display. */
  onSelect?: (id: string) => void
}) {
  // No fan-out to show — the overwhelming majority of runs never mount this at all.
  if (agents.length === 0) return null
  return (
    <ul data-slot="agents-list" className="flex min-w-0 flex-col gap-[7px]">
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} onSelect={onSelect} />
      ))}
    </ul>
  )
}

/** Rows keep stream order and never re-sort on completion — a finishing agent must not make
 *  the row the user is reading jump somewhere else (spec §Edge Cases). */
function AgentRow({ agent, onSelect }: { agent: SubagentSummary; onSelect?: (id: string) => void }) {
  const body = (
    <>
      <AgentIcon status={agent.status} stalled={agent.stalled === true} />
      <span className="min-w-0 shrink truncate font-medium">{agent.title}</span>
      {agent.agentType !== undefined ? (
        <span
          data-slot="agent-type"
          className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase"
        >
          {agent.agentType}
        </span>
      ) : null}
      <span data-slot="agent-activity" className="min-w-0 flex-1 truncate text-muted-foreground">
        {subagentActivityText(agent)}
      </span>
      <span data-slot="agent-tools" className="shrink-0 text-muted-foreground tabular-nums">
        {agent.toolCalls} {agent.toolCalls === 1 ? 'tool' : 'tools'}
      </span>
    </>
  )

  return (
    <li data-slot="agent-item" data-status={agent.status} className="min-w-0 text-[13px]">
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(agent.id)}
          aria-haspopup="dialog"
          className="flex min-h-5 w-full min-w-0 items-center gap-2.5 rounded-sm text-left hover:bg-muted/50"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-h-5 min-w-0 items-center gap-2.5">{body}</div>
      )}
    </li>
  )
}

/**
 * The plan dock's glyph language, so the two docks read as one system: a pulsing half-disc
 * while working, a ✓ when done, a ✕ when not. Status is never color-only — the shapes differ,
 * which is what makes the dock legible to a color-blind reader (spec §Accessibility).
 */
function AgentIcon({ status, stalled = false }: { status: ToolStatus; stalled?: boolean }) {
  // The run ended while this agent was still in flight: it never finished and never will.
  // Shown as an interrupted ring — NOT the pulsing "working" glyph (it is not working) and not
  // a ✓ (it did not succeed). The status itself is left untouched; only the reading changes.
  if (stalled) {
    return (
      <svg
        aria-hidden
        data-slot="agent-glyph"
        data-stalled="true"
        className="size-[15px] shrink-0 text-soft-foreground"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="3 2.5"
      >
        <circle cx="12" cy="12" r="8.5" />
      </svg>
    )
  }
  if (status === 'completed') {
    return (
      <svg
        aria-hidden
        data-slot="agent-glyph"
        className="size-[15px] shrink-0 text-success"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" opacity=".35" />
        <path d="m8.5 12.2 2.4 2.4 4.6-5" />
      </svg>
    )
  }
  if (status === 'failed' || status === 'declined') {
    return (
      <svg
        aria-hidden
        data-slot="agent-glyph"
        className="size-[15px] shrink-0 text-danger"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="9" opacity=".35" />
        <path d="m9 9 6 6M15 9l-6 6" />
      </svg>
    )
  }
  return (
    <svg
      aria-hidden
      data-slot="agent-glyph"
      className="size-[15px] shrink-0 animate-pulse motion-reduce:animate-none"
      viewBox="0 0 24 24"
      fill="none"
    >
      {/* stroke/fill-pending, not text-*: amber is a dot & spinner color only (guardian rule). */}
      <circle className="stroke-pending" cx="12" cy="12" r="8.5" strokeWidth="2" />
      <path className="fill-pending" d="M12 3.5 A8.5 8.5 0 0 1 12 20.5 Z" />
    </svg>
  )
}
