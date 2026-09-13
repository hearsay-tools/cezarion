import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command, CommandInput, CommandItem, CommandList } from './command'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function pointer(target: Element, type: string, pointerType: string) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  fireEvent(target, event)
  return event
}
function Picker({ label, onOpenAutoFocus }: { label: string; onOpenAutoFocus?: (event: Event) => void }) {
  return <Popover>
    <PopoverTrigger asChild><button>{label}</button></PopoverTrigger>
    <PopoverContent onOpenAutoFocus={onOpenAutoFocus}>
      <Command><CommandInput placeholder={`Search ${label}`} />
        <CommandList><CommandItem value="first">First</CommandItem><CommandItem value="last">Last</CommandItem></CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}

describe('searchable popovers share touch focus behavior', () => {
  it('opens a searchable dropdown for touch browsing without focusing search', async () => {
    const label = 'workflows'
    render(<Picker label={label} />)
    const trigger = screen.getByRole('button', { name: label })
    pointer(trigger, 'pointerdown', 'touch')
    fireEvent.click(trigger)
    const input = await screen.findByPlaceholderText(`Search ${label}`)
    expect(document.activeElement).toBe(input.closest('[data-slot="popover-content"]'))
    act(() => input.focus())
    fireEvent.change(input, { target: { value: 'Last' } })
    expect(screen.queryByText('First')).toBeNull()
    expect(screen.getByText('Last')).toBeTruthy()
  })

  it('suppresses touch hover refocus in every command list, while mouse hover still selects', () => {
    render(<Command><CommandInput placeholder="Search" /><CommandList>
      <CommandItem value="first">First</CommandItem><CommandItem value="last">Last</CommandItem>
    </CommandList></Command>)
    const input = screen.getByPlaceholderText('Search')
    act(() => input.focus())
    const focus = vi.spyOn(input, 'focus')
    try {
      const last = screen.getByText('Last')
      expect(pointer(last, 'pointermove', 'touch').defaultPrevented).toBe(false)
      expect(focus).not.toHaveBeenCalled()
      expect(last.getAttribute('aria-selected')).toBe('false')
      pointer(last, 'pointermove', 'mouse')
      expect(last.getAttribute('aria-selected')).toBe('true')
    } finally { focus.mockRestore() }
  })

  it('preserves caller autofocus overrides', async () => {
    const onOpenAutoFocus = vi.fn((event: Event) => event.preventDefault())
    render(<Picker label="override" onOpenAutoFocus={onOpenAutoFocus} />)
    const trigger = screen.getByRole('button', { name: 'override' })
    act(() => trigger.focus())
    pointer(trigger, 'pointerdown', 'touch')
    fireEvent.click(trigger)
    await screen.findByPlaceholderText('Search override')
    expect(onOpenAutoFocus).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(trigger)
  })

  it('still autofocuses a non-search popover opened by touch', async () => {
    render(<Popover><PopoverTrigger asChild><button>Open</button></PopoverTrigger>
      <PopoverContent><button>Action</button></PopoverContent></Popover>)
    const trigger = screen.getByText('Open')
    pointer(trigger, 'pointerdown', 'touch')
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(await screen.findByText('Action'))
  })
})
