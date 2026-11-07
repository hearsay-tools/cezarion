/**
 * `parseUnifiedDiff` — the review gate's reading of `GET /api/runs/:id/diff` (`git diff`
 * unified text) into per-file sections: path (with rename lineage), add/del counts, binary
 * flag, and the hunk lines to render. Pure text parsing, exactly like the legacy renderer
 * (web/app.js `renderDiff`: "`diff --git` starts a collapsible") — never a git library.
 *
 * Anything that is not a git diff (the server's "(no worktree — …)" sentence, a "(diff
 * failed …)" line, arbitrary garbage) parses to zero files; the caller renders the raw text
 * for those, because the server writes them for the person reading them.
 */

export interface DiffFile {
  /** The file's current path (`b/` side; the `a/` side for deletions). */
  path: string
  /** The pre-rename path — set only when the diff declares `rename from/to`. */
  oldPath?: string | undefined
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  /** `Binary files … differ` / `GIT binary patch` — there are no lines to render. */
  binary: boolean
  /** Count of `+` hunk lines (never `+++` headers). */
  additions: number
  /** Count of `-` hunk lines (never `---` headers). */
  deletions: number
  /** The renderable body: every line from the first `@@` to the end of this file's section. */
  lines: string[]
}

const FILE_HEADER = /^diff --git /

/** `diff --git a/old b/new` → the `b/` path. Paths with spaces make the split ambiguous —
 *  this is the last resort; `+++ b/…` and `rename to` are read first where present. */
function pathFromHeader(header: string): string {
  const rest = header.replace(FILE_HEADER, '')
  const bIndex = rest.lastIndexOf(' b/')
  if (bIndex >= 0) return unquote(rest.slice(bIndex + 3))
  return unquote(rest)
}

/** Git quotes paths with special characters (`"a/with \"quote\".txt"`). */
function unquote(path: string): string {
  const trimmed = path.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return trimmed
}

/** `+++ b/path` / `--- a/path` → path, or undefined for `/dev/null`. */
function pathFromMarker(line: string): string | undefined {
  const raw = unquote(line.slice(4))
  if (raw === '/dev/null') return undefined
  return raw.replace(/^[ab]\//, '')
}

function newDiffFile(header: string): DiffFile {
  return {
    path: pathFromHeader(header),
    status: 'modified',
    binary: false,
    additions: 0,
    deletions: 0,
    lines: [],
  }
}

/** One extended-header line (rename/mode/binary metadata plus the ---/+++ markers).
 *  Unrecognized lines (e.g. `index abc..def`) leave the file untouched. */
function applyExtendedHeaderLine(file: DiffFile, line: string): void {
  if (line.startsWith('rename from ')) {
    file.status = 'renamed'
    file.oldPath = unquote(line.slice('rename from '.length))
  } else if (line.startsWith('rename to ')) {
    file.status = 'renamed'
    file.path = unquote(line.slice('rename to '.length))
  } else if (line.startsWith('new file mode')) {
    file.status = 'added'
  } else if (line.startsWith('deleted file mode')) {
    file.status = 'deleted'
  } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
    file.binary = true
  } else if (line.startsWith('+++ ')) {
    const path = pathFromMarker(line)
    if (path !== undefined) file.path = path
  } else if (line.startsWith('--- ')) {
    const path = pathFromMarker(line)
    // A deletion has `+++ /dev/null`; the honest display path is the old one.
    if (path !== undefined && file.status === 'deleted') file.path = path
  }
}

/** One hunk-body line: always rendered; `+`/`-` prefixes count toward the totals.
 *  `\ No newline at end of file` renders but counts as neither side. */
function applyHunkLine(file: DiffFile, line: string): void {
  file.lines.push(line)
  if (line.startsWith('+')) file.additions += 1
  else if (line.startsWith('-')) file.deletions += 1
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let inHunks = false

  for (const line of text.split('\n')) {
    if (FILE_HEADER.test(line)) {
      current = newDiffFile(line)
      files.push(current)
      inHunks = false
      continue
    }
    if (!current) continue // preamble before any file header — not a diff, ignore

    if (!inHunks) {
      if (line.startsWith('@@')) {
        inHunks = true
        current.lines.push(line)
      } else {
        applyExtendedHeaderLine(current, line)
      }
      continue
    }

    applyHunkLine(current, line)
  }

  // git ends the diff with a newline; the split leaves a trailing '' on the last file.
  const last = files.at(-1)
  if (last && last.lines.at(-1) === '') last.lines.pop()
  return files
}

/** Aggregate ± across files — the review banner's summary numbers. */
export function diffTotals(files: DiffFile[]): { files: number; additions: number; deletions: number } {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}
