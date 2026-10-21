import type { ApiRun } from '@open-mercato/cezar-api-client'
import { ReferenceChip } from '@/components/reference-chip'
import { runTitle } from '@/lib/task-groups'
import { referenceKey, type TaskReference } from '@/lib/tasks-table'

/** Summary chips sit inside disclosure buttons. The expanded Workspace and CI details own
 * their links, so these summaries use the chip's inert treatment, without nested controls. */
export function ActivityReferences({ run, references }: { run: ApiRun; references: TaskReference[] }) {
  return <span className="inline-flex items-center gap-1.5">
    {references.map(reference => (
      <span key={referenceKey(reference)} className="inline-flex items-center rounded-md border border-border px-1.5 text-[12px]">
        {reference.kind === 'Issue' ? <span className="me-1">Issue</span> : null}
        <ReferenceChip reference={reference} taskTitle={runTitle(run)} plain inert />
      </span>
    ))}
  </span>
}
