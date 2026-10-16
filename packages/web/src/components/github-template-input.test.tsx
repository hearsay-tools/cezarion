import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { GithubTemplateInput } from '@/components/github-template-input'
import { filterTemplateSuggestions } from '@/lib/github-templates'

afterEach(cleanup)

function Harness() {
  const [value, setValue] = useState('')
  return <GithubTemplateInput id="tmpl" value={value} onChange={setValue} />
}

/** The highlighted option's slug, read through `aria-activedescendant` as a screen reader would. */
function highlighted(input: HTMLElement): string | null {
  const id = input.getAttribute('aria-activedescendant')
  if (!id) return null
  return document.getElementById(id)?.querySelector('.font-mono')?.textContent ?? null
}

describe('GithubTemplateInput keyboard', () => {
  const all = filterTemplateSuggestions('')

  it('ArrowDown from no highlight starts at the first suggestion, and wraps past the last', () => {
    const { getByRole } = render(<Harness />)
    const input = getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlighted(input)).toBe(all[0]?.slug)
    for (let i = 1; i < all.length; i++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlighted(input)).toBe(all.at(-1)?.slug)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlighted(input)).toBe(all[0]?.slug)
  })

  it('ArrowUp from no highlight starts at the last suggestion', () => {
    const { getByRole } = render(<Harness />)
    const input = getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(highlighted(input)).toBe(all.at(-1)?.slug)
  })

  it('Enter picks the highlighted suggestion', () => {
    const { getByRole } = render(<Harness />)
    const input = getByRole('combobox') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe(all.at(-1)?.slug)
  })
})
