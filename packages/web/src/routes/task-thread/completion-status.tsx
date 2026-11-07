import type { ApiRun } from '@open-mercato/cezar-api-client'

import { usePatchRun } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { isHttpUrl } from '@/lib/utils'
import { Link } from '@/lib/project-router'
import { ArchiveButton } from './archive-action'
import { runActionFlags } from './run-actions'

type CompletionAction = NonNullable<ApiRun['completionAction']>
type ArchiveBlocker = NonNullable<ApiRun['archiveBlocker']>
type RunPatch = ReturnType<typeof usePatchRun>
type RunFlags = ReturnType<typeof runActionFlags>

/** The pending (or blocked) completion action: its status line and its Open PR / Disable
 *  auto-merge buttons. */
function CompletionActionBody({ run, action, prUrl, patch }: {
  run: ApiRun
  action: CompletionAction
  prUrl: string | undefined
  patch: RunPatch
}) {
  return (
    <>
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm [overflow-wrap:anywhere]">
        <span className="font-medium">{action.phase === 'blocked' ? 'Completion blocked' : 'Completion pending'}</span>
        {' · '}{action.message || (action.phase === 'blocked' ? 'Completion needs attention.' : 'Checking completion actions.')}
      </p>
      <div className="flex flex-wrap gap-2">
        {prUrl && isHttpUrl(prUrl) ? <Button variant="outline" asChild><a href={prUrl} target="_blank" rel="noopener noreferrer">Open PR</a></Button> : null}
        {run.autoMergePr ? <Button variant="outline" disabled={patch.isPending} onClick={() => patch.mutate({ autoMergePr: false }, {
          onError: error => toast(error.message, { tone: 'danger' }),
        })}>{patch.isPending ? 'Saving…' : 'Disable auto-merge'}</Button> : null}
      </div>
    </>
  )
}

/** The blocked-archive note: why archiving was refused and how to reach what blocks it. */
function ArchiveBlockerBody({ run, blocker, flags }: {
  run: ApiRun
  blocker: ArchiveBlocker
  flags: RunFlags
}) {
  return (
    <>
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm [overflow-wrap:anywhere]">
        <span className="font-medium">Archive blocked</span>{' · '}{blocker.message}
      </p>
      <div className="flex flex-wrap gap-2">
        {blocker.runId ? <Button variant="outline" asChild><Link to={`/tasks/${blocker.runId}`}>Open blocking task</Link></Button> : null}
        {blocker.pullRequestUrl && isHttpUrl(blocker.pullRequestUrl) ? <Button variant="outline" asChild><a href={blocker.pullRequestUrl} target="_blank" rel="noopener noreferrer">Open blocking PR</a></Button> : null}
        {flags.archive ? <ArchiveButton run={run} /> : null}
      </div>
    </>
  )
}

/** Completion work remains visible after Done, including after a page reload. */
export function CompletionStatus({ run }: { run: ApiRun }) {
  const patch = usePatchRun(run.id)
  const flags = runActionFlags(run)
  const action = run.status === 'done' ? run.completionAction : undefined
  const blocker = flags.archive ? run.archiveBlocker : undefined
  const pendingAction = action && action.phase !== 'complete' ? action : undefined
  if (!pendingAction && !blocker) return null
  const prUrl = run.pullRequestUrl ?? run.pullRequests?.find(pr => pr.url)?.url
  return (
    <section data-slot="completion-status" aria-label="Completion action" className="grid min-w-0 gap-2 rounded-lg border border-border bg-card p-3 [margin-block:0.75rem]">
      {pendingAction ? <CompletionActionBody run={run} action={pendingAction} prUrl={prUrl} patch={patch} /> : null}
      {blocker ? <ArchiveBlockerBody run={run} blocker={blocker} flags={flags} /> : null}
    </section>
  )
}
