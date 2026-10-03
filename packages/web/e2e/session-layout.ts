import { expect } from 'vitest'

/** #795 review: preserve the old one-pixel editor viewport bound as an assertion. */
export function expectEditorFitsViewport(facts: { editor: { bottom: number }; viewportHeight: number }): void {
  expect(facts.editor.bottom, 'composer editor bottom edge').toBeLessThanOrEqual(facts.viewportHeight + 1)
}
