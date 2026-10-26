// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type BaselineEntry, waitBaseline } from './wait-baseline'

/**
 * The ratchet `e2e-wait-discipline.ts` and `unit-wait-discipline.ts` share. Their own tests pin the
 * rules; this one pins the file handling that differs between them: the e2e baseline never starts
 * from today's sites, the unit one does.
 */
type Entry = BaselineEntry<'sleep'>
const entry = (site: string, count = 1): Entry => ({ file: 'a.test.ts', rule: 'sleep', site, count })

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wait-baseline-'))
  path = join(dir, 'baseline.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const baseline = (seedWhenMissing: boolean) => waitBaseline<'sleep'>({ path, comment: 'a note', seedWhenMissing })

describe('waitBaseline', () => {
  it('reads a missing file as an empty baseline', () => {
    expect(baseline(false).read()).toEqual([])
    expect(baseline(true).read()).toEqual([])
  })

  it('seeds a missing file from the sites found when asked to, and writes nothing otherwise', () => {
    const seeded = baseline(true)
    seeded.shrink([entry('a', 2), entry('b')])
    expect(seeded.read()).toEqual([entry('a', 2), entry('b')])

    const unseeded = baseline(false)
    rmSync(path)
    unseeded.shrink([entry('a', 2), entry('b')])
    expect(unseeded.read()).toEqual([])
  })

  it('only lowers an existing baseline: a site it does not hold stays out and a higher count is cut back', () => {
    const store = baseline(false)
    store.write([entry('a', 3), entry('b'), entry('gone')])
    store.shrink([entry('a', 1), entry('b', 4), entry('new', 5)])
    expect(store.read()).toEqual([entry('a', 1), entry('b')])
  })

  it('writes the comment and the sites, and reads the file at the path it is given', () => {
    const store = baseline(false)
    const other = join(dir, 'other.json')
    store.write([entry('a')], other)
    expect(JSON.parse(readFileSync(other, 'utf8'))).toEqual({ $comment: 'a note', sites: [entry('a')] })
    expect(store.read(other)).toEqual([entry('a')])
    expect(store.read()).toEqual([])
    writeFileSync(path, JSON.stringify({ $comment: 'x', sites: [entry('b')] }))
    expect(store.read()).toEqual([entry('b')])
  })
})
