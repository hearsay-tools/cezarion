// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { seedRuns } from '../../e2e/seed-runs'

it('rejects duplicate fixture ids before the importer can discard a record', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-seed-duplicates-'))
  try {
    expect(() => seedRuns(root, [{ id: 'same', title: 'First' }, { id: 'same', title: 'Second' }]))
      .toThrow('Duplicate seed run id: same')
    expect(existsSync(join(root, '.ai/cezar/runs.json'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
