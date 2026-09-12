import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DesignIcon, GithubIcon, ListTodoIcon } from './design-icons'
import geometry from './design-icons/geometry.json'

describe('approved design icons', () => {
  it('renders every exported glyph as filled currentColor geometry', () => {
    for (const name of Object.keys(geometry) as (keyof typeof geometry)[]) {
      const { container, unmount } = render(<DesignIcon name={name} />)
      const svg = container.querySelector('svg')!
      expect(svg.getAttribute('viewBox')).toBe(geometry[name].viewBox)
      expect(svg.getAttribute('fill')).toBe('currentColor')
      expect(svg.getAttribute('stroke')).toBe('none')
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect([...svg.querySelectorAll('path')].map(p => p.getAttribute('d'))).toEqual(geometry[name].paths.map(p => p.d))
      unmount()
    }
  })
  it('supports accessible names and ordinary sizing props', () => {
    render(<GithubIcon aria-label="GitHub" size={18} className="text-accent" />)
    expect(screen.getByRole('img', { name: 'GitHub' }).getAttribute('width')).toBe('18')
    expect(screen.getByRole('img', { name: 'GitHub' }).hasAttribute('aria-hidden')).toBe(false)
  })
  it('exports semantic components with the exact source identity', () => {
    const { container } = render(<ListTodoIcon />)
    expect(container.querySelector('svg')?.getAttribute('data-design-icon')).toBe('list-todo')
  })
})
