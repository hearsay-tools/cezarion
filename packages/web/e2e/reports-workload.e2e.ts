import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { benchmarkReports } from '../scripts/benchmark-reports'

// The syscall/CPU harness uses /proc. The report shelf itself remains portable.
it.skipIf(process.platform !== 'linux')('keeps the reports workload reproducible and checks every published id and source title', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reports-workload-'))
  const output = join(directory, 'smoke.json')
  try {
    await benchmarkReports(resolve(import.meta.dirname, '../../..'), output, true, '.ai/qa/build/cezar')
    const sample = JSON.parse(readFileSync(output, 'utf8')).cases[0]
    expect(sample.correctness).toMatchObject({ correct: true, total: 121 })
    expect(sample.correctness.ids).toEqual(sample.correctness.expectedIds)
    expect(sample.io.pageChecks).toBeGreaterThan(0)
    expect(sample.publicationLatencyMs).toBeLessThan(15_000)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
