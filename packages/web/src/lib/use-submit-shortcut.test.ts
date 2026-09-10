// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'

import { isSubmitShortcut, submitShortcutHint, type SubmitShortcutEvent } from './use-submit-shortcut'

const COARSE_POINTER_QUERY = '(hover: none) and (pointer: coarse)'

afterEach(() => vi.unstubAllGlobals())

const stubCoarsePointer = (matches: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ media: query, matches: query === COARSE_POINTER_QUERY && matches }) as MediaQueryList),
  )

const event = (overrides: Partial<SubmitShortcutEvent> = {}): SubmitShortcutEvent => ({
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...overrides,
})

describe('isSubmitShortcut — the spec matrix (Enter / Shift+Enter / ⌘↵ / Ctrl+↵)', () => {
  const table: Array<{ name: string; input: SubmitShortcutEvent; coarsePointer?: boolean; sends: boolean }> = [
    { name: 'plain Enter sends when matchMedia is unavailable', input: event(), sends: true },
    { name: 'desktop plain Enter sends', input: event(), coarsePointer: false, sends: true },
    { name: 'coarse-pointer plain Enter inserts a newline', input: event(), coarsePointer: true, sends: false },
    { name: 'coarse-pointer ⌘↵ still sends', input: event({ metaKey: true }), coarsePointer: true, sends: true },
    { name: 'coarse-pointer Ctrl+↵ still sends', input: event({ ctrlKey: true }), coarsePointer: true, sends: true },
    { name: '⌘↵ sends (macOS)', input: event({ metaKey: true }), sends: true },
    { name: 'Ctrl+↵ sends (Windows/Linux)', input: event({ ctrlKey: true }), sends: true },
    { name: '⌘ and Ctrl together still send', input: event({ metaKey: true, ctrlKey: true }), sends: true },
    { name: 'Shift+Enter is the newline, never a send', input: event({ shiftKey: true }), sends: false },
    { name: 'Shift wins even over ⌘', input: event({ shiftKey: true, metaKey: true }), sends: false },
    { name: 'Alt+Enter is left alone', input: event({ altKey: true }), sends: false },
    { name: 'a held key must not machine-gun sends', input: event({ repeat: true }), sends: false },
    { name: 'Enter mid-IME-composition commits the IME, not the message', input: event({ isComposing: true }), sends: false },
    { name: 'any other key is not a send', input: event({ key: 'a' }), sends: false },
    { name: '⌘+non-Enter is not a send', input: event({ key: 'k', metaKey: true }), sends: false },
  ]

  for (const { name, input, coarsePointer, sends } of table) {
    it(name, () => {
      if (coarsePointer !== undefined) stubCoarsePointer(coarsePointer)
      expect(isSubmitShortcut(input)).toBe(sends)
    })
  }
})

describe('submitShortcutHint — the platform’s own symbols', () => {
  it.each([
    ['MacIntel', '⌘↵'],
    ['iPhone', '⌘↵'],
    ['iPad', '⌘↵'],
    ['Win32', 'Ctrl+↵'],
    ['Linux x86_64', 'Ctrl+↵'],
    ['', 'Ctrl+↵'],
  ])('%s → %s', (platform, hint) => {
    expect(submitShortcutHint(platform)).toBe(hint)
  })
})
