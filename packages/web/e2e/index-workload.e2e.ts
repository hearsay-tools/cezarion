import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { runIndexWorkload } from '../scripts/benchmark-index'

// The CPU sampling uses /proc and taskset-free defaults. The index workload itself is portable.
it.skipIf(process.platform !== 'linux')('keeps the runs-index workload reproducible: patches without index reads, fences reconnect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'index-workload-'))
  const report: { cases: Array<{ view: string; phases: Record<string, Record<string, unknown>> }> } = { cases: [] }
  try {
    await runIndexWorkload({
      buildRoot: resolve(import.meta.dirname, '../../..'), serverPackage: '.ai/qa/build/cezar', report,
      save: () => writeFileSync(join(directory, 'smoke.json'), JSON.stringify(report)), views: ['all-tasks'], sustainedMs: 3_000,
      // A loaded e2e host can need more than the report's 3 s window to paint the row.
      updateWindowMs: 15_000,
    })
    const { phases } = report.cases[0]!
    expect(phases.cold).toMatchObject({ main: true })
    // Another project's title change reaches the global Tasks page with no full index read.
    expect(phases.update).toMatchObject({ indexRequests: 0 })
    expect(phases.update!.titleShownMs).toEqual(expect.any(Number))
    // Ticks patch rows; the e2e build polls nothing, so no index read runs while they flow.
    expect(phases.sustained).toMatchObject({ indexRequests: 0 })
    expect(phases.sustained!.ticks).toBeGreaterThan(0)
    // A dropped stream reconciles the index once, through the fence.
    expect(phases.reconnect).toMatchObject({ main: true, indexRequests: 1 })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 180_000)
