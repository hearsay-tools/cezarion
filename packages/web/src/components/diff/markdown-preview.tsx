import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Markdown } from '@/routes/task-thread/markdown'

import { resolveRepoImage } from './markdown'
import { parsePatch } from './parse-patch'
import type { DiffFileChange } from './types'

/**
 * A Markdown file's new side rendered as a document, the `preview` branch of a diff card
 * (hearsay-tools/cezarion#1012, port of open-mercato/cezar#1349).
 *
 * The full text comes from `loadFileText` when the consumer wires one (the task Changes tab
 * reads the worktree). Otherwise, or when the loader answers `null`, the patch's new-side lines
 * stand in: for an added file that IS the whole document, for an edit it is only the changed
 * sections, and the note says so rather than passing excerpts off as the file.
 *
 * Freshness rides on the consumer's diff: the text reloads when this file's PATCH changes, which
 * happens only when the Changes view's own coordinated read saw a write. No timer of its own.
 */
export function MarkdownPreview({
  file,
  loadFileText,
  imageSrc,
}: {
  file: DiffFileChange
  loadFileText?: ((path: string) => Promise<string | null>) | undefined
  imageSrc?: ((path: string) => string) | undefined
}) {
  const fromPatch = useMemo(() => newSideFromPatch(file), [file])
  // Consumers pass inline arrows: refs keep them out of the deps, so a parent re-render neither
  // refetches the text nor rebuilds the image resolver (which `Markdown`'s memo compares).
  const loaderRef = useRef(loadFileText)
  loaderRef.current = loadFileText
  const imageSrcRef = useRef(imageSrc)
  imageSrcRef.current = imageSrc
  const canLoad = loadFileText !== undefined
  const [loaded, setLoaded] = useState<{ path: string; text: string | null } | null>(null)

  useEffect(() => {
    const load = loaderRef.current
    if (!load) return
    let cancelled = false
    load(file.path).then(
      (text) => !cancelled && setLoaded({ path: file.path, text }),
      () => !cancelled && setLoaded({ path: file.path, text: null }),
    )
    return () => {
      cancelled = true
    }
  }, [file.path, file.patch, canLoad])

  const resolveImage = useCallback(
    (src: string) => {
      const source = imageSrcRef.current
      const path = source ? resolveRepoImage(file.path, src) : null
      return path === null || !source ? null : source(path)
    },
    [file.path],
  )

  // Keyed on the PATH, not the patch: while an agent edits the file, the previous text stays
  // up until the new one lands. Swapping in "Loading…" on every write would jump the page.
  const current = loaded?.path === file.path ? loaded : null
  if (canLoad && current === null) {
    return (
      <p role="status" className="px-4 py-2.5 text-xs text-soft-foreground">
        Loading preview…
      </p>
    )
  }
  const full = current?.text ?? null
  if (full === null && fromPatch.text === '') {
    // A pure rename or mode change: no new-side text to render, and no full file to fall back on.
    return <p className="px-4 py-2.5 text-xs text-soft-foreground">No content changes to preview.</p>
  }
  const note =
    full !== null || fromPatch.complete
      ? null
      : canLoad
        ? 'The full file could not be loaded. Showing the changed sections only.'
        : 'Showing the changed sections only.'
  return (
    <div data-slot="diff-markdown-preview" className="px-4 py-5 md:px-6">
      <div className="mx-auto max-w-[72ch]">
        {note ? <p className="mb-4 text-xs text-soft-foreground">{note}</p> : null}
        <Markdown document imageSrc={resolveImage}>
          {full ?? fromPatch.text}
        </Markdown>
      </div>
    </div>
  )
}

/**
 * The new-side text the patch carries, hunks joined by a rule. `complete` only for an
 * untruncated add — there the patch IS the file; for anything else it is the changed sections.
 */
export function newSideFromPatch(file: DiffFileChange): { text: string; complete: boolean } {
  const parsed = parsePatch(file.patch)
  const sections = parsed.hunks.map((hunk) =>
    hunk.lines
      .filter((line) => line.kind !== 'del')
      .map((line) => line.text)
      .join('\n'),
  )
  return { text: sections.join('\n\n---\n\n'), complete: file.status === 'added' && !parsed.truncated }
}
