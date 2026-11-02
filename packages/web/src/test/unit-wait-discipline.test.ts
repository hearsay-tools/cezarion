// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
const FLOOR_MS = 3_000

describe('the floor', () => {
  it('is the asyncUtilTimeout the cockpit setup configures: a Testing Library wait below it is shorter than the host default', () => {
    const setup = readFileSync(resolve(import.meta.dirname, '../../vitest.setup.ts'), 'utf8')
    const configured = /asyncUtilTimeout:\s*([\d_]+)/.exec(setup)?.[1]
    expect(Number(configured?.replaceAll('_', ''))).toBe(FLOOR_MS)
  })
})

