import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ComponentProps } from 'react'

import { Button } from './button'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

describe('Button', () => {
  it('styles each variant and each size apart, without restating the class map', () => {
    const classOf = (props: ComponentProps<typeof Button>) => {
      const { unmount } = render(<Button {...props}>Label</Button>)
      const className = screen.getByRole('button').className
      unmount()
      return className
    }
    const variants = (['primary', 'contrast', 'outline', 'ghost', 'danger-ghost'] as const).map((variant) => classOf({ variant }))
    const sizes = (['default', 'sm', 'icon', 'icon-sm'] as const).map((size) => classOf({ size }))
    expect(new Set(variants).size).toBe(variants.length)
    expect(new Set(sizes).size).toBe(sizes.length)
    expect(classOf({})).toBe(classOf({ variant: 'primary', size: 'default' }))
  })

  it('lets a caller className override a variant class', () => {
    render(<Button className="bg-muted">Label</Button>)
    const button = screen.getByRole('button')

    expect(button.className).toContain('bg-muted')
    expect(button.className).not.toContain('bg-action')
  })

  it('renders the child element instead of a button when asChild is set', () => {
    render(
      <Button asChild variant="contrast">
        <a href="/tasks">Tasks</a>
      </Button>
    )

    const link = screen.getByRole('link', { name: 'Tasks' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/tasks')
    expect(link.className).toContain('bg-contrast')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('is inert while disabled', () => {
    render(<Button disabled>Label</Button>)
    const button = screen.getByRole('button')

    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.className).toContain('disabled:opacity-50')
  })
})
