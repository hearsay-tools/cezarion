// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { progressPreview } from '@/lib/task-preview'

const journal = (log: string) => `# Handoff\n\n## Goal\n\nShip it\n\n## Progress log\n\n${log}\n## Resume notes\n\nnext: review\n`

describe('progressPreview', () => {
  it('reads the newest lines of the Progress log, without the bullet', () => {
    expect(progressPreview(journal('- 10:03 — tests pass\n- 10:02 — fix written\n- 10:01 — cause found\n- 10:00 — started\n')))
      .toEqual(['10:03 — tests pass', '10:02 — fix written', '10:01 — cause found'])
  })

  it('prefers the agent’s own lines over cezar’s heartbeats', () => {
    const log = '- 2026-10-24T10:05:00Z — turn complete — 3 tools\n- 10:04 — opened the PR\n'
    expect(progressPreview(journal(log))).toEqual(['10:04 — opened the PR'])
    expect(progressPreview(journal('- 2026-10-24T10:05:00Z — turn complete — 3 tools\n')))
      .toEqual(['2026-10-24T10:05:00Z — turn complete — 3 tools'])
  })

  it('answers nothing for a journal without progress', () => {
    expect(progressPreview('')).toEqual([])
    expect(progressPreview(journal(''))).toEqual([])
    expect(progressPreview('# Handoff\n\n## Goal\n')).toEqual([])
  })
})
