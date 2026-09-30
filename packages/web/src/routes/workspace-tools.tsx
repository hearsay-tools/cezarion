import { useState } from 'react'
import { useHealth, useProjects } from '@/api/queries'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { CloneProjectDialog } from '@/components/clone-project-dialog'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { TOOL_LINK_CLASS, TOOL_SETTINGS_PATH, toolStateLabel, toolTone } from '@/lib/tool-status'
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
    <div data-route="workspace-tools" className="w-full space-y-[22px] px-9 py-9 max-md:px-[18px] max-md:py-6">
      <h1 className="text-[28px] font-normal leading-[1.5] max-md:text-[24px]">Workspace tools</h1>
      {health.data?.capabilities.singleProject !== true ? <section className="space-y-4 rounded-xl border border-border bg-card p-6 max-md:p-4" aria-labelledby="add-project-heading">
        <h2 id="add-project-heading" className="text-lg font-normal leading-[1.5]">Add project</h2>
        <p className="text-[13px] leading-[1.5] text-muted-foreground">Open an existing local folder or clone a GitHub repository.</p>
        <dl className="space-y-4 text-[13px] leading-[1.5] text-muted-foreground">
          {health.data?.repoRoot ? <div className="flex flex-wrap gap-x-3"><dt>Local folder</dt><dd className="min-w-0 break-all">{health.data.repo?.root ?? health.data.repoRoot}</dd></div> : null}
          {repository ? <div className="flex flex-wrap gap-x-3"><dt>Repository</dt><dd className="min-w-0 break-all">{repository.replace(/^https:\/\//, '')}</dd></div> : null}
          {projects.data?.projectsDir ? <div className="flex flex-wrap gap-x-3"><dt>Checkout folder</dt><dd className="min-w-0 break-all">{projects.data.projectsDir}</dd></div> : null}
        </dl>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" className="h-10 rounded-lg px-[15px] text-xs font-normal leading-[18px]" onClick={() => setProjectAction('local')}>Open local folder</Button>
          <Button variant="outline" className="h-10 rounded-lg px-[15px] text-xs font-normal leading-[18px]" onClick={() => setProjectAction('clone')}>Clone from GitHub</Button>
        </div>
      </section> : null}

      <section className="space-y-4 rounded-xl border border-border bg-card p-6 max-md:p-4" aria-labelledby="tools-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="tools-heading" className="text-lg font-normal leading-[1.5]">Tools diagnostics</h2>
          <Link to={TOOL_SETTINGS_PATH} data-slot="tools-settings" className={TOOL_LINK_CLASS}>Tool settings ›</Link>
        </div>
        <p className="text-[13px] leading-[1.5] text-muted-foreground">Check the tools available to this local workspace.</p>
        {health.isError ? <p role="alert" className="text-sm text-destructive">Could not refresh tool diagnostics. Recheck to retry.</p> : null}
        {!health.data && !health.isError ? <p role="status" className="text-sm text-muted-foreground">Checking installed tools…</p> : null}
        {health.data ? <dl className="space-y-4 text-[13px] leading-[1.5] text-muted-foreground">
          {health.data.checks.map((check) => <div key={check.name} data-slot="tool-row" data-tool={check.name} data-available={check.available} className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <dt className="flex items-center gap-2">
              <StatusDot tone={toolTone(check)} />
              <span className="font-mono text-[13px] font-medium text-foreground">{check.name}</span>
            </dt>
            <dd className="min-w-0 flex-1 break-words text-muted-foreground">{toolStateLabel(check)}{check.version ? ` · ${check.version}` : ''}</dd>
            {check.available ? null : <Link to={TOOL_SETTINGS_PATH} data-slot="tool-setup" className={`${TOOL_LINK_CLASS} ml-auto`}>Set up ›</Link>}
            {!check.available && check.hint ? <dd data-slot="tool-hint" className="basis-full min-w-0 break-words text-xs leading-snug text-muted-foreground">{check.hint}</dd> : null}
          </div>)}
        </dl> : null}
        {health.data?.checks.length === 0 ? <p className="text-sm text-muted-foreground">No tool diagnostics reported by this server.</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" className="h-10 rounded-lg px-[15px] text-xs font-normal leading-[18px]" disabled={health.isFetching} onClick={() => void health.refetch()}>{health.isFetching ? 'Checking tools…' : 'Recheck tools'}</Button>
          <Button variant="outline" className="h-10 rounded-lg px-[15px] text-xs font-normal leading-[18px]" disabled={!health.data || copying} onClick={() => void copyDiagnostics()}>{copying ? 'Copying…' : 'Copy diagnostics'}</Button>
        </div>
      </section>
      {projectAction === 'local' ? <AddProjectDialog open onOpenChange={(open) => { if (!open) setProjectAction(null) }} /> : null}
      {projectAction === 'clone' ? <CloneProjectDialog open onOpenChange={(open) => { if (!open) setProjectAction(null) }} /> : null}
    </div>
  )
}
