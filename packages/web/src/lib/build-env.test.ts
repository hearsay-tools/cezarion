import { afterEach, expect, it, vi } from 'vitest'
import { e2eBuildEnabled, preferredBuildEnv, resolveBuildApiBase } from './build-env'
import { isCockpitE2e } from './e2e-mode'

afterEach(() => vi.unstubAllEnvs())

it.each([
  [undefined, undefined, undefined, false],
  [undefined, '1', '1', true],
  ['1', '0', '1', true],
  ['true', '0', 'true', true],
  ['', '1', '', false],
  ['0', 'true', '0', false],
] as const)('build flags prefer %s over %s', (preferred, legacy, expected, e2e) => {
  expect(preferredBuildEnv(preferred, legacy)).toBe(expected)
  expect(e2eBuildEnabled(preferred, legacy)).toBe(e2e)
  vi.stubEnv('VITE_HSQ_E2E', preferred)
  vi.stubEnv('VITE_CEZ_E2E', legacy)
  expect(isCockpitE2e()).toBe(e2e)
})

it('API origin keeps deployment overrides and preferred empty same-origin values', () => {
  expect(resolveBuildApiBase(' https://meta.example ', 'https://new.example', 'https://old.example')).toBe('https://meta.example')
  expect(resolveBuildApiBase(null, 'https://new.example', 'https://old.example')).toBe('https://new.example')
  expect(resolveBuildApiBase(null, '', 'https://old.example')).toBe('')
  expect(resolveBuildApiBase('', undefined, 'https://old.example')).toBe('https://old.example')
})
