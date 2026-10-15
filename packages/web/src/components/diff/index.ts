/**
 * Public surface of the diff facade — consumers import `Diff` and its prop types from here
 * and nothing else (`diff.tsx` header has the engine decision). The parser and word-diff
 * modules are internal; they are exported nowhere on purpose. `canPreviewMarkdown` is the one
 * predicate a consumer needs to decide whether to offer the Markdown preview toggle.
 */
export { Diff } from './diff'
export { canPreviewMarkdown } from './markdown'
export type { DiffFileChange, DiffHandle, DiffMode, DiffProps } from './types'
