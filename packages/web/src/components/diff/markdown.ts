import type { DiffFileChange } from './types'

/**
 * The pure half of the diff's Markdown preview (hearsay-tools/cezarion#1012, port of
 * open-mercato/cezar#1349): which files get one, and where a relative image may point.
 * Dependency-free on purpose: `canPreviewMarkdown` is re-exported from the facade's index, which
 * consumers load eagerly, while the parser and renderer stay in the lazy engine chunk.
 */

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

/** A path the diff can render as a document — decided by extension, like `image`. */
export function isMarkdownPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** True when the file has a new side worth rendering: Markdown, text, and not deleted. */
export function canPreviewMarkdown(file: DiffFileChange): boolean {
  return isMarkdownPath(file.path) && file.status !== 'deleted' && !file.binary
}

/**
 * The repository path a previewed file's image `src` names, or `null` when it names none safely.
 * Relative to the file's directory, a leading `/` meaning the repository root (the forge
 * convention). Refused: anything with a scheme or a host (`https:`, `data:`, `//cdn`), a
 * backslash or control character, malformed percent-encoding, and any `..` that climbs above
 * the root. Decoding happens BEFORE the segments are walked, so `%2e%2e%2f` is a `..` too.
 * The server's worktree reader enforces containment again; this keeps the cockpit from asking.
 */
export function resolveRepoImage(filePath: string, src: string): string | null {
  const bare = src.split(/[?#]/, 1)[0] ?? ''
  if (bare === '' || bare.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(bare)) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(bare)
  } catch {
    return null
  }
  if (decoded.includes('\\') || /[\u0000-\u001f]/.test(decoded)) return null
  const parts = decoded.startsWith('/') ? [] : filePath.split('/').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.pop() === undefined) return null
    } else {
      parts.push(segment)
    }
  }
  return parts.length > 0 ? parts.join('/') : null
}
