import { describe, expect, it } from 'vitest'

import { canPreviewMarkdown, isMarkdownPath, resolveRepoImage } from './markdown'
import { newSideFromPatch } from './markdown-preview'
import type { DiffFileChange } from './types'

const file = (over: Partial<DiffFileChange>): DiffFileChange => ({
  path: 'docs/guide.md',
  status: 'modified',
  adds: 1,
  dels: 0,
  patch: '',
  ...over,
})

describe('isMarkdownPath', () => {
  it('accepts the Markdown extensions in any case', () => {
    for (const path of ['README.md', 'docs/a.markdown', 'site/page.MDX', 'x/y/Notes.Md']) {
      expect(isMarkdownPath(path)).toBe(true)
    }
  })

  it('refuses other extensions, dotfiles and directory dots', () => {
    for (const path of ['src/a.ts', '.md', 'docs.md/readme', 'README', 'notes.md.bak']) {
      expect(isMarkdownPath(path)).toBe(false)
    }
  })
})

describe('canPreviewMarkdown', () => {
  it('previews a nondeleted, nonbinary Markdown file', () => {
    expect(canPreviewMarkdown(file({}))).toBe(true)
    expect(canPreviewMarkdown(file({ status: 'added' }))).toBe(true)
    expect(canPreviewMarkdown(file({ status: 'renamed', oldPath: 'old.md' }))).toBe(true)
  })

  it('never previews a deleted, binary or non-Markdown file', () => {
    expect(canPreviewMarkdown(file({ status: 'deleted' }))).toBe(false)
    expect(canPreviewMarkdown(file({ binary: true }))).toBe(false)
    expect(canPreviewMarkdown(file({ path: 'src/a.ts' }))).toBe(false)
  })
})

describe('newSideFromPatch', () => {
  const patch = (lines: string[]) => ['diff --git a/x.md b/x.md', ...lines, ''].join('\n')

  it('is the whole document for an untruncated add', () => {
    const result = newSideFromPatch(file({ status: 'added', patch: patch(['@@ -0,0 +1,2 @@', '+# Title', '+Body']) }))
    expect(result).toEqual({ text: '# Title\nBody', complete: true })
  })

  it('keeps context and additions, drops deletions, and separates hunks with a rule', () => {
    const result = newSideFromPatch(
      file({ patch: patch(['@@ -1,2 +1,2 @@', ' # Title', '-old', '+new', '@@ -9,1 +9,1 @@', '-tail', '+end']) }),
    )
    expect(result.complete).toBe(false)
    expect(result.text).toBe('# Title\nnew\n\n---\n\nend')
  })

  it('is incomplete for a truncated add', () => {
    const result = newSideFromPatch(
      file({ status: 'added', patch: patch(['@@ -0,0 +1,2 @@', '+# Title', '… (patch truncated)']) }),
    )
    expect(result.complete).toBe(false)
  })
})

describe('resolveRepoImage', () => {
  it('resolves against the file directory, with a leading slash meaning the repo root', () => {
    expect(resolveRepoImage('docs/guide.md', 'img/a.png')).toBe('docs/img/a.png')
    expect(resolveRepoImage('docs/guide.md', './img/a.png')).toBe('docs/img/a.png')
    expect(resolveRepoImage('docs/guide.md', '../logo.svg')).toBe('logo.svg')
    expect(resolveRepoImage('docs/guide.md', '/assets/b.png')).toBe('assets/b.png')
    expect(resolveRepoImage('README.md', 'shot.png')).toBe('shot.png')
  })

  it('decodes percent-encoding and drops the query and fragment', () => {
    expect(resolveRepoImage('docs/guide.md', 'my%20shot.png?raw=1#x')).toBe('docs/my shot.png')
  })

  it('refuses a path that climbs above the repository root, encoded or not', () => {
    expect(resolveRepoImage('docs/guide.md', '../../etc/passwd')).toBeNull()
    expect(resolveRepoImage('README.md', '../x.png')).toBeNull()
    expect(resolveRepoImage('docs/guide.md', '%2e%2e/%2e%2e/x.png')).toBeNull()
    expect(resolveRepoImage('docs/guide.md', '..%2f..%2fx.png')).toBeNull()
  })

  it('refuses absolute, protocol-relative, data and malformed URLs', () => {
    for (const url of [
      'https://example.com/a.png',
      '//example.com/a.png',
      'data:image/png;base64,AAAA',
      'javascript:void(0)',
      'file:///etc/passwd',
      'C:\\x.png',
      'a\\..\\..\\x.png',
      '%E0%A4%A',
      'a%00.png',
      '',
      '#top',
      '/',
    ]) {
      expect(resolveRepoImage('docs/guide.md', url)).toBeNull()
    }
  })
})
