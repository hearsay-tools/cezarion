import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PickerPill } from './picker-pill'

afterEach(cleanup)

describe('PickerPill fieldLabel (#522)', () => {
  let available = 200
  let fullWidth = 150
  let resize: () => void

  beforeEach(() => {
    available = 200
    fullWidth = 150
    // jsdom has no layout. Supply only the browser measurements; the component decides
    // which text to render, including when the same pill shrinks and grows again.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => available)
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => fullWidth)
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() {}
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  function pill(label = 'Fable', props = {}) {
    return <PickerPill fieldLabel slot="model-pill" ariaLabel="Model" label={label}
      value={label} onPick={() => {}} options={[{ value: label, label }]} {...props} />
  }
  const visibleLabel = () => document.querySelector('[data-slot="picker-label"]')?.textContent

  it('keeps the entire prefix when the full label fits, including an exact fit', () => {
    available = fullWidth
    render(pill())
    expect(visibleLabel()).toBe('Model · Fable')
  })

  it('drops the whole prefix before the value and restores it after growing', () => {
    render(pill())
    available = fullWidth - 1
    act(() => resize())
    expect(visibleLabel()).toBe('Fable')
    available = 200
    act(() => resize())
    expect(visibleLabel()).toBe('Model · Fable')
  })

  it('keeps the full title and accessible name when a long value overflows', () => {
    available = 60
    fullWidth = 350
    render(pill('opencode/muse-spark-1.3-contributor-free'))
    const button = screen.getByRole('button', { name: 'Model · opencode/muse-spark-1.3-contributor-free' })
    expect(button.title).toBe('Model · opencode/muse-spark-1.3-contributor-free')
    expect(visibleLabel()).toBe('opencode/muse-spark-1.3-contributor-free')
  })

  it('rechecks the fit when the selected label changes', () => {
    const view = render(pill())
    fullWidth = 350
    view.rerender(pill('opencode/muse-spark-1.3-contributor-free'))
    expect(visibleLabel()).toBe('opencode/muse-spark-1.3-contributor-free')
  })

  it('exposes the full read-only value as text outside the aria-hidden visual label', () => {
    available = 60
    render(pill('Fable', { readOnly: true }))
    expect(screen.getAllByText('Model · Fable').some(node => !node.closest('[aria-hidden="true"]'))).toBe(true)
  })

  it.each([{ disabled: true }, { readOnly: true }])('retains the full label and explanation for %o', props => {
    render(pill('Fable', { ...props, disabledHint: 'Managed by agent settings' }))
    const control = document.querySelector('[data-slot="model-pill"]')!
    expect(control.getAttribute('aria-label')).toBe('Model · Fable')
    expect(control.getAttribute('title')).toContain('Model · Fable')
    expect(control.getAttribute('title')).toContain('Managed by agent settings')
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
