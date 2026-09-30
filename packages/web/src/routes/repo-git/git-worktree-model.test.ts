import { describe, expect, it } from 'vitest'

import type { RunRecord, WorktreeInfo } from '@open-mercato/cezar-api-client'

import { worktreeRows } from './git-worktree-model'

const wt = (over: Partial<WorktreeInfo> & { runId: string }): WorktreeInfo => ({
  title: `Title ${over.runId}`, status: 'done', branch: `cez/${over.runId}`, sizeBytes: null, finishedAt: null, reclaimable: false, ...over,
})
const run = (over: Record<string, unknown> & { id: string }) =>
  ({ title: 'run title', workflow: 'quick-task', task: 't', status: 'running', createdAt: '2026-07-20T00:00:00Z', tokensUsed: 0, archived: false, steps: [], ...over }) as unknown as RunRecord

describe('worktreeRows', () => {
  it('lists exactly the worktrees the API says are on disk, never the runs', () => {
    const rows = worktreeRows(
      [wt({ runId: 'a' }), wt({ runId: 'c' })],
      [run({ id: 'a', worktreePath: '/wt/a' }), run({ id: 'b', worktreePath: '/wt/b' }), run({ id: 'c' })],
    )
    expect(rows.map((row) => row.runId)).toEqual(['a', 'c'])
  })

  it('joins the run for title, attention and diff', () => {
    const [row] = worktreeRows(
      [wt({ runId: 'a', status: 'running' })],
      [run({ id: 'a', title: 'Fix the login', status: 'waiting', diffStat: { files: 2, adds: 7, dels: 3 } })],
    )
    expect(row).toMatchObject({ runId: 'a', branch: 'cez/a', title: 'Fix the login', to: '/tasks/a/changes', diff: { files: 2, adds: 7, dels: 3 } })
    expect(row?.attention.bucket).toBe('waiting')
  })

  it('a worktree whose run is not (yet) in the list keeps its own title and status, with the diff unknown', () => {
    const [row] = worktreeRows([wt({ runId: 'a', status: 'failed', title: 'From worktrees' })], [])
    expect(row).toMatchObject({ title: 'From worktrees', diff: null })
    expect(row?.attention.bucket).toBe('error')
  })

  it('runs not loaded (undefined) is unknown, not zero', () => {
    const [row] = worktreeRows([wt({ runId: 'a' })], undefined)
    expect(row?.diff).toBeNull()
  })

  it('a run with no measured diffStat is unknown rather than +0 −0', () => {
    const [row] = worktreeRows([wt({ runId: 'a' })], [run({ id: 'a' })])
    expect(row?.diff).toBeNull()
  })

  it('a measured zero stays a zero', () => {
    const [row] = worktreeRows([wt({ runId: 'a' })], [run({ id: 'a', diffStat: { files: 0, adds: 0, dels: 0 } })])
    expect(row?.diff).toEqual({ files: 0, adds: 0, dels: 0 })
  })

  it('a missing branch stays null for the component to say so', () => {
    const [row] = worktreeRows([wt({ runId: 'a', branch: null })], [])
    expect(row?.branch).toBeNull()
  })
})
