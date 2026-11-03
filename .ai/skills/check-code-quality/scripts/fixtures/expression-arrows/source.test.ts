import { expect, test } from 'vitest'
import { single, multi } from './source'
test('expression arrows', () => {
  expect(single()).toEqual({ id: 'r1' })
  expect(single({ id: 'r2' })).toEqual({ id: 'r2' })
  expect(multi()).toEqual({ id: 'r1' })
})
