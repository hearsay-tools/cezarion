import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PickerPill, PickerPillGroup } from './picker-pill'

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: this.classList.contains('invisible') ? fullWidth : available } as DOMRect
    })
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

  it('keeps a fractional-width prefix within the half-pixel fit tolerance', () => {
    fullWidth = 98.5625
    available = 98.25
    render(pill('grok-4.6'))
    expect(visibleLabel()).toBe('Model · grok-4.6')
    available = 98
    act(() => resize())
    expect(visibleLabel()).toBe('grok-4.6')
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

describe('PickerPillGroup (#541)', () => {
  // jsdom has no layout: `full` is each pill's prefixed label width (keyed by slot), `available`
  // the row's width. The group compares the sum of the first with the second.
  const full: Record<string, number> = {}
  let available = 500
  const observers: Array<() => void> = []

  beforeEach(() => {
    for (const key of Object.keys(full)) delete full[key]
    Object.assign(full, { 'runner-pill': 150, 'model-pill': 150, 'effort-pill': 150 })
    available = 500
    observers.length = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const slot = this.closest('[data-slot$="pill"]')?.getAttribute('data-slot') ?? ''
      return { width: this.classList.contains('invisible') ? full[slot] : 0, top: 0 } as DOMRect
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => available)
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observers.push(callback) }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  const LONG = 'opencode/muse-spark-1.3-contributor-free'
  const pillFor = (slot: string, ariaLabel: string, label: string) => (
    <PickerPill fieldLabel slot={slot} ariaLabel={ariaLabel} label={label} value={label} onPick={() => {}} options={[{ value: label, label }]} />
  )
  const row = (model = 'Fable') => (
    <PickerPillGroup>
      {pillFor('runner-pill', 'Runner', 'opencode')}
      {pillFor('model-pill', 'Model', model)}
      {pillFor('effort-pill', 'Effort', 'medium')}
    </PickerPillGroup>
  )
  const labels = () => [...document.querySelectorAll('[data-slot="picker-label"]')].map((el) => el.textContent)
  const resize = () => act(() => observers.forEach((notify) => notify()))

  it('keeps every prefix while the row holds all of them, including an exact fit', () => {
    available = 450
    render(row())
    expect(labels()).toEqual(['Runner · opencode', 'Model · Fable', 'Effort · medium'])
  })

  it('drops every sibling prefix when one value would truncate, and restores them together', () => {
    full['model-pill'] = 350
    render(row(LONG))
    expect(labels()).toEqual(['opencode', LONG, 'medium'])
    available = 650
    resize()
    expect(labels()).toEqual(['Runner · opencode', `Model · ${LONG}`, 'Effort · medium'])
    available = 649
    resize()
    expect(labels()).toEqual(['opencode', LONG, 'medium'])
  })

  it('keeps full-value tooltips and accessible names after the prefixes drop', () => {
    full['model-pill'] = 350
    render(row(LONG))
    expect(document.querySelector('[data-slot="runner-pill"]')!.getAttribute('title')).toBe('Runner · opencode')
    expect(screen.getByRole('button', { name: `Model · ${LONG}` }).title).toBe(`Model · ${LONG}`)
  })

  it('rechecks the row when the selected value changes', () => {
    const view = render(row())
    expect(labels()).toEqual(['Runner · opencode', 'Model · Fable', 'Effort · medium'])
    full['model-pill'] = 350
    view.rerender(row(LONG))
    expect(labels()).toEqual(['opencode', LONG, 'medium'])
  })

  it('stops counting a pill once it unmounts', () => {
    full['model-pill'] = 350
    const view = render(row(LONG))
    expect(labels()).toEqual(['opencode', LONG, 'medium'])
    view.rerender(<PickerPillGroup>{pillFor('runner-pill', 'Runner', 'opencode')}</PickerPillGroup>)
    expect(labels()).toEqual(['Runner · opencode'])
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
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByText('Using cached Codex model list').closest('[data-disabled]')).not.toBeNull()
  })

  it('keeps typing focus when the pointer crosses options and lets keyboard users refine a query', async () => {
    render(<PickerPill slot="branch-pill" ariaLabel="Base branch" label="main" value="main"
      onPick={() => {}} options={[{ value: 'main', label: 'main' }, { value: 'feature/search', label: 'feature/search' }]}
      searchPlaceholder="Search branches…" />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Base branch' }))
    const search = await screen.findByRole('searchbox')
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.change(search, { target: { value: 'feature' } })
    const option = screen.getByRole('menuitemradio', { name: 'feature/search' })
    fireEvent.pointerMove(option, { pointerType: 'mouse' })
    expect(document.activeElement).toBe(search)
    fireEvent.pointerLeave(option, { pointerType: 'mouse' })
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(option)
    fireEvent.keyDown(option, { key: 'ArrowUp' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.change(search, { target: { value: 'main' } })
    expect(screen.getAllByRole('menuitemradio').map(el => el.textContent)).toEqual(['main'])
  })

  it.each([['ArrowDown', 'feature/search'], ['ArrowUp', 'feature/second']])('uses %s to enter filtered options for keyboard selection', async (key, selected) => {
    const onPick = vi.fn()
    render(
      <PickerPill
        slot="branch-pill"
        ariaLabel="Base branch"
        label="main"
        value="main"
        onPick={onPick}
        options={[
          { value: 'main', label: 'main' },
          { value: 'feature/search', label: 'feature/search' },
          { value: 'feature/second', label: 'feature/second' },
        ]}
        searchPlaceholder="Search branches…"
      />,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Base branch' }))
    const search = await screen.findByRole('searchbox', { name: 'Search branches…' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.change(search, { target: { value: 'missing' } })
    fireEvent.keyDown(search, { key })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'feature' } })
    fireEvent.keyDown(search, { key })

    const option = screen.getByRole('menuitemradio', { name: selected })
    expect(document.activeElement).toBe(option)
    fireEvent.keyDown(option, { key: 'Enter' })
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(selected))
  })
})
