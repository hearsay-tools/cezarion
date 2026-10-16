import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedTranscript } from '../e2e/seed-transcript'

const roots: string[] = []
function target() {
  const root = mkdtempSync(join(tmpdir(), 'cezar-seed-test-'))
  roots.push(root)
  return join(root, 'run.ndjson')
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const valid = '{"seq":1,"ts":"2026-10-16T00:00:00Z","type":"future-event","extra":{"kept":true}}'
describe('seedTranscript', () => {
  it('preserves valid open-contract events and blank lines', () => {
    const path = target()
    seedTranscript(path, `${valid}\n\n`)
    expect(readFileSync(path, 'utf8')).toBe(`${valid}\n\n`)
  })

  it.each(['ts', 'seq'])('rejects a missing %s before replacing an existing transcript', (field) => {
    const path = target()
    writeFileSync(path, 'original')
    const malformed: Record<string, unknown> = { seq: 2, ts: 'now', type: 'item.completed' }
    delete malformed[field]
    expect(() => seedTranscript(path, `${valid}\n\n${JSON.stringify(malformed)}\n`))
      .toThrow(new RegExp(`line 3.*item.completed[\\s\\S]*${field}`))
    expect(readFileSync(path, 'utf8')).toBe('original')
  })

  it('reports malformed JSON at its physical line before creating a file', () => {
    const path = target()
    expect(() => seedTranscript(path, `${valid}\n{broken}\n`)).toThrow(/line 2[\s\S]*JSON/)
    expect(existsSync(path)).toBe(false)
  })
})
