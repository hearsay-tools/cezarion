import type { GithubData } from '@open-mercato/cezar-api-client'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const control = 'min-h-11 min-w-11 rounded-md border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-ring disabled:opacity-50'

/** Issue-only controls. A metadata failure disables its own filter, never the list. */
export function IssueFilters({ data, assignees, projectId, onAssigneesChange, onProjectChange }: {
  data: GithubData
  assignees: readonly string[]
  projectId: string
  onAssigneesChange: (next: string[]) => void
  onProjectChange: (next: string) => void
}) {
  const logins = new Map<string, string>()
  for (const issue of data.issues) for (const login of issue.assignees ?? []) logins.set(login.toLowerCase(), login)
  for (const login of assignees) logins.set(login.toLowerCase(), login)
  const options = [...logins.values()].sort((a, b) => a.localeCompare(b))
  const isMe = !!data.viewerLogin && assignees.length === 1 && assignees[0]?.toLowerCase() === data.viewerLogin.toLowerCase()
  return (
    <div className="flex flex-wrap items-center gap-2" data-slot="gh-issue-filters">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={control} disabled={options.length === 0}>
            Assignees{assignees.length ? ` · ${assignees.length}` : ''}
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
      <button type="button" className={`${control} aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background`} disabled={!data.viewerLogin} aria-pressed={isMe}
        onClick={() => onAssigneesChange(isMe ? [] : [data.viewerLogin!])}>
        Assigned to me
      </button>
      {!data.viewerLogin ? <p className="w-full text-xs text-muted-foreground">GitHub login unavailable.</p> : null}
      {data.projects?.length ? (
        <select aria-label="Project board" className={control} value={projectId}
          onChange={event => onProjectChange(event.target.value)}>
          <option value="">All boards</option>
          {data.projects.map(board => <option key={board.id} value={board.id}>{board.title}</option>)}
        </select>
      ) : <p className="w-full text-xs text-muted-foreground">{data.projectsReason ?? (data.projects ? 'No linked project boards.' : 'Project boards unavailable.')}</p>}
    </div>
  )
}
