import { useState } from 'react'
import { useHealth, useProjects } from '@/api/queries'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { githubRepoBase } from '@/lib/tasks-table'

/** Shared navigation frame 24: existing project launchers and live tool diagnostics. */
export function WorkspaceToolsRoute() {
  const health = useHealth()
  const projects = useProjects()
  const repository = githubRepoBase(health.data?.repo?.remote)
  const [projectAction, setProjectAction] = useState<'local' | 'clone' | null>(null)
  const [copying, setCopying] = useState(false)
  const copyDiagnostics = async () => {
    if (!health.data || copying) return
    setCopying(true)
    try {
      await navigator.clipboard.writeText(JSON.stringify({ version: health.data.version, checks: health.data.checks }, null, 2))
      toast('Diagnostics copied')
    } catch {
      toast('Could not copy diagnostics. Please try again.', { tone: 'danger' })
    } finally {
      setCopying(false)
    }
  }

  return (
    <div data-route="workspace-tools" className="w-full space-y-6 px-9 py-9 max-md:px-[18px] max-md:py-6">
      <h1 className="text-[28px] font-medium tracking-tight max-md:text-[24px]">Workspace tools</h1>
      {health.data?.capabilities.singleProject !== true ? <section className="space-y-4 rounded-xl border border-border bg-card p-6 max-md:p-4" aria-labelledby="add-project-heading">
        <h2 id="add-project-heading" className="text-lg font-medium">Add project</h2>
        <p className="text-[13px] text-muted-foreground">Open an existing local folder or clone a GitHub repository.</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3 text-[13px] text-muted-foreground max-sm:grid-cols-1 max-sm:gap-y-1">
          {health.data?.repoRoot ? <><dt>Local folder</dt><dd className="break-all">{health.data.repo?.root ?? health.data.repoRoot}</dd></> : null}
          {repository ? <><dt>Repository</dt><dd className="break-all">{repository.replace(/^https:\/\//, '')}</dd></> : null}
          {projects.data?.projectsDir ? <><dt>Checkout folder</dt><dd className="break-all">{projects.data.projectsDir}</dd></> : null}
        </dl>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" className="min-h-11" onClick={() => setProjectAction('local')}>Open local folder</Button>
          <Button variant="outline" className="min-h-11" onClick={() => setProjectAction('clone')}>Clone from GitHub</Button>
        </div>
      </section> : null}

      <section className="space-y-4 rounded-xl border border-border bg-card p-6 max-md:p-4" aria-labelledby="tools-heading">
        <h2 id="tools-heading" className="text-lg font-medium">Tools diagnostics</h2>
        <p className="text-[13px] text-muted-foreground">Check the tools available to this local workspace.</p>
        {health.isError ? <p role="alert" className="text-sm text-destructive">Could not refresh tool diagnostics. Recheck to retry.</p> : null}
        {!health.data && !health.isError ? <p role="status" className="text-sm text-muted-foreground">Checking installed tools…</p> : null}
        {health.data ? <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-[13px]">
          {health.data.checks.map((check) => <div key={check.name} className="contents">
            <dt className="font-medium">{check.name}</dt>
            <dd className="min-w-0 break-words text-muted-foreground">{check.available ? 'Installed' : 'Not installed'}{check.version ? ` · ${check.version}` : ''}</dd>
          </div>)}
        </dl> : null}
        {health.data?.checks.length === 0 ? <p className="text-sm text-muted-foreground">No tool diagnostics reported by this server.</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" className="min-h-11" disabled={health.isFetching} onClick={() => void health.refetch()}>{health.isFetching ? 'Checking tools…' : 'Recheck tools'}</Button>
          <Button variant="outline" className="min-h-11" disabled={!health.data || copying} onClick={() => void copyDiagnostics()}>{copying ? 'Copying…' : 'Copy diagnostics'}</Button>
        </div>
      </section>
      {projectAction === 'local' ? <AddProjectDialog open onOpenChange={(open) => { if (!open) setProjectAction(null) }} /> : null}
      {projectAction === 'clone' ? <CloneProjectDialog open onOpenChange={(open) => { if (!open) setProjectAction(null) }} /> : null}
    </div>
  )
}
