import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskLink } from './task-link'

function Where() { const location = useLocation(); return <output data-state={JSON.stringify(location.state)}>{location.pathname + location.search}</output> }

function renderAt(internal: boolean) {
  render(<MemoryRouter initialEntries={['/p/a/tasks/t']}>
    <TaskLink href="/p/a/tasks/t/report?artifact=x" internal={internal}>Report</TaskLink>
    <Routes><Route path="*" element={<Where />} /></Routes>
  </MemoryRouter>)
}

describe('TaskLink', () => {
  afterEach(cleanup)

  it('navigates inside the app for a resolved link, so Back keeps the source view mounted', () => {
    renderAt(true)
    expect(fireEvent.click(screen.getByRole('link', { name: 'Report' }))).toBe(false)
    expect(document.querySelector('output')!.textContent).toBe('/p/a/tasks/t/report?artifact=x')
    expect(JSON.parse(document.querySelector('output')!.dataset.state!)).toEqual({ readerFrom: '/p/a/tasks/t', filesRestoreKey: expect.any(String) })
  })

  it('leaves modified clicks to the browser (new tab, new window)', () => {
    renderAt(true)
    expect(fireEvent.click(screen.getByRole('link', { name: 'Report' }), { ctrlKey: true })).toBe(true)
    expect(document.querySelector('output')!.textContent).toBe('/p/a/tasks/t')
  })

  it('keeps the confirmation for a link it did not resolve', () => {
    renderAt(false)
    fireEvent.click(screen.getByRole('link', { name: 'Report' }))
    expect(document.querySelector('output')!.textContent).toBe('/p/a/tasks/t')
    expect(document.querySelector('[data-slot="link-safety-dialog"]')).not.toBeNull()
  })

  it('renders a plain link outside a router', () => {
    render(<TaskLink href="/p/a/tasks/t/report?artifact=x" internal>Report</TaskLink>)
    expect(screen.getByRole('link', { name: 'Report' }).getAttribute('href')).toBe('/p/a/tasks/t/report?artifact=x')
  })
})
