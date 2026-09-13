import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PickerPill } from './picker-pill'

afterEach(cleanup)

describe('PickerPill fieldLabel (#272)', () => {
  it('always shows the field name beside the value, at every width', () => {
    render(
      <PickerPill
        fieldLabel
        slot="model-pill"
        ariaLabel="Model"
        label="Default"
        value=""
        onPick={() => {}}
        options={[{ value: '', label: 'Default' }]}
      />,
    )
    const button = screen.getByRole('button', { name: 'Model' })
    expect(button.textContent).toBe('Model · Default')
    const field = [...button.querySelectorAll('span')].find((node) => node.textContent === 'Model · ')
    expect(field).toBeTruthy()
    expect(field!.className).not.toMatch(/\bhidden\b/)
  })
})

describe('PickerPill catalog status', () => {
  it('keeps radio options selectable and renders a disabled status row', async () => {
    render(
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        label="auto"
        value=""
        onPick={() => {}}
        options={[{ value: '', label: 'auto' }, { value: 'gpt-future', label: 'Future' }]}
        status="Using cached Codex model list"
      />,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model' }))
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(2)
    expect(screen.getByText('Using cached Codex model list').closest('[data-disabled]')).not.toBeNull()
  })
})
