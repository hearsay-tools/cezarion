import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ACTION_TOAST_MS, Toaster, resetToasts, toast } from './toaster'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.useRealTimers()
})

describe('Toaster', () => {
  it('renders nothing while the queue is empty', () => {
    render(<Toaster />)
    expect(document.querySelector('[data-slot="toaster"]')).toBeNull()
  })

  it('shows a toast() message as a status live region and auto-dismisses it', () => {
    render(<Toaster />)
    act(() => toast('Command copied to clipboard.'))

    const item = screen.getByRole('status')
    expect(item.textContent).toBe('Command copied to clipboard.')
    expect(item.getAttribute('data-tone')).toBe('default')

    // The lifetime timer only marks the toast as exiting — it stays mounted so the exit
    // animation has something to animate.
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')

    // …and the second timer is what actually removes it.
    act(() => vi.advanceTimersByTime(200))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it('anchors the stack to the top-right corner, not the bottom centre', () => {
    render(<Toaster />)
    act(() => toast('anchored'))

    const stack = document.querySelector('[data-slot="toaster"]')!
    const className = stack.className
    expect(className).toContain('fixed')
    expect(className).toContain('md:top-[calc(16px+env(safe-area-inset-top))]')
    expect(className).toContain('right-[calc(16px+env(safe-area-inset-right))]')
    expect(className).toContain('items-end')
    // Below `md` the app shell renders its own 56px header whose right end holds the run
    // status dot and kebab; anchoring at 16px there would cover the very controls #818 is
    // about. The pair must stay a pair.
    expect(className).toContain('top-[calc(66px+env(safe-area-inset-top))]')
    // The bottom-centre anchor this replaced must not linger — it is what put the toast on
    // top of the thread's action row (#818).
    expect(className).not.toContain('items-center')
    expect(className).not.toContain('bottom-')
    expect(className).not.toContain('inset-x-0')
  })

  it('animates in on open and out on close, only when motion is allowed', () => {
    render(<Toaster />)
    act(() => toast('animated'))

    const item = screen.getByRole('status')
    expect(item.getAttribute('data-state')).toBe('open')
    expect(item.className).toContain('motion-safe:animate-in')
    expect(item.className).toContain('motion-safe:slide-in-from-right-4')
    expect(item.className).toContain('motion-safe:data-[state=closed]:animate-out')
    expect(item.className).toContain('motion-safe:data-[state=closed]:slide-out-to-right-4')
    // The animation duration and the store's EXIT_MS (200ms) remove the node together. Raise
    // one without the other and the slide-out is unmounted mid-flight, so pin the class here:
    // a failure points the editor straight at EXIT_MS in toaster.tsx.
    expect(item.className).toContain('motion-safe:duration-200')

    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
  })

  it('stacks multiple toasts and dismisses each on its own clock', () => {
    render(<Toaster />)
    act(() => toast('first'))
    act(() => vi.advanceTimersByTime(2000))
    act(() => toast('second', { tone: 'danger' }))

    const toasts = screen.getAllByRole('status')
    expect(toasts.map((t) => t.textContent)).toEqual(['first', 'second'])
    expect(toasts[1]!.getAttribute('data-tone')).toBe('danger')

    // 3s later the first (5s old) starts exiting while the second (3s old) is untouched.
    act(() => vi.advanceTimersByTime(3000))
    expect(
      screen.getAllByRole('status').map((t) => [t.textContent, t.getAttribute('data-state')]),
    ).toEqual([
      ['first', 'closed'],
      ['second', 'open'],
    ])

    // The first one's exit timer removes only itself; the second keeps its own clock running.
    act(() => vi.advanceTimersByTime(200))
    expect(screen.getAllByRole('status').map((t) => t.textContent)).toEqual(['second'])

    // The second reaches its own 5s at t=7000 and then leaves the same way.
    act(() => vi.advanceTimersByTime(1800))
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
    act(() => vi.advanceTimersByTime(200))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it('renders no button and keeps the 5s lifetime without an action', () => {
    render(<Toaster />)
    act(() => toast('plain'))
    expect(document.querySelector('[data-slot="toast-action"]')).toBeNull()
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
    act(() => vi.advanceTimersByTime(200))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it('does not pause a plain toast on hover', () => {
    render(<Toaster />)
    act(() => toast('plain'))
    act(() => vi.advanceTimersByTime(3000))
    fireEvent.pointerEnter(screen.getByRole('status'))
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
  })

  describe('with an action', () => {
    const show = (onAction = vi.fn()) => {
      render(<Toaster />)
      act(() => toast('Archived "X"', { action: { label: 'Undo', onAction } }))
      return onAction
    }

    it('lives 8s', () => {
      show()
      expect(ACTION_TOAST_MS).toBe(8000)
      act(() => vi.advanceTimersByTime(7999))
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('open')
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
    })

    it('renders a real, tabbable button in the toast colour', () => {
      show()
      const button = document.querySelector<HTMLButtonElement>('[data-slot="toast-action"]')!
      expect(button.tagName).toBe('BUTTON')
      expect(button.getAttribute('type')).toBe('button')
      expect(button.tabIndex).toBe(0)
      expect(button.textContent).toBe('Undo')
      expect(button.className).toContain('font-semibold')
      expect(button.className).toContain('underline')
      expect(button.className).toContain('text-inherit')
    })

    it('pauses while hovered and resumes with the remaining time', () => {
      show()
      const toastEl = screen.getByRole('status')
      act(() => vi.advanceTimersByTime(3000))
      fireEvent.pointerEnter(toastEl)
      act(() => vi.advanceTimersByTime(17000))
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('open')
      fireEvent.pointerLeave(toastEl)
      act(() => vi.advanceTimersByTime(4999))
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('open')
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
    })

    it('pauses while the button holds focus', () => {
      show()
      const button = document.querySelector<HTMLButtonElement>('[data-slot="toast-action"]')!
      act(() => vi.advanceTimersByTime(3000))
      fireEvent.focusIn(button)
      act(() => vi.advanceTimersByTime(17000))
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('open')
      fireEvent.focusOut(button)
      act(() => vi.advanceTimersByTime(4999))
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('open')
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
    })

    it('stays paused while focus remains after the pointer leaves', () => {
      show()
      const toastEl = screen.getByRole('status')
      const button = document.querySelector<HTMLButtonElement>('[data-slot="toast-action"]')!
      fireEvent.pointerEnter(toastEl)
      fireEvent.focusIn(button)
      fireEvent.pointerLeave(toastEl)
      act(() => vi.advanceTimersByTime(20000))
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('open')
    })

    it('runs onAction once and starts the exit at once on click', () => {
      const onAction = show()
      fireEvent.click(document.querySelector('[data-slot="toast-action"]')!)
      expect(onAction).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
      act(() => vi.advanceTimersByTime(200))
      expect(document.querySelector('[data-slot="toast"]')).toBeNull()
    })

    it('ignores a second click and still dismisses when onAction throws', () => {
      const onAction = vi.fn(() => {
        throw new Error('boom')
      })
      show(onAction)
      const swallow = (e: ErrorEvent) => e.preventDefault()
      window.addEventListener('error', swallow)
      const button = document.querySelector('[data-slot="toast-action"]')!
      try {
        fireEvent.click(button)
      } catch {
        // React rethrows handler errors; the toast must be dismissed regardless.
      }
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('closed')
      try {
        fireEvent.click(button)
      } catch {
        // ignored
      }
      window.removeEventListener('error', swallow)
      expect(onAction).toHaveBeenCalledTimes(1)
    })

    it('returns focus to where it came from when the clicked button held it', () => {
      const trigger = document.createElement('button')
      document.body.appendChild(trigger)
      trigger.focus()
      show()
      const button = document.querySelector<HTMLButtonElement>('[data-slot="toast-action"]')!
      fireEvent.focusIn(button, { relatedTarget: trigger })
      button.focus()
      expect(document.activeElement).toBe(button)
      fireEvent.click(button)
      expect(document.activeElement).toBe(trigger)
      trigger.remove()
    })

    it('never moves focus into the toast, and skips a disconnected origin', () => {
      const trigger = document.createElement('button')
      document.body.appendChild(trigger)
      show()
      expect(document.activeElement).not.toBe(document.querySelector('[data-slot="toast-action"]'))
      const button = document.querySelector<HTMLButtonElement>('[data-slot="toast-action"]')!
      fireEvent.focusIn(button, { relatedTarget: trigger })
      trigger.remove()
      button.focus()
      fireEvent.click(button)
      act(() => vi.advanceTimersByTime(200))
      expect(document.activeElement).toBe(document.body)
    })

    it('has a focus-visible ring on the action button', () => {
      show()
      const cls = document.querySelector('[data-slot="toast-action"]')!.className
      expect(cls).toContain('focus-visible:outline-2')
      expect(cls).toContain('focus-visible:outline-offset-2')
      expect(cls).toContain('focus-visible:outline-current')
      expect(cls).toContain('outline-none')
    })

    it('resetToasts clears paused timers', () => {
      show()
      fireEvent.pointerEnter(screen.getByRole('status'))
      act(() => resetToasts())
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
