import { useRun } from '@/api/queries'
import { ArrowUpIcon } from '@/components/design-icons'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'

/** Parent navigation stays outside the activity disclosures and on every task tab. */
export function ParentTaskLink({ id }: { id: string }) {
  const parent = useRun(id)
  const title = parent.data ? runTitle(parent.data) : id
  return (
    <div data-slot="parent-task" className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
      <Link
        to={`/tasks/${id}`}
        aria-label={`Parent task ${id}`}
        title={`Parent · ${title}`}
        data-slot="parent-task-link"
        className="flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:text-foreground"
      >
        <ArrowUpIcon aria-hidden className="h-[1.2cap] w-auto shrink-0" />
        <span className="shrink-0">Parent</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 overflow-clip text-ellipsis whitespace-nowrap">{title}</span>
      </Link>
      {parent.isError ? <>
        <span>Parent record unavailable or deleted</span>
        <Button variant="outline" className="min-h-11" onClick={() => void parent.refetch()}>Retry parent task</Button>
      </> : null}
    </div>
  )
}
