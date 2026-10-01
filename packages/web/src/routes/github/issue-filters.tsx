import { useEffect, useRef, useState } from 'react'
import type { GithubData } from '@open-mercato/cezar-api-client'
import { ChevronDownIcon, RefreshCwIcon, TriangleAlertIcon } from '@/components/design-icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// The picker is sized by the control, never by its option text, so loading / unavailable / board names cannot move it.
const picker = 'w-44 max-w-full'
const control = 'min-h-11 min-w-11 rounded-md border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-ring disabled:opacity-50'

/** Issue-only controls. A metadata failure disables its own filter, never the list. */
export function IssueFilters({ data, assignees, projectId, onAssigneesChange, onProjectChange }: {
  data: GithubData
  assignees: readonly string[]
  projectId: string
  onAssigneesChange: (next: string[]) => void
  onProjectChange: (next: string) => void
}) {
  const [statusOpen, setStatusOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLSelectElement>(null)
  const meRef = useRef<HTMLButtonElement>(null)
  const logins = new Map<string, string>()
  for (const issue of data.issues) for (const login of issue.assignees ?? []) logins.set(login.toLowerCase(), login)
  for (const login of assignees) logins.set(login.toLowerCase(), login)
  const options = [...logins.values()].sort((a, b) => a.localeCompare(b))
  const isMe = !!data.viewerLogin && assignees.length === 1 && assignees[0]?.toLowerCase() === data.viewerLogin.toLowerCase()
  const kept = ' Previous memberships are shown; issues with unknown membership remain visible.'
  const status = data.projectsState === 'refreshing' && data.projects ? `Refreshing project boards.${kept}`
    : data.projectsState === 'unavailable' && data.projects ? `${data.projectsReason}${kept}`
    : data.projects ? '' : data.projectsReason ?? (data.projectsState === 'refreshing' ? 'Project memberships pending.' : 'Project boards unavailable.')
  const message = [!data.viewerLogin ? 'GitHub login unavailable.' : '', status].filter(Boolean).join(' ')
  const hasMessage = message !== ''
  // The popover stays mounted for the frame in which focus is handed over, so keep its last words.
  const lastMessage = useRef(message)
  if (hasMessage) lastMessage.current = message
  const messageGone = useRef(!hasMessage)
  messageGone.current = !hasMessage
  const handOffFocus = () => (pickerRef.current && !pickerRef.current.disabled ? pickerRef.current : meRef.current)?.focus()
  useEffect(() => {
    const node = triggerRef.current
    if (!node) return
    // Hiding the focused button blurs it while React is committing, where React drops its own focus
    // events, so listen natively. The browser clears focus after this event, so hand over once it settled.
    const onBlur = (event: FocusEvent) => {
      if (messageGone.current && !event.relatedTarget) requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) handOffFocus()
      })
    }
    node.addEventListener('blur', onBlur)
    return () => node.removeEventListener('blur', onBlur)
  }, [])
  useEffect(() => {
    if (hasMessage) return
    // The status button hides itself once there is nothing to say. Close it, and if focus was in it
    // hand focus to the control the message was about instead of letting it fall to <body>.
    const active = document.activeElement
    const held = !!active && (active === triggerRef.current || !!contentRef.current?.contains(active))
    setStatusOpen(false)
    if (held) handOffFocus()
  }, [hasMessage])
  return (
    <div className="contents" data-slot="gh-issue-filters">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={control} disabled={options.length === 0}>
            Assignee{assignees.length ? ` · ${assignees.length}` : ''}
            <ChevronDownIcon size={12} aria-hidden="true" className="ml-1 inline size-3 shrink-0 align-[-1px] text-soft-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 max-w-[calc(100vw-2rem)] p-2">
          <fieldset className="max-h-[min(16rem,var(--radix-popover-content-available-height))] overflow-y-auto">
            <legend className="px-2 text-xs text-muted-foreground">Match any selected assignee</legend>
            {options.map(login => {
              const checked = assignees.some(a => a.toLowerCase() === login.toLowerCase())
              return <label key={login.toLowerCase()} className="flex min-h-11 cursor-pointer items-center gap-2 rounded px-2 hover:bg-muted">
                <input type="checkbox" checked={checked} onChange={() => onAssigneesChange(checked
                  ? assignees.filter(a => a.toLowerCase() !== login.toLowerCase()) : [...assignees, login])} />
                <span className="break-all text-sm">{login}</span>
              </label>
            })}
          </fieldset>
        </PopoverContent>
      </Popover>
      <button ref={meRef} type="button" className={`${control} aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background`} disabled={!data.viewerLogin} aria-pressed={isMe}
        onClick={() => onAssigneesChange(isMe ? [] : [data.viewerLogin!])}>
        Assigned to me
      </button>
      {data.projects?.length ? (
        <select ref={pickerRef} aria-label="Project board" className={`${control} ${picker}`} value={projectId}
          onChange={event => onProjectChange(event.target.value)}>
          <option value="">All boards</option>
          {data.projects.map(board => <option key={board.id} value={board.id}>{board.title}</option>)}
        </select>
      ) : data.projects || data.projectsState ? (
        <select ref={pickerRef} aria-label="Project board" className={`${control} ${picker}`} disabled value="">
          <option value="">{data.projects ? 'No boards' : data.projectsState === 'refreshing' ? 'Loading boards…' : 'Boards unavailable'}</option>
        </select>
      ) : null}
      {/* Always mounted at one fixed size: a message that appeared or wrapped inline would move every
          control and the list below it. The live text is read aloud from the status; sighted users
          open the full wrapped text from the button, which works by touch as well as by hover. */}
      <p role="status" className="sr-only">{message}</p>
      <Popover open={statusOpen} onOpenChange={setStatusOpen}>
        <PopoverTrigger asChild>
          <button ref={triggerRef} type="button" className={`${control} inline-flex items-center justify-center ${message ? '' : 'invisible'}`} aria-label="Project board status" tabIndex={message ? undefined : -1}>
            {data.projectsState === 'refreshing'
              ? <RefreshCwIcon size={14} aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
              : <TriangleAlertIcon size={14} aria-hidden="true" className="size-3.5" />}
          </button>
        </PopoverTrigger>
        <PopoverContent ref={contentRef} align="start" data-slot="gh-issue-status" onCloseAutoFocus={event => { if (!hasMessage) event.preventDefault() }} className="w-72 max-w-[calc(100vw-2rem)] p-3 text-xs text-muted-foreground">{message || lastMessage.current}</PopoverContent>
      </Popover>
    </div>
  )
}
