import { Button } from '@/components/ui/button'
import type { GroupBy } from '@/lib/global-tasks'
import { Link } from 'react-router'
import { ArchiveIcon, LayersIcon } from '@/components/design-icons'
import { ListChecksIcon, SearchXIcon } from 'lucide-react'
import { CenteredState } from '@/components/centered-state'
import { scopeTo } from '@/lib/project-router'
import type { ListView } from '@/lib/task-groups'

/** Projects whose older archived tasks the index left out, and where to find them. */
export function TruncatedNotice({ projects, perProjectLimit }: { projects: readonly string[]; perProjectLimit: number | undefined }) {
  if (projects.length === 0) return null
  return (
    <p data-slot="global-tasks-truncated" className="text-[11px] text-soft-foreground">
      Showing every active task and the newest {perProjectLimit} archived tasks per project — older archived tasks in{' '}
      {projects.join(', ')} are in that project&rsquo;s own Tasks page.
    </p>
  )
}

/** A door to each registered project's own Tasks page, once there is more than one. */
export function OtherProjects({ registry }: { registry: readonly { id: string; name: string }[] }) {
  if (registry.length <= 1) return null
  return (
    <section data-slot="other-projects" className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-base font-semibold">Other projects</h2>
      <div className="mt-3 flex flex-col divide-y divide-border">{registry.map((project) => <div key={project.id} className="flex min-h-14 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[13px]">{project.name}</span>
        <Link to={scopeTo(project.id, '/')} className="inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-xs text-accent-text hover:bg-accent-strong/10">View tasks<span className="sr-only"> for {project.name}</span></Link>
      </div>)}</div>
    </section>
  )
}

/** What an empty global list honestly means, given how it got empty. */
export function GlobalTasksEmptyState({ view, filtered }: { view: ListView; filtered: boolean }) {
  if (filtered) {
    return (
      <CenteredState
        heading="h2"
        icon={<SearchXIcon />}
        tone="neutral"
        title="No matching tasks"
        subtitle="No task in any project matches these filters."
      />
    )
  }
  return view === 'archived' ? (
    <CenteredState
      heading="h2"
      icon={<ArchiveIcon />}
      tone="neutral"
      title="Nothing archived yet"
      subtitle="Finished tasks you archive land here, from every project."
    />
  ) : (
    <CenteredState
      heading="h2"
      icon={<ListChecksIcon />}
      tone="neutral"
      title="No tasks yet"
      subtitle="Start a task in any project and it shows up here."
    />
  )
}

/** The page when the index or the registry did not load: the reason, and Retry. */
export function GlobalTasksLoadError({ groupBy, filterDetailsOpen, message, onRetry }: {
  groupBy: GroupBy
  filterDetailsOpen: boolean
  message: string
  onRetry: () => void
}) {
  return (
    <div data-route="global-tasks" data-presentation={groupBy === 'none' ? 'summary' : 'cards'} data-filter-details={filterDetailsOpen} className="flex min-h-full flex-col gap-[22px] px-[18px] pt-6 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-9">
      <CenteredState
        icon={<LayersIcon />}
        tone="danger"
        title="Tasks across projects did not load"
        subtitle={message}
        actions={<Button variant="outline" onClick={onRetry}>Retry</Button>}
      />
    </div>
  )
}

