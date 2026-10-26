// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { progressPreview } from '@/lib/task-preview'

const journal = (log: string) => `# Handoff\n\n## Goal\n\nShip it\n\n## Progress log\n\n${log}\n## Resume notes\n\nnext: review\n`

describe('progressPreview', () => {
  it('reads the newest lines of the Progress log, without the bullet', () => {
    expect(progressPreview(journal('- 10:03 — tests pass\n- 10:02 — fix written\n- 10:01 — cause found\n- 10:00 — started\n')))
      .toEqual(['10:03 — tests pass', '10:02 — fix written', '10:01 — cause found'])
  })

  // Older runs kept cezar's lifecycle lines in the Progress log; since hearsay-tools/cezarion#1809
  // the preview shows only the agent's own lines, and nothing when the agent wrote none.
  it.each([
    '- 2026-10-24T10:05:00Z — turn complete — status=waiting',
    '- 2026-10-24T10:05:00Z — turn complete — goal achieved, session closed',
    '- 2026-10-24T10:05:00Z — step "implement" complete — status=done',
    '- 2026-10-24T10:05:00Z — step "implement" ended without done — status=waiting; Continue to resume',
    '- 2026-10-24T10:05:00Z — session idle-closed — status=waiting; Continue to resume',
    '- 2026-10-24T10:05:00Z — worktree setup done in 41s',
    '- 2026-10-24T10:05:00Z — worktree setup failed — `npm ci` exited 1 after 12s; starting the agent anyway',
  ])('never shows the legacy lifecycle line %s', (legacy) => {
    expect(progressPreview(journal(`${legacy}\n- 10:04 — opened the PR\n`))).toEqual(['10:04 — opened the PR'])
    expect(progressPreview(journal(`${legacy}\n`))).toEqual([])
  })

  it('keeps an agent line that only mentions a lifecycle word', () => {
    expect(progressPreview(journal('- 10:04 — turn complete for the parser rewrite\n- 10:03 — worktree setup notes added\n')))
      .toEqual(['10:04 — turn complete for the parser rewrite', '10:03 — worktree setup notes added'])
  })

  it('reads the Progress log header only as a whole line (hearsay-tools/cezarion#1147)', () => {
    const quoted = '# Handoff\n\n## Goal\n\nFix the "## Progress log" lookup\n\n## Progress log\n\n- 10:00 — started\n'
    expect(progressPreview(quoted)).toEqual(['10:00 — started'])
  })

  it('answers nothing for a journal without progress', () => {
    expect(progressPreview('')).toEqual([])
    expect(progressPreview(journal(''))).toEqual([])
    expect(progressPreview('# Handoff\n\n## Goal\n')).toEqual([])
  })
})
