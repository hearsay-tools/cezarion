import { FolderTreeIcon } from 'lucide-react'
import { SearchIcon, TriangleAlertIcon } from '@/components/design-icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'

import { ApiError } from '@/api/client'
import { useRun, useRunFile, useArtifacts } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { RunHeader } from '../task-thread/run-header'
import { TaskFileScope } from '../task-thread/task-file-scope'
import { LinkedFilePreview } from './linked-file-preview'
import { FilesTree } from './files-tree'
import { GitTabLoadError, GitTabLoading } from './git-tab-loading'

/** URL selection is the source of truth: bookmarks, reload and Back select the same file. */
export function TaskFilesRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)
  if (run.isPending) return <GitTabLoading tab="files" />
  if (run.isError) return <GitTabLoadError tab="files" error={run.error} />
  return <TaskFileScope runId={run.data.id}><FilesView key={run.data.id} run={run.data} /></TaskFileScope>
}

function FilesView({ run }: { run: ApiRun }) {
  const root = useRunFile(run.id, '')
  const artifacts = useArtifacts(run.id)
  const [query, setQuery] = useSearchParams()
  const selected = query.get('path')
  const artifactId = query.get('artifact')
  const conflict = query.getAll('path').length > 1 || query.getAll('artifact').length > 1 || (selected !== null && artifactId !== null)
  const [filePath, setFilePath] = useState(selected ?? '')
  useEffect(() => setFilePath(selected ?? ''), [selected])
  const select = (key: 'path' | 'artifact', value: string) => {
    const next = new URLSearchParams(query)
    next.delete('path'); next.delete('artifact'); next.set(key, value)
    setQuery(next)
  }
  const refused = root.isError && root.error instanceof ApiError && root.error.status === 409
  return <div data-route="task-files" className="flex min-h-full flex-col">
    <RunHeader run={run} tab="files" />
    <form className="flex min-w-0 gap-2 px-[18px] pt-[22px] md:px-9" onSubmit={event => { event.preventDefault(); if (filePath.trim()) select('path', filePath.trim()) }}>
      <label className="relative min-w-0 flex-1">
        <SearchIcon size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
        <Input aria-label="File path in the worktree" placeholder="Open a file by path…" value={filePath} onChange={event => setFilePath(event.target.value)} className="h-11 min-w-0 bg-card pl-10" />
      </label>
      <Button type="submit" variant="outline" className="h-11 shrink-0" disabled={!filePath.trim()}>Open file</Button>
    </form>
    <div className="flex min-h-0 flex-col items-stretch gap-5 px-[18px] py-[22px] [--diff-sticky-top:1rem] md:flex-row md:items-start md:px-9">
      <aside data-slot="files-tree-pane" className="w-full shrink-0 rounded-xl border border-border bg-card p-3.5 md:sticky md:top-[var(--diff-sticky-top)] md:max-h-[calc(100dvh_-_64px_-_var(--diff-sticky-top)_-_1rem)] md:w-60 md:overflow-y-auto md:overscroll-contain lg:w-72">
        <h2 className="sr-only">Worktree files</h2>
        {root.isPending ? <p data-slot="files-loading" className="py-4 text-xs">Loading files…</p> : root.isError ? <CenteredState icon={refused ? <FolderTreeIcon /> : <TriangleAlertIcon size={16} />} tone={refused ? 'neutral' : 'danger'} heading="h2" title={refused ? 'No files to browse' : 'Could not load the files'} subtitle={root.error.message} /> : <FilesTree runId={run.id} selected={selected} onSelect={path => select('path', path)} />}
        <section className="mt-4 border-t border-border pt-3" aria-label="Published artifacts">
          <h2 className="text-sm font-medium">Published artifacts</h2>
          {artifacts.isPending ? <p className="py-2 text-xs">Loading published files…</p> : artifacts.isError ? <p role="alert" className="py-2 text-xs">Could not load published files.</p> : artifacts.data.artifacts.length === 0 ? <p className="py-2 text-xs text-muted-foreground">No published files yet.</p> : <ul>{artifacts.data.artifacts.map(artifact => <li key={artifact.id}><button type="button" aria-current={artifact.id === artifactId ? 'true' : undefined} className="min-h-11 w-full rounded px-2 py-2 text-left text-xs wrap-anywhere hover:bg-muted focus-visible:ring-2" onClick={() => select('artifact', artifact.id)}>{artifact.name}</button></li>)}</ul>}
          <Button variant="ghost" className="min-h-11" onClick={() => void artifacts.refetch()}>Refresh published files</Button>
        </section>
      </aside>
      {conflict ? <p role="alert" className="p-4">Invalid file link: choose either a path or a published artifact.</p> : selected !== null || artifactId !== null || root.isSuccess ? <LinkedFilePreview runId={run.id} path={selected} artifactId={artifactId} /> : null}
    </div>
    <p className="px-[18px] pb-6 text-xs text-muted-foreground md:px-9">Browsing files is read-only. Worktree contents may differ from your main checkout. Published files are snapshots.</p>
  </div>
}
