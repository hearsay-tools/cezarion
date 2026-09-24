import { useContext, useMemo } from 'react'
import { useArtifact, useFileLink } from '@/api/queries'
import { artifactUrl, fileLinkImageUrl } from '@/api/client'
import { Button } from '@/components/ui/button'
import { TaskFileContext } from '../task-thread/file-links'
import { FileEntryView, FilePreview } from './file-preview'

export function LinkedFilePreview({ runId, path, artifactId }: { runId: string; path: string | null; artifactId: string | null }) {
  const live = useFileLink(runId, artifactId ? null : path)
  const published = useArtifact(runId, artifactId)
  const query = artifactId ? published : live
  const parentContext = useContext(TaskFileContext)
  const data = query.data
  const context = useMemo(() => data?.type === 'file' && data.source !== 'artifact'
    ? { runId, ...parentContext, basePath: data.path } : null, [data, parentContext, runId])
  if (!path && !artifactId) return <FilePreview runId={runId} path={null} className="min-w-0 flex-1" />
  if (query.isPending) return <p role="status" className="p-4">Loading file…</p>
  if (query.isError) return <section data-slot="file-preview" className="min-w-0 flex-1 rounded-lg border p-4"><h2>Could not load this file</h2><p className="wrap-anywhere text-sm">{query.error.message}</p><Button variant="outline" onClick={() => void query.refetch()}>Retry</Button></section>
  if (!data) return <p role="alert" className="p-4">No file data was returned.</p>
  if (data.type !== 'file') return <section data-slot="file-preview" className="min-w-0 flex-1 rounded-lg border p-4"><h2>{data.type === 'unpublished' ? 'File not published' : 'Cannot preview this file'}</h2><p className="wrap-anywhere py-2 font-mono text-xs">{data.path}</p><p className="text-sm">{data.reason}</p><Button variant="outline" onClick={() => void query.refetch()}>Retry</Button></section>
  const artifact = data.artifact
  return <TaskFileContext.Provider value={context}><FileEntryView key={artifact?.id ?? data.path} runId={runId} entry={data} documentPreview
    className="min-w-0 flex-1" imageUrl={artifact ? artifactUrl(runId, artifact.id, 'image') : fileLinkImageUrl(runId, path!)}
    {...(artifact ? { downloadUrl: artifactUrl(runId, artifact.id, 'download'), snapshot: new Date(artifact.createdAt).toLocaleString() } : {})} />
  </TaskFileContext.Provider>
}
